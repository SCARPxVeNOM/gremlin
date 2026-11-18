import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';
import { Command } from 'commander';
import { initCommand } from './commands/init.ts';
import { getAgent, detectAgents } from './core/agent.ts';
import type { AttackCategory } from './core/attacks.ts';
import { runBreaker } from './core/breaker.ts';
import { commentOnIssue, readGithubIssue, runCapture, type BugReportInput } from './core/capture.ts';
import { loadProject, type Project } from './core/config.ts';
import { runFixer, verifyBug } from './core/fixer.ts';
import { getFlow, lintFlow, listFlows, saveFlow, updateFlowMeta, type FlowType } from './core/flow.ts';
import { guardBrief, guardMarkdown, runGuard } from './core/guard.ts';
import { GuardrailError } from './core/guardrails.ts';
import { installCi, installClaudeHooks, installMcp, installRules } from './core/integrations.ts';
import { kaneStatus } from './core/kane.ts';
import { describeRun, runFlow } from './core/runner.ts';
import { getBug, getRun, listBugs, lockFlow, readLock, unlockFlow } from './core/store.ts';
import { flowViews, summarize, weeklyMarkdown } from './core/summary.ts';
import { ensureApp, isReachable } from './core/target.ts';
import { startJob, endJob } from './core/jobs.ts';
import { banner, bugLine, consoleReporter, g, runMark, sevColor, statusColor, table } from './ui.ts';

const VERSION = '0.1.0';
const program = new Command();

program
  .name('gremlin')
  .description('A drop-in QA loop: a hostile user, bug reports that become tests, your own agent as the fixer, Kane CLI as the referee.')
  .version(VERSION);

function project(): Project {
  return loadProject(process.cwd());
}

async function main(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GuardrailError) {
      console.error(g.bad(`⛔ ${err.message}`));
      process.exit(2);
    }
    console.error(g.bad(`✗ ${(err as Error).message}`));
    if (process.env.GREMLIN_DEBUG) console.error(err);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Set Gremlin up in this project: config, flow library, agent connector, starter flows')
  .option('-y, --yes', 'accept defaults, no questions')
  .option('--url <url>', 'where the app runs')
  .option('--start <command>', 'how to start the app')
  .option('--agent <name>', 'claude-code | codex | cursor | gemini | custom | none')
  .option('--platforms <list>', 'web,ios,android')
  .option('--persona <name>', 'name of a test persona')
  .option('--name <name>', 'app name')
  .option('--no-ci', 'skip the GitHub Action')
  .option('--no-flows', 'skip starter flows')
  .option('--no-run', "don't run the starter flows")
  .option('--force', 'overwrite an existing config')
  .action((opts) => main(() => initCommand(opts)));

program
  .command('doctor')
  .description('Check Kane CLI, your coding agent, the app and the config')
  .action(() =>
    main(async () => {
      banner('doctor');
      const k = kaneStatus();
      const line = (ok: boolean, msg: string, hint?: string) => console.log(`${ok ? g.ok('✓') : g.bad('✗')} ${msg}${!ok && hint ? g.dim(`  → ${hint}`) : ''}`);
      line(k.installed, `Kane CLI ${k.version ?? ''}`, 'npm install -g @testmuai/kane-cli');
      line(k.authenticated, `Kane signed in${k.user ? ` as ${k.user}` : ''}${k.credits !== undefined ? ` · ${k.credits} credits` : ''}`, 'kane-cli login');
      const pr = project();
      const agent = getAgent(pr.config);
      line(Boolean(agent?.available()), `Coding agent: ${agent?.label ?? 'none'}`, `installed agents: ${detectAgents().join(', ') || 'none'}`);
      const up = await isReachable(pr.config.app.url);
      line(up || Boolean(pr.config.app.start), `App ${pr.config.app.url} ${up ? 'is up' : pr.config.app.start ? `is down (Gremlin will run \`${pr.config.app.start}\`)` : 'is down'}`, 'start it or set app.start');
      const flows = listFlows(pr.paths);
      line(flows.length > 0, `${flows.length} flows (${flows.filter((f) => f.status === 'active').length} active)`, 'gremlin init or gremlin flows new');
      for (const f of flows) for (const i of lintFlow(f)) console.log(`  ${i.level === 'error' ? g.bad('!') : g.warn('·')} ${f.id}: ${i.message}`);
    }),
  );

// ---------------------------------------------------------------------------
// Running

program
  .command('run [flows...]')
  .description('Run flows through Kane CLI now (by id, slug, or --tag / --all)')
  .option('--tag <tags>', 'comma-separated tags')
  .option('--all', 'every active flow')
  .option('--include-drafts', 'also run draft flows')
  .option('--no-retry', "don't re-run failures to rule out flakiness")
  .option('-v, --verbose', "show every action Kane takes")
  .action((ids: string[], opts) =>
    main(async () => {
      const pr = project();
      banner('run');
      let flows = listFlows(pr.paths);
      if (ids.length) flows = ids.map((id) => getFlow(pr.paths, id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
      else if (opts.tag) {
        const tags = String(opts.tag).split(',');
        flows = flows.filter((f) => f.tags.some((t) => tags.includes(t)));
      } else if (!opts.all && !opts.includeDrafts) throw new Error('Name flows to run, or use --tag / --all.');
      if (!ids.length) flows = flows.filter((f) => f.status === 'active' || (opts.includeDrafts && f.status === 'draft'));
      if (!flows.length) throw new Error('No matching flows.');
      const job = startJob(pr.paths, 'run', `Run ${flows.length} flow${flows.length === 1 ? '' : 's'}`);
      const app = await ensureApp(pr, (m) => console.log(g.dim(m)));
      let failed = 0;
      try {
        for (const f of flows) {
          console.log(`▶ ${g.bold(f.title)} ${g.dim(f.id)}`);
          const run = await runFlow(pr, f, { purpose: 'manual', job: job.id, reporter: consoleReporter({ verbose: opts.verbose }), retry: opts.retry });
          console.log(`  ${runMark(run)} ${describeRun(run)}\n`);
          if (run.status === 'passed' && f.status === 'draft' && f.type === 'happy') {
            lockFlow(pr.paths, updateFlowMeta(f, { status: 'active' }), 'first pass');
            console.log(g.dim('  promoted to active: Guard will replay it from now on\n'));
          }
          if (run.status === 'failed' || run.status === 'error') failed++;
        }
      } finally {
        app.stop();
      }
      endJob(pr.paths, job, failed ? 'failed' : 'passed', `${flows.length - failed} of ${flows.length} passed`);
      process.exitCode = failed ? 1 : 0;
    }),
  );

program
  .command('break')
  .description('Breaker: attack the app like a hostile user and report bugs Kane confirms')
  .option('--area <areas>', 'only attack these areas (comma-separated)')
  .option('--category <categories>', 'input,timing,navigation,state,accessibility')
  .option('--max <n>', 'maximum attacks this hunt', (v) => parseInt(v, 10))
  .option('--no-agent', "don't ask the coding agent for product-specific attacks")
  .option('--dry-run', 'plan attacks without running them')
  .option('-v, --verbose', 'show every action Kane takes')
  .action((opts) =>
    main(async () => {
      const pr = project();
      banner('breaker');
      const r = await runBreaker(pr, {
        areas: opts.area?.split(','),
        categories: opts.category?.split(',') as AttackCategory[] | undefined,
        max: opts.max,
        useAgent: opts.agent,
        dryRun: opts.dryRun,
        reporter: consoleReporter({ verbose: opts.verbose }),
      });
      if (opts.dryRun) {
        console.log(`\n${g.bold('Planned attacks')}`);
        r.planned.forEach((a, i) => console.log(`${String(i + 1).padStart(2)}. ${a.title} ${g.dim(`${a.attack} · ${a.origin} · score ${a.score.toFixed(2)}`)}`));
        return;
      }
      const bugs = r.findings.filter((f) => f.outcome === 'bug');
      console.log(`\n${g.bold(`${bugs.length} bug${bugs.length === 1 ? '' : 's'}`)} from ${r.findings.length} attacks · ${Math.round(r.credits)} credits`);
      if (bugs.length) table(bugs.map((f) => bugLine(f.bug!)), ['id', 'severity', 'status', 'conf', 'origin', 'title']);
      const held = r.findings.filter((f) => f.outcome === 'held').length;
      if (held) console.log(g.dim(`${held} attack${held === 1 ? '' : 's'} held: saved as adversarial guards.`));
      if (r.reportPath) console.log(g.dim(`Report: ${relative(pr.root, r.reportPath)}`));
      if (bugs.length) console.log(`\nFix one: ${g.info(`gremlin fix ${bugs[0].bug!.id}`)}`);
    }),
  );

program
  .command('capture [report...]')
  .description('Capture: turn a bug report into a repro flow; Kane must fail it before it counts')
  .option('--issue <number>', 'read a GitHub issue with gh')
  .option('--file <path>', 'read the report from a file')
  .option('--comment', 'post the result back on the GitHub issue')
  .action((words: string[], opts) =>
    main(async () => {
      const pr = project();
      banner('capture');
      let input: BugReportInput;
      if (opts.issue) input = readGithubIssue(String(opts.issue), pr.root);
      else if (opts.file) input = { text: readFileSync(opts.file, 'utf8'), source: 'file', ref: opts.file };
      else if (words.length) input = { text: words.join(' '), source: 'paste' };
      else if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        input = { text: Buffer.concat(chunks).toString('utf8'), source: 'paste' };
      } else {
        const t = await p.text({ message: 'Paste the bug report', placeholder: 'What the user said…' });
        if (p.isCancel(t) || !t) return;
        input = { text: t, source: 'paste' };
      }
      const r = await runCapture(pr, input, { reporter: consoleReporter() });
      const head = r.outcome === 'confirmed' ? g.bad('● Reproduced') : r.outcome === 'cant-reproduce' ? g.ok("○ Can't reproduce") : g.warn(`● ${r.outcome}`);
      console.log(`\n${head}  ${r.message}`);
      if (r.questions.length) r.questions.forEach((q) => console.log(`  ? ${q}`));
      if (r.bug && r.outcome === 'confirmed') console.log(`\nFix it: ${g.info(`gremlin fix ${r.bug.id}`)}`);
      if (opts.comment && input.ref?.startsWith('#')) {
        console.log(commentOnIssue(pr, r, input.ref) ? g.dim(`Commented on ${input.ref}`) : g.warn(`Couldn't comment on ${input.ref}`));
      }
    }),
  );

program
  .command('fix <bug>')
  .description("Fixer: hand a bug and Kane's evidence to your coding agent, then prove the fix with Kane")
  .option('--mode <mode>', 'suggest | approve | autonomous')
  .option('--attempts <n>', 'attempts before escalating to a human', (v) => parseInt(v, 10))
  .option('-y, --yes', "don't ask before handing the bug to the agent")
  .option('--no-related', 'skip replaying related flows after the fix passes')
  .action((bugId: string, opts) =>
    main(async () => {
      const pr = project();
      banner('fixer');
      const bug = getBug(pr.paths, bugId);
      if (!bug) throw new Error(`No bug ${bugId}.`);
      console.log(`${g.bold(bug.id)} ${sevColor(bug.severity)} ${bug.title}`);
      if (bug.failingStep) console.log(g.dim(`  failing step: ${bug.failingStep}`));
      if (bug.reason) console.log(g.dim(`  Kane: ${bug.reason}`));
      const r = await runFixer(pr, bug.id, {
        mode: opts.mode,
        attempts: opts.attempts,
        related: opts.related,
        reporter: consoleReporter(),
        confirm: opts.yes || !process.stdin.isTTY ? undefined : async (q) => !p.isCancel(await p.confirm({ message: q })) && true,
      });
      const color = r.outcome === 'fixed' ? g.ok : r.outcome === 'escalated' ? g.bad : g.warn;
      console.log(`\n${color(r.outcome === 'fixed' ? '✓ Fixed' : r.outcome)}  ${r.message}`);
      process.exitCode = r.outcome === 'fixed' || r.outcome === 'suggested' ? 0 : 1;
    }),
  );

program
  .command('verify <bug>')
  .description("Re-run a bug's flow with Kane after a fix made outside Gremlin")
  .action((bugId: string) =>
    main(async () => {
      const pr = project();
      banner('verify');
      const { bug, run } = await verifyBug(pr, bugId, consoleReporter());
      console.log(`\n${runMark(run)} ${bug.id}: ${describeRun(run)}${bug.status === 'fixed' ? g.ok('  → fixed, saved as a regression flow') : ''}`);
      process.exitCode = run.status === 'passed' ? 0 : 1;
    }),
  );

program
  .command('guard')
  .description('Guard: replay the flows your changes touch; exit 1 if any fail')
  .option('--all', 'replay every active flow')
  .option('--base <ref>', 'compare against this git ref (e.g. origin/main)')
  .option('--tag <tags>', 'only flows with these tags')
  .option('--ci', 'write a PR comment and a GitHub step summary')
  .option('--json', 'print a JSON report')
  .option('--brief', 'print the failure brief for a coding agent')
  .action((opts) =>
    main(async () => {
      const pr = project();
      if (!opts.json && !opts.brief) banner('guard');
      const quiet = opts.json || opts.brief;
      const report = await runGuard(pr, {
        all: opts.all,
        base: opts.base,
        tags: opts.tag?.split(','),
        reporter: quiet ? undefined : consoleReporter(),
      });
      if (opts.ci) {
        const md = guardMarkdown(pr, report);
        writeFileSync(join(pr.paths.dir, 'guard-comment.md'), md);
        if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              blocking: report.blocking,
              reason: report.reason,
              credits: report.credits,
              results: report.results.map((r) => ({ flow: r.flow.id, status: r.status, run: r.run?.id, bug: r.bug?.id, regression: r.regression, reason: r.run?.kane?.reason })),
            },
            null,
            2,
          ),
        );
      } else if (opts.brief) {
        console.log(guardBrief(pr, report));
      } else {
        console.log(`\n${report.blocking ? g.bad('✗ Blocked') : g.ok('✓ Clear')}  ${report.results.length} flows · ${report.reason} · ${report.credits} credits`);
        if (report.blocking) console.log(g.dim('Run `gremlin guard --brief` for the evidence an agent needs, or `gremlin fix <BUG>`.'));
      }
      process.exitCode = report.blocking ? 1 : 0;
    }),
  );

// ---------------------------------------------------------------------------
// Library

const flows = program.command('flows').description('The flow library');

flows
  .command('list', { isDefault: true })
  .option('--type <type>', 'happy | adversarial | regression')
  .action((opts) =>
    main(async () => {
      const pr = project();
      const views = flowViews(pr).filter((f) => !opts.type || f.type === opts.type);
      if (!views.length) return console.log('No flows yet. Run `gremlin init`, `gremlin break` or `gremlin flows new`.');
      table(
        views.map((f) => [
          f.id,
          statusColor(f.status),
          f.last ? statusColor(f.last) : g.dim('never run'),
          f.stability === null ? g.dim('–') : `${f.stability}%`,
          f.tampered ? g.bad('EDITED') : f.locked ? g.dim('locked') : '',
          f.title,
        ]),
        ['flow', 'status', 'last', 'stable', 'lock', 'title'],
      );
    }),
  );

flows
  .command('show <id>')
  .action((id: string) =>
    main(async () => {
      const pr = project();
      const f = getFlow(pr.paths, id);
      if (!f) throw new Error(`No flow ${id}`);
      console.log(readFileSync(f.path, 'utf8'));
      for (const i of lintFlow(f)) console.log(`${i.level === 'error' ? g.bad('!') : g.warn('·')} ${i.message}`);
    }),
  );

flows
  .command('new')
  .description('Write a flow by hand (as a human)')
  .action(() =>
    main(async () => {
      const pr = project();
      const title = await p.text({ message: 'What does the flow prove?', placeholder: 'A shopper can apply a coupon at checkout' });
      if (p.isCancel(title)) return;
      const type = (await p.select({
        message: 'Type',
        options: [
          { value: 'happy', label: 'Happy path' },
          { value: 'adversarial', label: 'Adversarial' },
          { value: 'regression', label: 'Regression' },
        ],
      })) as FlowType;
      const start = (await p.text({ message: 'Starting page', initialValue: '/' })) as string;
      const steps = String(await p.text({ message: 'Steps, separated by ";"', placeholder: 'Add a mug to the cart; Go to checkout; Enter coupon WELCOME10' }))
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      const expect = String(await p.text({ message: 'Expectations, separated by ";"', placeholder: 'The total drops by 10%; No error is shown' }))
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      const tags = String((await p.text({ message: 'Tags (comma-separated)', initialValue: '' })) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const f = saveFlow(pr.paths, { title, type, start, steps, expect, tags, source: 'human', status: 'draft' });
      for (const i of lintFlow(f)) console.log(`${i.level === 'error' ? g.bad('!') : g.warn('·')} ${i.message}`);
      console.log(`Saved ${f.id}. Run it with \`gremlin run ${f.id}\`, then \`gremlin flows approve ${f.id}\`.`);
    }),
  );

flows
  .command('approve <id>')
  .description('Human approval: activate a flow and lock its current content')
  .action((id: string) =>
    main(async () => {
      const pr = project();
      const f = getFlow(pr.paths, id);
      if (!f) throw new Error(`No flow ${id}`);
      const issues = lintFlow(f).filter((i) => i.level === 'error');
      if (issues.length) throw new Error(issues.map((i) => i.message).join(' '));
      const prev = readLock(pr.paths).flows[f.id];
      const next = updateFlowMeta(f, { status: 'active' });
      lockFlow(pr.paths, next, process.env.USER ?? 'human');
      console.log(`${g.ok('✓')} ${f.id} is active${prev && prev.hash !== f.hash ? ' (re-locked after a human edit)' : ''}.`);
    }),
  );

flows
  .command('retire <id>')
  .description('Human decision: retire a flow (the library only shrinks this way)')
  .action((id: string) =>
    main(async () => {
      const pr = project();
      const f = getFlow(pr.paths, id);
      if (!f) throw new Error(`No flow ${id}`);
      updateFlowMeta(f, { status: 'retired' });
      unlockFlow(pr.paths, f.id);
      console.log(`${f.id} retired.`);
    }),
  );

program
  .command('bugs [id]')
  .description('List bugs, or show one with its evidence and fix attempts')
  .option('--all', 'include fixed, rejected and unreproducible')
  .action((id: string | undefined, opts) =>
    main(async () => {
      const pr = project();
      if (id) {
        const b = getBug(pr.paths, id);
        if (!b) throw new Error(`No bug ${id}`);
        console.log(`${g.bold(b.id)} ${sevColor(b.severity)} ${statusColor(b.status)}  ${b.title}`);
        console.log(g.dim(`origin ${b.origin}${b.attack ? ` · attack ${b.attack}` : ''} · confidence ${Math.round(b.confidence * 100)}% · ${b.credits} credits · flow ${b.flowId}`));
        if (b.report) console.log(`\nReport (${b.report.source}${b.report.ref ? ' ' + b.report.ref : ''}):\n${g.dim(b.report.text.slice(0, 600))}`);
        if (b.failingStep) console.log(`\nFailing step: ${b.failingStep}`);
        if (b.reason) console.log(`Kane: ${b.reason}`);
        const last = getRun(pr.paths, b.runs[b.runs.length - 1]);
        if (last?.evidence?.networkFailures.length) console.log(`Network: ${last.evidence.networkFailures.map((n) => `${n.method} ${n.url} → ${n.status}`).join(', ')}`);
        if (last?.evidence?.failure?.screenshot) console.log(`Screenshot: ${relative(pr.root, join(pr.paths.evidence, last.id, last.evidence.failure.screenshot))}`);
        for (const a of b.attempts) console.log(`  attempt ${a.n}: ${statusColor(a.result)} · ${a.changedFiles.join(', ') || 'no changes'}${a.blocked.length ? g.bad(` · reverted ${a.blocked.join(', ')}`) : ''}`);
        return;
      }
      const bugs = listBugs(pr.paths).filter((b) => opts.all || !['fixed', 'rejected', 'cant-reproduce'].includes(b.status));
      if (!bugs.length) return console.log(opts.all ? 'No bugs yet.' : 'No open bugs. (--all to include closed ones)');
      table(bugs.map(bugLine), ['id', 'severity', 'status', 'conf', 'origin', 'title']);
    }),
  );

program
  .command('report')
  .description('Weekly summary: bugs found and fixed, regressions caught, flaky flows, credits')
  .option('--out <file>', 'write the markdown to a file')
  .action((opts) =>
    main(async () => {
      const pr = project();
      const md = weeklyMarkdown(pr);
      if (opts.out) writeFileSync(opts.out, md + '\n');
      console.log(md);
      const s = summarize(pr);
      if (!opts.out) console.log(g.dim(`\n${s.credits.today} credits used today of ${s.credits.budget.per_day}`));
    }),
  );

// ---------------------------------------------------------------------------
// Surfaces

program
  .command('dash')
  .description('Open the local dashboard')
  .option('--port <port>', 'port', (v) => parseInt(v, 10), 4777)
  .option('--no-open', "don't open a browser")
  .action((opts) =>
    main(async () => {
      const pr = project();
      const { serveDashboard } = await import('./server/index.ts');
      await serveDashboard({
        port: opts.port,
        root: pr.root,
        onReady: (url) => {
          banner('dashboard');
          console.log(`  ${g.info(url)}  ${g.dim('(Ctrl-C to stop)')}`);
          if (opts.open) {
            const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
            spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
          }
        },
      });
    }),
  );

program
  .command('mcp')
  .description('Run the Gremlin MCP server on stdio (for Claude Code, Cursor, Windsurf, Kiro …)')
  .action(() =>
    main(async () => {
      const { startMcp } = await import('./mcp/server.ts');
      await startMcp();
    }),
  );

program
  .command('hook <agent> <event>')
  .description('Agent lifecycle hooks (installed by gremlin init): claude session-start | pre-tool-use | stop')
  .action((agent: string, event: string) =>
    main(async () => {
      if (agent !== 'claude') throw new Error(`No hooks for ${agent} yet; use the MCP server or rules file.`);
      const { runClaudeHook } = await import('./hooks/claude.ts');
      await runClaudeHook(event);
    }),
  );

program
  .command('install <target>')
  .description('Install a connector: claude | cursor | codex | gemini | ci')
  .action((target: string) =>
    main(async () => {
      const pr = project();
      const done = (items: { file: string; what: string }[]) => items.forEach((i) => console.log(`${g.ok('✓')} ${i.file}  ${g.dim(i.what)}`));
      if (target === 'claude') done([...installClaudeHooks(pr.root), installMcp(pr.root, '.mcp.json'), installRules(pr.root, 'CLAUDE.md')]);
      else if (target === 'cursor') done([installMcp(pr.root, '.cursor/mcp.json'), installRules(pr.root, '.cursor/rules/gremlin.mdc')]);
      else if (target === 'codex') done([installRules(pr.root, 'AGENTS.md')]);
      else if (target === 'gemini') done([installRules(pr.root, 'GEMINI.md')]);
      else if (target === 'ci') done([installCi(pr.root, { start: pr.config.app.start, url: pr.config.app.url })]);
      else throw new Error(`Unknown target ${target}`);
    }),
  );

program.parseAsync(process.argv);

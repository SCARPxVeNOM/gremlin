import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { detectAgents, CONNECTORS } from '../core/agent.ts';
import { runBreaker } from '../core/breaker.ts';
import { loadProject } from '../core/config.ts';
import { mapProduct, detectStack } from '../core/discover.ts';
import { listFlows, saveFlow, updateFlowMeta } from '../core/flow.ts';
import { agentHappyFlows, templateHappyFlows } from '../core/happy.ts';
import { installCi, installClaudeHooks, installMcp, installRules, type Installed } from '../core/integrations.ts';
import { kaneStatus } from '../core/kane.ts';
import { CONFIG_FILE, ensureDir, FLOW_TYPES, projectPaths } from '../core/paths.ts';
import { describeRun, runFlow } from '../core/runner.ts';
import { lockFlow } from '../core/store.ts';
import { ensureApp, isReachable } from '../core/target.ts';
import { banner, consoleReporter, g } from '../ui.ts';

export interface InitOptions {
  yes?: boolean;
  url?: string;
  start?: string;
  agent?: string;
  platforms?: string;
  persona?: string;
  name?: string;
  ci?: boolean;
  flows?: boolean;
  run?: boolean;
  force?: boolean;
}

function cancelIf<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return v as Exclude<T, symbol>;
}

export function configTemplate(o: {
  name: string;
  url: string;
  start?: string;
  platforms: string[];
  agent: string;
  persona?: { name: string; envPrefix: string };
  production: boolean;
}): string {
  const persona = o.persona
    ? `personas:
  ${o.persona.name}:
    description: A returning customer with a saved account
    email: \${${o.persona.envPrefix}_EMAIL}
    password: \${${o.persona.envPrefix}_PASSWORD}`
    : `personas: {}
  # shopper:
  #   description: A returning customer
  #   email: \${SHOPPER_EMAIL}
  #   password: \${SHOPPER_PASSWORD}`;
  return `# Gremlin: a hostile user, a perfect bug memory, your own agent as the fixer, Kane CLI as the referee.
# Docs: https://github.com/SCARPxVeNOM/gremlin

app:
  name: ${JSON.stringify(o.name)}
  url: ${o.url}
${o.start ? `  start: ${JSON.stringify(o.start)}        # Gremlin starts the app with this when it isn't running\n` : ''}  # reset: POST /__reset              # optional: reset test data before every run
  production: ${o.production}                  # Gremlin refuses to run against production

platforms: [${o.platforms.join(', ')}]

# Test accounts. Flows name a persona; secrets come from environment variables, never this file.
${persona}

agent:
  name: ${o.agent}                    # claude-code | codex | cursor | gemini | custom | none
  # command: "my-agent --task-file {prompt_file}"   # for custom

loop:
  mode: approve            # suggest | approve | autonomous
  attempts: 3              # fix attempts before Gremlin hands the bug to a human

guard:
  trigger: [agent-finish, pr]
  fallback: all            # what to replay when a change touches no mapped area
  areas: {}
    # checkout: ["src/app/checkout/**", "src/lib/cart*"]

breaker:
  scope: []                # areas to attack (empty = everything found)
  avoid: [admin]
  categories: [input, timing, navigation, state, accessibility]
  max_flows: 6

budget:                    # Kane credits
  per_run: 200
  per_day: 2000
  per_bug: 500

protected_paths: []        # files the Fixer may never change, e.g. ["src/payments/**", "migrations/**"]

kane:
  headless: true
  max_steps: 40
  bug_detection: continue
`;
}

const GITIGNORE = `# Gremlin: local run artifacts (flows, locks, bugs and Kane recordings are committed)
runs/
evidence/
reports/
events.jsonl
state.json
ledger.jsonl
stats.json
kane/.testmuai/
`;

export async function initCommand(opts: InitOptions) {
  const root = process.cwd();
  banner('setup');
  if (existsSync(join(root, CONFIG_FILE)) && !opts.force) {
    console.log(`${CONFIG_FILE} already exists here. Use --force to reconfigure.`);
    return;
  }
  const interactive = !opts.yes && process.stdin.isTTY;
  const stack = detectStack(root);
  const kane = kaneStatus();
  if (!kane.installed) {
    console.log(g.bad('Kane CLI is not installed. Gremlin needs it to run anything:'));
    console.log('  npm install -g @testmuai/kane-cli && kane-cli login\n');
  } else if (!kane.authenticated) {
    console.log(g.warn('Kane CLI is installed but not signed in. Run `kane-cli login` before your first run.\n'));
  } else {
    console.log(`${g.ok('✓')} Kane CLI ${kane.version} · signed in as ${kane.user ?? 'you'}${kane.credits !== undefined ? ` · ${kane.credits} credits` : ''}`);
  }
  if (stack.stack.length) console.log(`${g.ok('✓')} Detected ${stack.stack.join(', ')}`);
  const agents = detectAgents();

  // The four questions
  const defUrl = opts.url ?? `http://localhost:${stack.port ?? 3000}`;
  let url = defUrl;
  let start = opts.start ?? stack.startCommand;
  let platforms = opts.platforms?.split(',') ?? stack.platforms;
  let agent = opts.agent ?? agents[0] ?? 'none';
  let persona: { name: string; envPrefix: string } | undefined = opts.persona ? { name: opts.persona, envPrefix: opts.persona.toUpperCase().replace(/\W/g, '_') } : undefined;
  let ci = opts.ci ?? true;
  let name = opts.name ?? root.split('/').pop() ?? 'My app';

  if (interactive) {
    p.intro(g.bold('Four questions and you are set.'));
    url = cancelIf(await p.text({ message: '1. Where does the app run?', initialValue: defUrl, placeholder: defUrl }));
    start = cancelIf(
      await p.text({ message: '   How does Gremlin start it when it is down? (blank to skip)', initialValue: start ?? '', placeholder: 'npm run dev' }),
    ) || undefined;
    platforms = cancelIf(
      await p.multiselect({
        message: '2. Which platforms should Kane test?',
        options: [
          { value: 'web', label: 'Web', hint: 'real Chrome' },
          { value: 'ios', label: 'iOS', hint: 'simulator' },
          { value: 'android', label: 'Android', hint: 'emulator' },
        ],
        initialValues: platforms,
        required: true,
      }),
    ) as string[];
    const wantsPersona = cancelIf(await p.confirm({ message: '3. Does the app have a login that flows need?', initialValue: Boolean(persona) }));
    if (wantsPersona) {
      const pn = cancelIf(await p.text({ message: '   Name the test persona', initialValue: persona?.name ?? 'shopper' }));
      const chosen = { name: pn, envPrefix: pn.toUpperCase().replace(/\W/g, '_') };
      persona = chosen;
      p.note(`Set ${chosen.envPrefix}_EMAIL and ${chosen.envPrefix}_PASSWORD in your environment.\nGremlin passes them to Kane as secret variables; flows only ever say "${pn}".`, 'Secrets stay in env vars');
    }
    agent = cancelIf(
      await p.select({
        message: '4. Which coding agent fixes what breaks?',
        initialValue: agent,
        options: [
          ...Object.values(CONNECTORS).map((c) => ({ value: c.name, label: c.label, hint: agents.includes(c.name) ? 'installed' : 'not found' })),
          { value: 'custom', label: 'Custom command' },
          { value: 'none', label: 'None (suggest-only)' },
        ],
      }),
    ) as string;
    ci = cancelIf(await p.confirm({ message: 'Add a GitHub Action that runs Guard on pull requests?', initialValue: true }));
  }

  // Config + library
  const paths = projectPaths(root);
  const local = /localhost|127\.0\.0\.1|\.test\b|\.local\b/.test(url);
  writeFileSync(paths.config, configTemplate({ name, url, start, platforms, agent, persona, production: false }));
  for (const t of FLOW_TYPES) ensureDir(join(paths.flows, t));
  writeFileSync(join(paths.dir, '.gitignore'), GITIGNORE);
  console.log(`${g.ok('✓')} Wrote ${CONFIG_FILE} and .gremlin/flows/{happy,adversarial,regression}`);
  if (!local) console.log(g.warn(`  ${url} isn't local. Gremlin will only run against it because app.production is false; double-check that.`));

  // Connectors for the chosen agent
  const installed: Installed[] = [];
  if (agent === 'claude-code') {
    installed.push(...installClaudeHooks(root), installMcp(root, '.mcp.json'), installRules(root, 'CLAUDE.md'));
  } else if (agent === 'cursor') {
    installed.push(installMcp(root, '.cursor/mcp.json'), installRules(root, '.cursor/rules/gremlin.mdc'));
  } else if (agent === 'gemini') {
    installed.push(installRules(root, 'GEMINI.md'));
  } else if (agent !== 'none') {
    installed.push(installRules(root, 'AGENTS.md'));
  }
  if (ci) installed.push(installCi(root, { start, url }));
  for (const i of installed) console.log(`${g.ok('✓')} ${i.file}  ${g.dim(i.what)}`);

  const project = loadProject(root);
  if (opts.flows === false) return done();

  // Starter happy paths
  const reachable = await isReachable(url);
  let app = { stop() {}, startedByGremlin: false };
  if (!reachable && start) {
    try {
      app = await ensureApp(project, (m) => console.log(g.dim(m)));
    } catch (err) {
      console.log(g.warn((err as Error).message));
    }
  }
  try {
    const up = await isReachable(url);
    const spin = p.spinner();
    spin.start(`Mapping ${url}${agent !== 'none' ? ` and asking ${agent} for starter flows` : ''}`);
    const map = await mapProduct(root, url, up);
    let drafts = await agentHappyFlows(project, map, 4).catch(() => []);
    if (!drafts.length) drafts = templateHappyFlows(map, project, 4);
    spin.stop(`Drafted ${drafts.length} happy-path flows`);
    const flows = drafts.map((d) => saveFlow(paths, d));
    for (const f of flows) console.log(`  ${g.dim('•')} ${f.title}  ${g.dim(f.id)}`);

    const runNow =
      opts.run !== false &&
      up &&
      kane.authenticated &&
      (!interactive || cancelIf(await p.confirm({ message: `Run them once with Kane now? (about ${flows.length * 25} credits)`, initialValue: true })));
    if (runNow) {
      for (const f of flows) {
        console.log(`\n▶ ${f.title}`);
        const run = await runFlow(project, f, { purpose: 'init', reporter: consoleReporter(), retry: false });
        console.log(`  ${run.status === 'passed' ? g.ok('✓') : g.bad('✗')} ${describeRun(run)}`);
        if (run.status === 'passed') lockFlow(paths, updateFlowMeta(f, { status: 'active' }), 'gremlin init');
      }
      const active = listFlows(paths).filter((f) => f.status === 'active').length;
      console.log(`\n${active} of ${flows.length} flows are active and guarded. Flows that failed stay as drafts: check them with \`gremlin flows\`.`);
      if (interactive && cancelIf(await p.confirm({ message: 'Let the Breaker loose for a first hunt?', initialValue: false }))) {
        await runBreaker(project, { reporter: consoleReporter() });
      }
    } else if (!up) {
      console.log(g.dim(`\nThe app isn't running, so flows weren't run. Start it, then: gremlin run --all`));
    }
  } finally {
    app.stop();
  }
  return done();

  function done() {
    console.log(`
${g.bold('Next')}
  gremlin dash           open the dashboard
  gremlin break          attack the app like a hostile user
  gremlin capture "…"    turn a bug report into a failing test
  gremlin guard          replay the flows your changes touch
`);
  }
}

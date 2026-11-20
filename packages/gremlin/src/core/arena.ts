import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { contender, type AgentConnector } from './agent.ts';
import { fixPackage } from './brief.ts';
import type { Project } from './config.ts';
import { acceptFix, lastFailingRun, relatedFlows } from './fixer.ts';
import { getFlow, type Flow } from './flow.ts';
import { protectedMatcher } from './guardrails.ts';
import { endJob, startJob, type Job } from './jobs.ts';
import { onInterrupt } from './interrupt.ts';
import { ensureDir } from './paths.ts';
import { describeRun, runFlow, silentReporter, type Reporter } from './runner.ts';
import { uncommittedChanges } from './snapshot.ts';
import { emit, getBug, saveBug, type BugRecord } from './store.ts';
import { ensureApp, restartApp } from './target.ts';
import { nowIso, round } from './util.ts';

/**
 * The agent arena: several coding agents get the same fix package at once, each in its own git
 * worktree, and Kane judges every fix in a real browser. Of the fixes that pass the bug's flow and
 * its related flows, the smallest wins and is applied; the rest are kept in the report.
 */

export interface ArenaEntry {
  /** "claude-code:sonnet", "codex", … */
  contender: string;
  label: string;
  durationS?: number;
  changedFiles: string[];
  added: number;
  removed: number;
  /** Protected files it changed; left out of its patch. */
  blocked: string[];
  runId?: string;
  relatedRuns: string[];
  result: 'won' | 'passed' | 'flaky' | 'failed' | 'broke-related' | 'broke-startup' | 'no-change' | 'agent-error';
  note?: string;
  summary?: string;
}

export interface ArenaRecord {
  at: string;
  entries: ArenaEntry[];
  winner?: string;
}

export interface ArenaResult {
  job: Job;
  bug: BugRecord;
  outcome: 'fixed' | 'escalated' | 'error';
  message: string;
  entries: ArenaEntry[];
  winner?: ArenaEntry;
  reportFile?: string;
}

export interface ArenaOptions {
  reporter?: Reporter;
  related?: boolean;
}

/** Contenders when none are named: every installed agent, or Claude Code's three models when it's the only one. */
export function defaultContenders(installed: string[]): string[] {
  if (installed.length > 1) return installed;
  if (installed[0] === 'claude-code') return ['claude-code:opus', 'claude-code:sonnet', 'claude-code:haiku'];
  return installed;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

interface Lane {
  spec: string;
  agent: AgentConnector;
  worktree: string;
  /** The project root inside the worktree. */
  root: string;
  entry: ArenaEntry;
  patch?: string;
}

export async function runArena(project: Project, bugId: string, specs: string[], opts: ArenaOptions = {}): Promise<ArenaResult> {
  const reporter = opts.reporter ?? silentReporter;
  const { paths } = project;
  const loaded = getBug(paths, bugId);
  if (!loaded) throw new Error(`No bug ${bugId}. See \`gremlin bugs\`.`);
  const bug: BugRecord = loaded;
  const flow0 = getFlow(paths, bug.flowId);
  if (!flow0) throw new Error(`${bug.id}'s flow ${bug.flowId} is missing from the library.`);
  let flow: Flow = flow0;
  if (['fixed', 'rejected'].includes(bug.status)) throw new Error(`${bug.id} is already ${bug.status}.`);
  const failing = lastFailingRun(project, bug);
  if (!failing) throw new Error(`${bug.id} has no failing run to work from.`);
  if (specs.length < 2) throw new Error('An arena needs at least two contenders, e.g. --agents claude-code:opus,claude-code:sonnet');
  const dirty = uncommittedChanges(project.root);
  if (dirty.length) throw new Error(`Commit or stash your changes first (${dirty.slice(0, 3).join(', ')}): every contender starts from the same commit.`);

  const lanes: Lane[] = specs.map((spec) => {
    const agent = contender(spec);
    if (!agent.available()) throw new Error(`${agent.label} isn't installed or not on PATH.`);
    return { spec, agent, worktree: '', root: '', entry: { contender: spec, label: agent.label, changedFiles: [], added: 0, removed: 0, blocked: [], relatedRuns: [], result: 'no-change' } };
  });

  const top = git(project.root, ['rev-parse', '--show-toplevel']).out.trim();
  const prefix = git(project.root, ['rev-parse', '--show-prefix']).out.trim();
  const isGuarded = protectedMatcher(project);
  const bugDir = ensureDir(join(paths.bugs, bug.id));
  const pkg = fixPackage(project, bug, flow, failing, 1, 1);
  const pkgFile = join(bugDir, 'arena-package.md');
  writeFileSync(pkgFile, pkg);

  const job = startJob(paths, 'fix', `Arena for ${bug.id}: ${lanes.map((l) => l.agent.label).join(' vs ')}`, { bugId: bug.id, arena: specs });
  const statusBefore = bug.status;
  let app = { stop() {}, startedByGremlin: false } as Awaited<ReturnType<typeof ensureApp>>;
  let applied: string | undefined;
  const cleanUp = () => {
    if (applied) git(top, ['apply', '-R', '--whitespace=nowarn', applied]);
    applied = undefined;
    app.stop();
    for (const lane of lanes) if (lane.worktree) git(top, ['worktree', 'remove', '--force', lane.worktree]);
  };
  // stopped mid-arena: put the bug and the working tree back as they were
  const release = onInterrupt(() => {
    cleanUp();
    if (bug.status === 'fixing') {
      bug.status = statusBefore;
      saveBug(paths, bug);
    }
  });
  try {
    bug.status = 'fixing';
    saveBug(paths, bug);

    // 1. Every contender works at once, each on its own copy of the same commit.
    for (const lane of lanes) {
      lane.worktree = mkdtempSync(join(tmpdir(), `gremlin-arena-${bug.id.toLowerCase()}-`));
      rmSync(lane.worktree, { recursive: true, force: true });
      const add = git(top, ['worktree', 'add', '--detach', lane.worktree, 'HEAD']);
      if (!add.ok) throw new Error(`git worktree add failed: ${add.err}`);
      lane.root = join(lane.worktree, prefix);
    }
    reporter.info(`🏟  ${lanes.length} agents get the same fix package for ${bug.id}: ${lanes.map((l) => l.agent.label).join(', ')}`);
    emit(paths, 'agent', `Arena: ${lanes.map((l) => l.agent.label).join(' vs ')} are each fixing ${bug.id}`, { bugId: bug.id, arena: specs }, job.id);
    await Promise.all(
      lanes.map(async (lane) => {
        const res = await lane.agent.fix(pkg, pkgFile, lane.root, (a) => {
          if (a.kind === 'edit') emit(paths, 'agent', `${lane.agent.label}: ${a.detail}`, { bugId: bug.id, contender: lane.spec, activity: a.kind }, job.id);
        });
        lane.entry.durationS = res.durationS;
        lane.entry.summary = res.summary.slice(0, 1200);
        collectPatch(lane, isGuarded, prefix);
        if (!lane.entry.changedFiles.length) lane.entry.result = res.ok ? 'no-change' : 'agent-error';
        reporter.info(`   ${lane.agent.label} finished in ${Math.round(res.durationS)}s: ${lane.entry.changedFiles.join(', ') || 'no changes'}${lane.entry.changedFiles.length ? ` (+${lane.entry.added} −${lane.entry.removed})` : ''}`);
      }),
    );

    // 2. Kane judges each fix in turn, on the real app, from the same starting point.
    app = await ensureApp(project, reporter.info);
    const related = opts.related === false ? [] : relatedFlows(project, flow, 4, bug.id);
    for (const [i, lane] of lanes.entries()) {
      if (!lane.patch) continue;
      const patchFile = join(bugDir, `arena-${i + 1}.patch`);
      writeFileSync(patchFile, lane.patch);
      const apply = git(top, ['apply', '--whitespace=nowarn', patchFile]);
      if (!apply.ok) {
        lane.entry.result = 'failed';
        lane.entry.note = `the patch didn't apply: ${apply.err.split('\n')[0]}`;
        continue;
      }
      applied = patchFile;
      try {
        reporter.info(`\n⚖  Kane is judging ${lane.agent.label}'s fix …`);
        try {
          app = await restartApp(project, app, (m) => reporter.info(`   ${m}`));
        } catch (err) {
          lane.entry.result = 'broke-startup';
          lane.entry.note = (err as Error).message.split('\n')[0];
          reporter.warn(`   ✗ the app didn't start: ${lane.entry.note}`);
          continue;
        }
        const run = await runFlow(project, flow, { purpose: 'fix', job: job.id, bugId: bug.id, attempt: i + 1, reporter });
        lane.entry.runId = run.id;
        bug.runs.push(run.id);
        bug.credits = round(bug.credits + run.credits, 2);
        reporter.info(`   → ${describeRun(run)}`);
        if (run.status !== 'passed') {
          // a fix has to pass cleanly to win; one that only passed on Kane's retry is called what it is
          lane.entry.result = run.status === 'flaky' ? 'flaky' : 'failed';
          lane.entry.note = run.status === 'flaky' ? `failed once, then passed on retry (${run.kane?.verdict?.oneLiner ?? run.kane?.reason ?? 'no reason given'})` : run.kane?.reason;
          continue;
        }
        lane.entry.result = 'passed';
        for (const rf of related) {
          const rr = await runFlow(project, rf, { purpose: 'fix', job: job.id, bugId: bug.id, attempt: i + 1, reporter });
          lane.entry.relatedRuns.push(rr.id);
          bug.credits = round(bug.credits + rr.credits, 2);
          if (rr.status === 'failed' || rr.status === 'error') {
            lane.entry.result = 'broke-related';
            lane.entry.note = `broke "${rf.title}"`;
            reporter.warn(`   ✗ ${lane.entry.note}`);
            break;
          }
        }
      } finally {
        git(top, ['apply', '-R', '--whitespace=nowarn', patchFile]);
        applied = undefined;
      }
      emit(paths, 'bug', `${bug.id}: Kane ${lane.entry.result === 'passed' ? 'passed' : 'rejected'} ${lane.agent.label}'s fix`, { bugId: bug.id, contender: lane.spec, result: lane.entry.result, runId: lane.entry.runId }, job.id);
    }

    // 3. The smallest fix Kane passed wins; ties go to the faster agent.
    const winner = lanes
      .filter((l) => l.entry.result === 'passed')
      .sort((a, b) => a.entry.added + a.entry.removed - (b.entry.added + b.entry.removed) || (a.entry.durationS ?? 0) - (b.entry.durationS ?? 0))[0];
    const entries = lanes.map((l) => l.entry);
    let outcome: ArenaResult['outcome'] = 'escalated';
    let message: string;
    if (winner) {
      winner.entry.result = 'won';
      const patchFile = join(bugDir, `arena-${lanes.indexOf(winner) + 1}.patch`);
      const apply = git(top, ['apply', '--whitespace=nowarn', patchFile]);
      if (!apply.ok) throw new Error(`The winning patch didn't apply again: ${apply.err}`);
      bug.attempts = bug.attempts.filter((a) => a.result !== 'pending');
      bug.attempts.push({
        n: bug.attempts.length + 1,
        at: nowIso(),
        agent: winner.agent.label,
        promptFile: relative(project.root, pkgFile),
        changedFiles: winner.entry.changedFiles,
        outsideArea: [],
        blocked: winner.entry.blocked,
        agentSummary: winner.entry.summary,
        runId: winner.entry.runId,
        relatedRuns: winner.entry.relatedRuns,
        result: 'passed',
        durationS: winner.entry.durationS,
      });
      bug.arena = { at: nowIso(), entries, winner: winner.spec };
      flow = acceptFix(project, bug, flow, related, `arena:${winner.spec}`);
      outcome = 'fixed';
      const others = entries.filter((e) => e !== winner.entry);
      message = `${winner.agent.label} wins: Kane passed its fix (+${winner.entry.added} −${winner.entry.removed}) and applied it. ${others.map((e) => `${e.label}: ${e.result}`).join(', ')}.`;
    } else {
      bug.status = statusBefore === 'fixing' ? 'confirmed' : statusBefore;
      bug.arena = { at: nowIso(), entries };
      saveBug(paths, bug);
      message = `No contender's fix passed Kane. ${entries.map((e) => `${e.label}: ${e.result}`).join(', ')}.`;
    }
    const reportFile = join(bugDir, 'arena.md');
    writeFileSync(reportFile, arenaMarkdown(bug, entries));
    emit(paths, 'bug', message, { bugId: bug.id, arena: true, winner: winner?.spec }, job.id);
    endJob(paths, job, winner ? 'passed' : 'failed', message, { bugId: bug.id });
    return { job, bug, outcome, message, entries, winner: winner?.entry, reportFile };
  } catch (err) {
    if (bug.status === 'fixing') {
      bug.status = statusBefore;
      saveBug(paths, bug);
    }
    endJob(paths, job, 'error', (err as Error).message);
    throw err;
  } finally {
    release();
    cleanUp();
  }
}

/** What a contender changed, minus anything it may not touch, as a patch against the shared commit. */
function collectPatch(lane: Lane, isGuarded: (file: string) => boolean, prefix: string): void {
  git(lane.root, ['add', '-A', '--', '.']);
  const names = git(lane.root, ['diff', '--cached', '--name-only', '--relative', 'HEAD']).out.split('\n').filter(Boolean);
  lane.entry.blocked = names.filter((f) => isGuarded(f) || f.startsWith('.gremlin/'));
  const allowed = names.filter((f) => !lane.entry.blocked.includes(f));
  lane.entry.changedFiles = allowed;
  if (!allowed.length) return;
  const repoPaths = allowed.map((f) => prefix + f);
  const top = lane.worktree;
  for (const line of git(top, ['diff', '--cached', '--numstat', 'HEAD', '--', ...repoPaths]).out.split('\n').filter(Boolean)) {
    const [a, r] = line.split('\t');
    lane.entry.added += Number(a) || 0;
    lane.entry.removed += Number(r) || 0;
  }
  lane.patch = git(top, ['diff', '--cached', '--binary', 'HEAD', '--', ...repoPaths]).out;
}

const RESULT_LABEL: Record<ArenaEntry['result'], string> = {
  won: '🏆 Winner',
  passed: '✅ Passed, larger fix',
  flaky: '⚠️ Flaky under Kane',
  failed: '❌ Kane failed it',
  'broke-related': '❌ Broke a related flow',
  'broke-startup': "❌ App wouldn't start",
  'no-change': '· Changed nothing',
  'agent-error': '· Agent error',
};

export function arenaMarkdown(bug: Pick<BugRecord, 'id' | 'title'>, entries: ArenaEntry[]): string {
  const lines = [
    `# Agent arena: ${bug.id} ${bug.title}`,
    '',
    `${entries.length} agents got the same fix package. Kane CLI judged each fix in a real browser, against the bug's flow and its related flows. The smallest fix that passed wins.`,
    '',
    '| Agent | Time | Changed | Lines | Kane run | Result |',
    '| --- | --- | --- | --- | --- | --- |',
    ...entries.map(
      (e) =>
        `| ${e.label} | ${e.durationS !== undefined ? `${Math.round(e.durationS)}s` : '–'} | ${e.changedFiles.map((f) => `\`${f}\``).join(', ') || '–'} | ${e.changedFiles.length ? `+${e.added} −${e.removed}` : '–'} | ${e.runId ? `\`${e.runId}\`` : '–'}${e.relatedRuns.length ? ` + ${e.relatedRuns.length} related` : ''} | ${RESULT_LABEL[e.result]}${e.note ? `: ${e.note}` : ''} |`,
    ),
  ];
  const blocked = entries.filter((e) => e.blocked.length);
  if (blocked.length) lines.push('', ...blocked.map((e) => `${e.label} also changed protected files (${e.blocked.join(', ')}); those changes were dropped.`));
  return lines.join('\n') + '\n';
}

import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import picomatch from 'picomatch';
import { getAgent, type AgentActivity } from './agent.ts';
import { fixPackage } from './brief.ts';
import type { Project } from './config.ts';
import { getFlow, listFlows, moveFlow, updateFlowMeta, type Flow } from './flow.ts';
import { protectedMatcher } from './guardrails.ts';
import { endJob, startJob, type Job } from './jobs.ts';
import { ensureDir, type ProjectPaths } from './paths.ts';
import { describeRun, runFlow, silentReporter, type Reporter } from './runner.ts';
import { changedSince, diffStat, restoreGuarded, revertFiles, takeSnapshot } from './snapshot.ts';
import { emit, getBug, getRun, lockFlow, saveBug, unlockFlow, type BugRecord, type FixAttempt, type RunRecord } from './store.ts';
import { onInterrupt } from './interrupt.ts';
import { ensureApp, restartApp } from './target.ts';
import { nowIso, round } from './util.ts';

export type LoopMode = 'suggest' | 'approve' | 'autonomous';

export interface FixOptions {
  mode?: LoopMode;
  attempts?: number;
  reporter?: Reporter;
  /** Asked before handing the bug to the agent in approve mode. Return false to stop. */
  confirm?: (question: string) => Promise<boolean>;
  /** Run the related-flow side-effect check after the failing flow passes. Default true. */
  related?: boolean;
}

export interface FixResult {
  job: Job;
  bug: BugRecord;
  outcome: 'fixed' | 'escalated' | 'suggested' | 'declined' | 'error';
  message: string;
  packageFile?: string;
}

export function lastFailingRun(project: Project, bug: BugRecord): RunRecord | undefined {
  for (const id of [...bug.runs].reverse()) {
    const r = getRun(project.paths, id);
    if (r && (r.status === 'failed' || r.status === 'error')) return r;
  }
  return bug.runs.length ? getRun(project.paths, bug.runs[bug.runs.length - 1]) : undefined;
}

export async function runFixer(project: Project, bugId: string, opts: FixOptions = {}): Promise<FixResult> {
  const reporter = opts.reporter ?? silentReporter;
  const { paths, config } = project;
  const loaded = getBug(paths, bugId);
  if (!loaded) throw new Error(`No bug ${bugId}. See \`gremlin bugs\`.`);
  let bug: BugRecord = loaded;
  const flow0 = getFlow(paths, bug.flowId);
  if (!flow0) throw new Error(`${bug.id}'s flow ${bug.flowId} is missing from the library.`);
  let flow: Flow = flow0;
  const mode = opts.mode ?? config.loop.mode;
  const maxAttempts = opts.attempts ?? config.loop.attempts;
  const job = startJob(paths, 'fix', `Fix ${bug.id}: ${bug.title}`, { bugId: bug.id, mode });
  const bugDir = ensureDir(join(paths.bugs, bug.id));

  if (['fixed', 'rejected'].includes(bug.status)) {
    endJob(paths, job, 'done', `${bug.id} is already ${bug.status}`);
    return { job, bug, outcome: 'error', message: `${bug.id} is already ${bug.status}.` };
  }

  const agent = getAgent(config);
  let failing = lastFailingRun(project, bug);
  if (!failing) throw new Error(`${bug.id} has no failing run to work from.`);
  // The flow whose failure the next package describes: the bug's own, or a related flow the last fix broke.
  let failingFlow: Flow = flow;

  // Suggest mode: hand the human (or any agent) the package and stop.
  const firstPackage = fixPackage(project, bug, flow, failing, bug.attempts.length + 1, maxAttempts);
  const firstFile = join(bugDir, `attempt-${bug.attempts.length + 1}.md`);
  writeFileSync(firstFile, firstPackage);
  if (mode === 'suggest' || !agent) {
    const message = !agent
      ? `No coding agent configured. Fix package written to ${relative(project.root, firstFile)}; then run \`gremlin verify ${bug.id}\`.`
      : `Suggest mode: fix package written to ${relative(project.root, firstFile)}. Run \`gremlin verify ${bug.id}\` once fixed.`;
    endJob(paths, job, 'done', message);
    return { job, bug, outcome: 'suggested', message, packageFile: firstFile };
  }
  if (!agent.available()) {
    const message = `${agent.label} isn't installed or not on PATH. Fix package written to ${relative(project.root, firstFile)}.`;
    endJob(paths, job, 'error', message);
    return { job, bug, outcome: 'error', message, packageFile: firstFile };
  }
  if (mode === 'approve' && opts.confirm) {
    const ok = await opts.confirm(`Hand ${bug.id} to ${agent.label}? (fix package: ${relative(project.root, firstFile)})`);
    if (!ok) {
      endJob(paths, job, 'done', 'Declined by a human');
      return { job, bug, outcome: 'declined', message: 'Declined.', packageFile: firstFile };
    }
  }

  let app = await ensureApp(project, reporter.info);
  const isGuarded = protectedMatcher(project);
  const areaGlobs = flow.tags.flatMap((t) => config.guard.areas[t] ?? []);
  const inArea = areaGlobs.length ? picomatch(areaGlobs, { dot: true }) : () => true;

  // an attempt left pending by an earlier run that was stopped never finished: it doesn't count
  bug.attempts = bug.attempts.filter((a) => a.result !== 'pending');
  const statusBefore = bug.status === 'fixing' ? 'confirmed' : bug.status;
  const releaseBug = onInterrupt(() => {
    bug.attempts = bug.attempts.filter((a) => a.result !== 'pending');
    bug.status = statusBefore;
    saveBug(paths, bug);
  });
  try {
    bug.status = 'fixing';
    saveBug(paths, bug);
    emit(paths, 'bug', `${bug.id} handed to ${agent.label}`, { bugId: bug.id, status: 'fixing' }, job.id);

    while (bug.attempts.filter((a) => a.result !== 'pending').length < maxAttempts) {
      const n = bug.attempts.length + 1;
      const pkg = fixPackage(project, bug, failingFlow, failing!, n, maxAttempts);
      const pkgFile = join(bugDir, `attempt-${n}.md`);
      writeFileSync(pkgFile, pkg);
      const attempt: FixAttempt = {
        n,
        at: nowIso(),
        agent: agent.name,
        promptFile: relative(project.root, pkgFile),
        changedFiles: [],
        outsideArea: [],
        blocked: [],
        result: 'pending',
      };
      bug.attempts.push(attempt);
      saveBug(paths, bug);

      reporter.info(`\n🛠  Attempt ${n}/${maxAttempts}: ${agent.label} is working on ${bug.id} …`);
      emit(paths, 'agent', `Attempt ${n}/${maxAttempts}: ${agent.label} is fixing ${bug.id}`, { bugId: bug.id, attempt: n }, job.id);
      const snap = takeSnapshot(project.root, isGuarded);
      const onActivity = (a: AgentActivity) => {
        if (a.kind === 'edit' || a.kind === 'run') reporter.info(`   ${a.kind === 'edit' ? '✎' : '$'} ${a.detail}`);
        emit(paths, 'agent', a.detail, { bugId: bug.id, attempt: n, activity: a.kind }, job.id);
      };
      const res = await agent.fix(pkg, pkgFile, project.root, onActivity);
      attempt.durationS = res.durationS;
      attempt.agentSummary = res.summary.slice(0, 1200);

      // What did the agent actually change? Put back anything it may not touch.
      const changed = changedSince(snap).filter((f) => !f.startsWith('.gremlin/') || f.startsWith('.gremlin/flows/') || f.startsWith('.gremlin/locks/') || f === '.gremlin/lock.json');
      const tampered = changed.filter(isGuarded);
      if (tampered.length) {
        restoreGuarded(snap, tampered);
        reporter.warn(`   ⛔ reverted changes to protected files: ${tampered.join(', ')}`);
        emit(paths, 'warn', `Reverted the agent's changes to protected files: ${tampered.join(', ')}`, { bugId: bug.id, files: tampered }, job.id);
      }
      attempt.blocked = tampered;
      attempt.changedFiles = changed.filter((f) => !isGuarded(f));
      attempt.outsideArea = attempt.changedFiles.filter((f) => !inArea(f));
      if (attempt.outsideArea.length) emit(paths, 'warn', `Changes outside the bug's area, flagged for review: ${attempt.outsideArea.join(', ')}`, { bugId: bug.id }, job.id);

      if (!res.ok && !attempt.changedFiles.length) {
        attempt.result = 'agent-error';
        saveBug(paths, bug);
        reporter.warn(`   agent error: ${res.summary.slice(0, 200)}`);
        continue;
      }
      if (!attempt.changedFiles.length) {
        attempt.result = tampered.length ? 'blocked' : 'failed';
        saveBug(paths, bug);
        reporter.warn('   the agent changed no application files');
        continue;
      }
      reporter.info(`   changed: ${attempt.changedFiles.join(', ')}`);
      const stat = diffStat(project.root, attempt.changedFiles);
      if (stat) writeFileSync(join(bugDir, `attempt-${n}.diffstat.txt`), stat + '\n');

      // Kane decides. The agent's word doesn't count.
      try {
        app = await restartApp(project, app, (m) => reporter.info(`   ${m}`));
      } catch (err) {
        // the change broke startup: that's this attempt's evidence
        attempt.result = 'failed';
        attempt.appError = (err as Error).message.slice(0, 1500);
        saveBug(paths, bug);
        reporter.warn(`   ✗ the app didn't start after the change: ${attempt.appError.split('\n')[0]}`);
        emit(paths, 'bug', `${bug.id}: attempt ${n} broke the app's startup`, { bugId: bug.id, attempt: n }, job.id);
        continue;
      }
      reporter.info('   Kane is re-running the failing flow in a real browser …');
      const verify = await runFlow(project, flow, { purpose: 'fix', job: job.id, bugId: bug.id, attempt: n, reporter });
      attempt.runId = verify.id;
      bug.runs.push(verify.id);
      bug.credits = round(bug.credits + verify.credits, 2);
      reporter.info(`   → ${describeRun(verify)}`);

      if (verify.status !== 'passed') {
        attempt.result = 'failed';
        if (verify.status !== 'flaky') {
          failing = verify;
          failingFlow = flow;
        }
        saveBug(paths, bug);
        emit(paths, 'bug', `${bug.id}: attempt ${n} did not pass Kane`, { bugId: bug.id, attempt: n, runId: verify.id }, job.id);
        continue;
      }

      // Side effects: replay related active flows before accepting the fix.
      const related = opts.related === false ? [] : relatedFlows(project, flow, 4, bug.id);
      attempt.relatedRuns = [];
      let sideEffect: { flow: Flow; run: RunRecord } | undefined;
      for (const rf of related) {
        reporter.info(`   checking related flow: ${rf.title}`);
        const rr = await runFlow(project, rf, { purpose: 'fix', job: job.id, bugId: bug.id, attempt: n, reporter });
        attempt.relatedRuns.push(rr.id);
        bug.credits = round(bug.credits + rr.credits, 2);
        if (rr.status === 'failed' || rr.status === 'error') {
          sideEffect = { flow: rf, run: rr };
          break;
        }
      }
      if (sideEffect) {
        attempt.result = 'failed';
        failing = sideEffect.run;
        failingFlow = sideEffect.flow;
        reporter.warn(`   ✗ the fix broke "${sideEffect.flow.title}"`);
        emit(paths, 'bug', `${bug.id}: attempt ${n} broke a related flow: ${sideEffect.flow.title}`, { bugId: bug.id, runId: sideEffect.run.id }, job.id);
        saveBug(paths, bug);
        continue;
      }

      attempt.result = 'passed';
      flow = acceptFix(project, bug, flow, related, 'fixer');
      const message = `${bug.id} fixed on attempt ${n}: Kane passed the flow${related.length ? ` and ${related.length} related flow${related.length === 1 ? '' : 's'}` : ''}. Saved to the regression library.`;
      emit(paths, 'bug', message, { bugId: bug.id, status: 'fixed', attempt: n }, job.id);
      endJob(paths, job, 'passed', message, { bugId: bug.id });
      return { job, bug, outcome: 'fixed', message };
    }

    // Out of attempts: hand to a human with the full history.
    bug.status = 'escalated';
    saveBug(paths, bug);
    const escalation = join(bugDir, 'escalation.md');
    writeFileSync(
      escalation,
      [
        `# ${bug.id} escalated to a human`,
        '',
        `${agent.label} made ${maxAttempts} attempts and Kane did not pass any of them.`,
        '',
        ...bug.attempts.map(
          (a) =>
            `## Attempt ${a.n} (${a.result})\n- Package: ${a.promptFile}\n- Changed: ${a.changedFiles.join(', ') || 'nothing'}\n- Kane run: ${a.runId ?? 'n/a'}\n- Agent said: ${(a.agentSummary ?? '').replace(/\s+/g, ' ').slice(0, 600)}\n`,
        ),
      ].join('\n'),
    );
    const message = `${bug.id} escalated after ${maxAttempts} attempts. History: ${relative(project.root, escalation)}`;
    emit(paths, 'bug', message, { bugId: bug.id, status: 'escalated' }, job.id);
    endJob(paths, job, 'failed', message, { bugId: bug.id });
    return { job, bug, outcome: 'escalated', message };
  } catch (err) {
    endJob(paths, job, 'error', (err as Error).message);
    throw err;
  } finally {
    releaseBug();
    app.stop();
  }
}

/** Moves a repro into regression/ and drops the lock under its old id; the caller locks it where it now lives. */
function toRegression(paths: ProjectPaths, flow: Flow, patch: Parameters<typeof moveFlow>[3]): Flow {
  const moved = moveFlow(paths, flow, 'regression', patch);
  if (moved.id !== flow.id) unlockFlow(paths, flow.id);
  return moved;
}

/** Accepted: the flow joins the regression library and Guard replays it from now on. Returns the flow where it now lives. */
export function acceptFix(project: Project, bug: BugRecord, flow: Flow, related: Flow[], by: string): Flow {
  const { paths } = project;
  bug.status = 'fixed';
  bug.fixedAt = nowIso();
  saveBug(paths, bug);
  const failFirst = flow.fail_first ?? bug.runs[0];
  const kept =
    flow.type === 'regression'
      ? updateFlowMeta(flow, { status: 'active', fail_first: failFirst })
      : toRegression(paths, flow, { status: 'active', fail_first: failFirst, bug: bug.id });
  lockFlow(paths, kept, by);
  // Other repros of this bug (a captured report, a second attack) passed too: they guard it from now on as well.
  for (const sib of related.filter((f) => f.bug === bug.id && f.status !== 'active')) {
    const s = sib.type === 'regression' ? updateFlowMeta(sib, { status: 'active' }) : toRegression(paths, sib, { status: 'active' });
    lockFlow(paths, s, by);
  }
  if (kept.id !== bug.flowId) {
    bug.flowId = kept.id;
    saveBug(paths, bug);
  }
  return kept;
}

/** Other repros of the same bug come first (they must pass too), then active flows in the same area. */
export function relatedFlows(project: Project, flow: Flow, limit = 4, bugId?: string): Flow[] {
  const all = listFlows(project.paths).filter((f) => f.id !== flow.id && f.status !== 'retired');
  const siblings = bugId ? all.filter((f) => f.bug === bugId) : [];
  const area = all
    .filter((f) => !siblings.includes(f) && f.status === 'active' && f.tags.some((t) => flow.tags.includes(t)))
    .sort((a, b) => (a.type === 'happy' ? -1 : 0) - (b.type === 'happy' ? -1 : 0));
  return [...siblings, ...area].slice(0, Math.max(limit, siblings.length));
}

/** Re-run a bug's flow after a fix made by hand or by an agent outside Gremlin. */
export async function verifyBug(project: Project, bugId: string, reporter: Reporter = silentReporter): Promise<{ bug: BugRecord; run: RunRecord }> {
  const bug = getBug(project.paths, bugId);
  if (!bug) throw new Error(`No bug ${bugId}.`);
  const flow = getFlow(project.paths, bug.flowId);
  if (!flow) throw new Error(`${bug.id}'s flow is missing.`);
  const job = startJob(project.paths, 'run', `Verify ${bug.id}`, { bugId: bug.id });
  const app = await ensureApp(project, reporter.info);
  try {
    const run = await runFlow(project, flow, { purpose: 'verify', job: job.id, bugId: bug.id, reporter });
    bug.runs.push(run.id);
    bug.credits = round(bug.credits + run.credits, 2);
    if (run.status === 'passed' && bug.status !== 'cant-reproduce') {
      bug.status = 'fixed';
      bug.fixedAt = nowIso();
      const moved =
        flow.type === 'regression'
          ? updateFlowMeta(flow, { status: 'active', fail_first: flow.fail_first ?? bug.runs[0] })
          : toRegression(project.paths, flow, { status: 'active', fail_first: flow.fail_first ?? bug.runs[0], bug: bug.id });
      lockFlow(project.paths, moved, 'verify');
      bug.flowId = moved.id;
    }
    saveBug(project.paths, bug);
    endJob(project.paths, job, run.status === 'passed' ? 'passed' : 'failed', `${bug.id}: ${describeRun(run)}`);
    return { bug, run };
  } finally {
    app.stop();
  }
}

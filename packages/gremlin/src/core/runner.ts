import { join } from 'node:path';
import type { Project } from './config.ts';
import { resolveUrl } from './config.ts';
import { digestEvidence } from './evidence.ts';
import { compileFlow, updateFlowMeta, type Flow } from './flow.ts';
import { assertBudget, assertFlowSafe, assertTargetSafe } from './guardrails.ts';
import { runKaneTest, type KaneEvent, type KaneRunResult } from './kane.ts';
import { emit, recordCredits, recordFlowResult, saveRun, type RunPurpose, type RunRecord } from './store.ts';
import { resetData } from './target.ts';
import { nowIso, round, runId } from './util.ts';

export interface Reporter {
  info(msg: string): void;
  warn(msg: string): void;
  kane?(flow: Flow, e: KaneEvent): void;
}

export const silentReporter: Reporter = { info() {}, warn() {} };

export interface RunFlowOptions {
  purpose: RunPurpose;
  job?: string;
  bugId?: string;
  attempt?: number;
  /** Re-run once on failure; a pass on retry is logged as flaky, not as a bug. Default true. */
  retry?: boolean;
  author?: boolean;
  reporter?: Reporter;
  signal?: AbortSignal;
}

/**
 * Run one flow through Kane CLI. This is the only place a verdict is produced:
 * Gremlin never claims a pass that Kane did not observe.
 */
export async function runFlow(project: Project, flow: Flow, opts: RunFlowOptions): Promise<RunRecord> {
  const { paths, config } = project;
  const reporter = opts.reporter ?? silentReporter;
  assertTargetSafe(project);
  assertFlowSafe(flow);
  assertBudget(project, { bugId: opts.bugId });

  const id = runId();
  const evidenceDir = join(paths.evidence, id);
  const run: RunRecord = {
    id,
    flowId: flow.id,
    flowTitle: flow.title,
    flowType: flow.type,
    flowHash: flow.hash,
    purpose: opts.purpose,
    job: opts.job,
    bugId: opts.bugId,
    attempt: opts.attempt,
    target: resolveUrl(config, flow.start),
    startedAt: nowIso(),
    status: 'running',
    credits: 0,
  };
  saveRun(paths, run);
  emit(paths, 'flow-start', flow.title, { runId: id, flowId: flow.id, purpose: opts.purpose, bugId: opts.bugId }, opts.job);

  const compiled = compileFlow(flow, config, paths);
  const exec = async (label: string): Promise<KaneRunResult> => {
    await resetData(project);
    return runKaneTest({
      file: compiled.testMdPath,
      cwd: paths.kane,
      logPath: join(evidenceDir, `${label}.ndjson`),
      variables: compiled.variables,
      headless: config.kane.headless,
      maxSteps: config.kane.max_steps,
      timeoutS: config.kane.timeout,
      bugDetection: config.kane.bug_detection,
      author: opts.author,
      signal: opts.signal,
      onEvent: (e) => {
        reporter.kane?.(flow, e);
        if (e.kind === 'step-start') emit(paths, 'kane-step', e.heading, { runId: id, index: e.index, status: 'running' }, opts.job);
        else if (e.kind === 'step-end')
          emit(paths, 'kane-step', e.heading, { runId: id, index: e.index, status: e.status, durationS: e.durationS, reason: e.reason }, opts.job);
        else if (e.kind === 'action') emit(paths, 'kane-action', e.detail, { runId: id, index: e.index, ok: e.ok }, opts.job);
        else if (e.kind === 'mode') emit(paths, 'kane-action', e.mode === 'replay' ? 'replaying recorded step' : 'authoring step', { runId: id, index: e.index }, opts.job);
      },
    });
  };

  let first = await exec('kane');
  let final = first;
  run.kane = first;
  run.credits = first.credits;

  if (first.status === 'failed' && opts.retry !== false) {
    reporter.info(`  ↻ failed at "${first.failedStep?.heading ?? 'unknown step'}", re-running once to rule out flakiness`);
    emit(paths, 'info', 'Re-running once to rule out flakiness', { runId: id }, opts.job);
    const second = await exec('kane-retry');
    run.retry = { status: second.status, credits: second.credits, logPath: second.logPath, evidencePack: second.evidencePack };
    run.credits = round(first.credits + second.credits, 2);
    if (second.status === 'passed') {
      run.status = 'flaky';
    } else {
      run.status = second.status === 'error' ? 'failed' : 'failed';
      // keep the run whose evidence explains the failure best: the one with a triage verdict
      if (second.status === 'failed' && second.verdict && !first.verdict) final = second;
    }
  } else {
    run.status = first.status;
  }
  run.kane = final;

  // Evidence: digest the pack of the run that produced the verdict
  const pack = final.evidencePack ?? first.evidencePack;
  if (pack) run.evidence = digestEvidence(pack, evidenceDir);

  run.endedAt = nowIso();
  saveRun(paths, run);
  recordCredits(paths, { runId: id, flowId: flow.id, purpose: opts.purpose, bugId: opts.bugId, credits: run.credits });
  const fstats = recordFlowResult(paths, flow.id, run.status, id);

  if (run.status === 'flaky') {
    const recentFlakes = fstats.history.slice(-10).filter((h) => h === 'flaky').length;
    if (recentFlakes >= 3 && flow.status !== 'quarantined') {
      updateFlowMeta(flow, { status: 'quarantined' });
      reporter.warn(`  ⚠ ${flow.title} flaked ${recentFlakes} times in its last 10 runs and is now quarantined.`);
      emit(paths, 'warn', `Quarantined flaky flow: ${flow.title}`, { flowId: flow.id }, opts.job);
    }
  }

  emit(
    paths,
    'flow-end',
    flow.title,
    {
      runId: id,
      flowId: flow.id,
      status: run.status,
      credits: run.credits,
      durationS: final.durationS,
      failedStep: final.failedStep?.heading,
      reason: final.reason,
      verdict: final.verdict,
      errors: final.errors,
    },
    opts.job,
  );
  return run;
}

export function describeRun(run: RunRecord): string {
  const k = run.kane;
  if (!k) return run.status;
  if (run.status === 'passed') return `passed in ${k.durationS}s (${k.replayed} replayed, ${k.authored} authored, ${run.credits} credits)`;
  if (run.status === 'flaky') return `flaky: failed, then passed on retry`;
  if (run.status === 'error') return `couldn't run: ${k.errors[0] ?? 'kane-cli error'}`;
  return `failed at "${k.failedStep?.heading ?? '?'}": ${k.reason ?? k.oneLiner ?? 'no reason given'}`;
}

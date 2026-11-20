import picomatch from 'picomatch';
import { failureBrief } from './brief.ts';
import type { Project } from './config.ts';
import { brokenContract, listFlows, type Flow } from './flow.ts';
import { endJob, startJob, type Job } from './jobs.ts';
import { isAutomationFault, kaneShareLink } from './kane.ts';
import { describeRun, runFlow, silentReporter, type Reporter } from './runner.ts';
import { scoreConfidence, scoreSeverity } from './severity.ts';
import { gitChangedFiles, inHistory } from './snapshot.ts';
import { bugForFlow, emit, listBugs, nextBugId, saveBug, tamperedFlows, type BugRecord, type RunPurpose, type RunRecord } from './store.ts';
import { ensureApp } from './target.ts';
import { nowIso, pool, round } from './util.ts';

export interface GuardOptions {
  /** Run every active flow regardless of what changed. */
  all?: boolean;
  /** Explicit changed files; otherwise read from git. */
  changed?: string[];
  base?: string;
  flowIds?: string[];
  tags?: string[];
  reporter?: Reporter;
  purpose?: RunPurpose;
  concurrency?: number;
}

export interface GuardResult {
  flow: Flow;
  run?: RunRecord;
  /** unmerged: Kane failed the flow, but its bug's fix is on a pull request HEAD doesn't have yet. It doesn't block. */
  status: 'passed' | 'failed' | 'flaky' | 'error' | 'tampered' | 'unmerged';
  bug?: BugRecord;
  regression?: boolean;
}

export interface GuardReport {
  job: Job;
  selected: Flow[];
  reason: string;
  changed: string[];
  results: GuardResult[];
  blocking: boolean;
  credits: number;
  durationS: number;
}

export function selectFlows(project: Project, opts: GuardOptions): { flows: Flow[]; reason: string; changed: string[] } {
  const all = listFlows(project.paths).filter((f) => f.status === 'active');
  if (opts.flowIds?.length) {
    const ids = new Set(opts.flowIds);
    return { flows: all.filter((f) => ids.has(f.id)), reason: 'flows named explicitly', changed: [] };
  }
  if (opts.tags?.length) {
    return { flows: all.filter((f) => f.tags.some((t) => opts.tags!.includes(t))), reason: `tags ${opts.tags.join(', ')}`, changed: [] };
  }
  if (opts.all) return { flows: all, reason: 'full replay', changed: [] };

  const changed = (opts.changed ?? gitChangedFiles(project.root, opts.base)).filter((f) => !f.startsWith('.gremlin/'));
  const areas = project.config.guard.areas;
  const hit = new Set<string>();
  for (const [tag, globs] of Object.entries(areas)) {
    const isMatch = picomatch(globs, { dot: true });
    if (changed.some((f) => isMatch(f))) hit.add(tag.toLowerCase());
  }
  if (hit.size) {
    return { flows: all.filter((f) => f.tags.some((t) => hit.has(t))), reason: `changes touch ${[...hit].join(', ')}`, changed };
  }
  if (!changed.length) return { flows: all, reason: 'no diff found; replaying everything', changed };
  return project.config.guard.fallback === 'all'
    ? { flows: all, reason: 'changes touch no mapped area; replaying everything', changed }
    : { flows: [], reason: 'changes touch no mapped area', changed };
}

export async function runGuard(project: Project, opts: GuardOptions = {}): Promise<GuardReport> {
  const reporter = opts.reporter ?? silentReporter;
  const { paths, config } = project;
  const started = Date.now();
  const { flows, reason, changed } = selectFlows(project, opts);
  const job = startJob(paths, 'guard', `Guard: ${flows.length} flow${flows.length === 1 ? '' : 's'} (${reason})`, { flows: flows.map((f) => f.id) });
  const report: GuardReport = { job, selected: flows, reason, changed, results: [], blocking: false, credits: 0, durationS: 0 };

  // A flow edited without a human re-approving it is a blocking failure: changing what is tested is never a fix.
  const tampered = new Set(tamperedFlows(paths, listFlows(paths)).map((f) => f.id));
  for (const f of listFlows(paths).filter((x) => tampered.has(x.id))) {
    report.results.push({ flow: f, status: 'tampered' });
    reporter.warn(`⛔ ${f.title}: the flow was edited without approval (run \`gremlin flows approve ${f.id}\` if a human made this change)`);
    emit(paths, 'error', `Flow edited without approval: ${f.title}`, { flowId: f.id }, job.id);
  }
  const runnable = flows.filter((f) => !tampered.has(f.id));

  if (!runnable.length) {
    report.blocking = report.results.some((r) => r.status === 'tampered');
    report.durationS = round((Date.now() - started) / 1000);
    endJob(paths, job, report.blocking ? 'failed' : 'passed', runnable.length ? '' : `Nothing to replay (${reason})`);
    return report;
  }

  const app = await ensureApp(project, reporter.info);
  try {
    // Flows sharing a reset endpoint can't run side by side without clobbering each other's data.
    const concurrency = config.app.reset ? 1 : (opts.concurrency ?? config.guard.concurrency);
    const results = await pool(runnable, concurrency, async (flow) => {
      reporter.info(`▶ ${flow.title}`);
      const run = await runFlow(project, flow, { purpose: opts.purpose ?? 'guard', job: job.id, reporter });
      report.credits += run.credits;
      reporter.info(`  ${run.status === 'passed' ? '✓' : run.status === 'flaky' ? '~' : '✗'} ${describeRun(run)}`);
      const result: GuardResult = { flow, run, status: run.status === 'running' ? 'error' : run.status };
      if (run.status === 'failed') {
        const { bug, regression, unmerged } = recordGuardFailure(project, flow, run, job);
        result.bug = bug;
        result.regression = regression;
        if (unmerged) {
          result.status = 'unmerged';
          reporter.info(`  ⏳ Not a regression: ${unmergedFix(bug)}`);
        }
      } else if (run.status === 'passed' && flow.type === 'regression') {
        result.bug = recordRegressionPass(project, flow, run, job);
      }
      return result;
    });
    report.results.push(...results);
    report.blocking = report.results.some((r) => r.status === 'failed' || r.status === 'error' || r.status === 'tampered');
    report.durationS = round((Date.now() - started) / 1000);
    report.credits = round(report.credits, 2);
    const waiting = report.results.filter((r) => r.status === 'unmerged').length;
    const failed = report.results.filter((r) => r.status !== 'passed' && r.status !== 'flaky').length - waiting;
    endJob(
      paths,
      job,
      report.blocking ? 'failed' : 'passed',
      report.blocking
        ? `${failed} of ${report.results.length} flows failed`
        : waiting
          ? `${report.results.length - waiting} of ${report.results.length} flows verified by Kane; ${waiting} wait${waiting === 1 ? 's' : ''} on a fix that isn't merged yet`
          : `All ${report.results.length} flows verified by Kane`,
      { credits: report.credits, failed },
    );
    return report;
  } catch (err) {
    endJob(paths, job, 'error', (err as Error).message);
    throw err;
  } finally {
    app.stop();
  }
}

/**
 * A regression flow was proven once, when its bug was fixed. If the bug came back and Kane now passes the same locked
 * flow again, that is the same proof: the bug is fixed again.
 */
function recordRegressionPass(project: Project, flow: Flow, run: RunRecord, job: Job): BugRecord | undefined {
  const bug = bugForFlow(project.paths, flow);
  if (!bug || bug.status === 'fixed' || bug.status === 'rejected') return bug;
  bug.status = 'fixed';
  bug.fixedAt = nowIso();
  bug.runs.push(run.id);
  saveBug(project.paths, bug);
  emit(project.paths, 'bug', `${bug.id} fixed again: Kane passed its regression flow`, { bugId: bug.id, status: 'fixed', runId: run.id }, job.id);
  return bug;
}

/**
 * A failing guarded flow either reopens the bug it was guarding (a regression) or opens a new one. Unless that bug's
 * fix is on a pull request this checkout doesn't have yet: then the flow fails because the fix isn't here, and the
 * bug is left as it is.
 */
function recordGuardFailure(project: Project, flow: Flow, run: RunRecord, job: Job): { bug: BugRecord; regression: boolean; unmerged?: boolean } {
  const { paths } = project;
  const contract = brokenContract(flow, project.config, { heading: run.kane?.failedStep?.heading, reason: run.kane?.reason });
  // the same flow breaking a different product rule is a different bug, not more evidence for this one
  const sameRule = (b: BugRecord) => !b.contract || !contract || b.contract === contract;
  const known = bugForFlow(paths, flow);
  const existing = known && sameRule(known) ? known : listBugs(paths).find((b) => b.flowId === flow.id && b.contract === contract);
  if (existing?.status === 'fixed' && existing.pr && !inHistory(project.root, existing.pr.sha)) {
    emit(paths, 'info', `${flow.title} fails until ${existing.id}'s fix is merged (${existing.pr.url})`, { bugId: existing.id, runId: run.id, pr: existing.pr.url }, job.id);
    return { bug: existing, regression: false, unmerged: true };
  }
  if (existing) {
    const regression = existing.status === 'fixed';
    existing.status = 'confirmed';
    existing.runs.push(run.id);
    existing.failingStep = run.kane?.failedStep?.heading;
    existing.contract = contract ?? existing.contract;
    existing.reason = run.kane?.reason;
    existing.fixedAt = undefined;
    if (regression) existing.regressedAt = nowIso();
    saveBug(paths, existing);
    emit(paths, 'bug', regression ? `Regression caught: ${existing.id} is back` : `${existing.id} still failing`, { bugId: existing.id, regression, runId: run.id }, job.id);
    return { bug: existing, regression };
  }
  const verdict = run.kane?.verdict;
  const bug: BugRecord = {
    id: nextBugId(paths),
    // Kane's own name for what went wrong ("Cart badge remains nonzero after order confirmation") says more than the flow's
    title: verdict?.title && !isAutomationFault(verdict) ? verdict.title : `${flow.title} (broke)`,
    origin: 'guard',
    status: 'confirmed',
    severity: scoreSeverity(run, { attack: flow.attack, tags: flow.tags }),
    confidence: scoreConfidence(run),
    flowId: flow.id,
    attack: flow.attack,
    tags: flow.tags,
    failingStep: run.kane?.failedStep?.heading,
    contract,
    reason: run.kane?.reason,
    verdict: run.kane?.verdict,
    runs: [run.id],
    attempts: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    credits: run.credits,
  };
  saveBug(paths, bug);
  emit(paths, 'bug', `${bug.id}: ${flow.title} broke`, { bugId: bug.id, severity: bug.severity, origin: 'guard' }, job.id);
  return { bug, regression: flow.type === 'regression' };
}

/** Why an unmerged result doesn't block, naming the pull request it waits for. */
export function unmergedFix(bug: BugRecord): string {
  return `${bug.id}'s fix isn't merged yet (${bug.pr?.url})`;
}

/** The Guard result as a brief for a coding agent (used by hooks, MCP and CI). */
export function guardBrief(project: Project, report: GuardReport): string {
  const bad = report.results.filter((r) => r.status === 'failed' || r.status === 'error' || r.status === 'tampered');
  // nothing for an agent to fix: the fix exists, on a pull request
  const waiting = report.results.filter((r) => r.status === 'unmerged').map((r) => `Not blocking: "${r.flow.title}" failed only because ${unmergedFix(r.bug!)}. It is not a regression.`);
  if (!bad.length) {
    if (waiting.length) return [`Gremlin Guard: ${report.results.length - waiting.length} of ${report.results.length} relevant flows passed in a real browser (verified by Kane CLI).`, ...waiting].join('\n');
    return `Gremlin Guard: all ${report.results.length} relevant flows passed in a real browser (verified by Kane CLI).`;
  }
  const parts = [
    `Gremlin Guard blocked this change: ${bad.length} of ${report.results.length} user flows failed when Kane CLI replayed them in a real browser (${report.reason}).`,
    'Fix the application so these flows pass. Do not edit the flows or anything under .gremlin/.',
    '',
  ];
  for (const r of bad) {
    if (r.status === 'tampered') {
      parts.push(`### ${r.flow.title}\nThis flow was modified without human approval. Restore it (git checkout -- ${r.flow.path}); changing what is tested is never a fix.\n`);
      continue;
    }
    if (r.regression) parts.push(`**Regression:** this flow guards ${r.bug?.id}, which was fixed before and is back.`);
    parts.push(failureBrief(project, r.flow, r.run!));
    parts.push('');
  }
  parts.push(...waiting);
  return parts.join('\n');
}

export function guardMarkdown(project: Project, report: GuardReport): string {
  const icon = (s: string) => ({ passed: '✅', failed: '❌', flaky: '🟡', error: '⚠️', tampered: '⛔', unmerged: '⏳' })[s] ?? '•';
  const lines = [
    `## 👹 Gremlin Guard: ${report.blocking ? 'blocked' : 'passed'}`,
    '',
    `${report.results.length} flows replayed by Kane CLI · ${report.reason} · ${report.credits} credits · ${report.durationS}s`,
    '',
    '| | Flow | Type | Result |',
    '| --- | --- | --- | --- |',
    ...report.results.map(
      (r) =>
        `| ${icon(r.status)} | ${r.flow.title} | ${r.flow.type} | ${r.run ? describeRun(r.run).replace(/\|/g, '\\|') : r.status}${r.regression ? ' **(regression)**' : ''}${r.status === 'unmerged' ? ` **(not a regression: ${unmergedFix(r.bug!)})**` : ''}${kaneShareLink(r.run?.kane) ? ` · [evidence](${kaneShareLink(r.run?.kane)})` : ''} |`,
    ),
  ];
  return lines.join('\n') + '\n';
}

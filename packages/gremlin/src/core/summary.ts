import type { Project } from './config.ts';
import { listFlows, type Flow } from './flow.ts';
import { listBugs, listRuns, readLedger, readLock, readStats, stability, tamperedFlows, type BugRecord, type RunRecord } from './store.ts';
import { round, todayKey } from './util.ts';

export interface FlowView extends Omit<Flow, 'path'> {
  file: string;
  stability: number | null;
  last?: string;
  lastRunAt?: string;
  lastRunId?: string;
  runs: number;
  locked: boolean;
  tampered: boolean;
}

export interface Summary {
  app: { name: string; url: string; agent: string; mode: string };
  counts: {
    flows: Record<string, number>;
    bugsFound: number;
    bugsFixed: number;
    open: number;
    escalated: number;
    regressionsCaught: number;
    flaky: number;
    quarantined: number;
    byOrigin: Record<string, { found: number; fixed: number }>;
  };
  credits: { today: number; week: number; total: number; perBugFound: number | null; perBugFixed: number | null; budget: Project['config']['budget'] };
  timeline: { day: string; found: number; fixed: number; runs: number; credits: number }[];
}

export function flowViews(project: Project): FlowView[] {
  const stats = readStats(project.paths);
  const lock = readLock(project.paths);
  const flows = listFlows(project.paths);
  const tampered = new Set(tamperedFlows(project.paths, flows).map((f) => f.id));
  return flows.map(({ path, ...f }) => {
    const s = stats.flows[f.id];
    return {
      ...f,
      file: path.replace(project.root + '/', ''),
      stability: stability(s),
      last: s?.last,
      lastRunAt: s?.lastRunAt,
      lastRunId: s?.lastRunId,
      runs: s?.runs ?? 0,
      locked: Boolean(lock.flows[f.id]),
      tampered: tampered.has(f.id),
    };
  });
}

export function summarize(project: Project, bugs: BugRecord[] = listBugs(project.paths), runs: RunRecord[] = listRuns(project.paths, 1000)): Summary {
  const flows = listFlows(project.paths);
  const ledger = readLedger(project.paths);
  const today = todayKey();
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const real = bugs.filter((b) => !['cant-reproduce', 'rejected'].includes(b.status));
  const fixed = real.filter((b) => b.status === 'fixed');
  const total = ledger.reduce((s, e) => s + e.credits, 0);
  const byOrigin: Summary['counts']['byOrigin'] = {};
  for (const b of real) {
    const o = (byOrigin[b.origin] ??= { found: 0, fixed: 0 });
    o.found++;
    if (b.status === 'fixed') o.fixed++;
  }

  const days = new Map<string, { day: string; found: number; fixed: number; runs: number; credits: number }>();
  for (let i = 13; i >= 0; i--) {
    const d = todayKey(new Date(Date.now() - i * 86400_000));
    days.set(d, { day: d, found: 0, fixed: 0, runs: 0, credits: 0 });
  }
  for (const b of real) {
    days.get(b.createdAt.slice(0, 10)) && days.get(b.createdAt.slice(0, 10))!.found++;
    if (b.fixedAt && days.get(b.fixedAt.slice(0, 10))) days.get(b.fixedAt.slice(0, 10))!.fixed++;
  }
  for (const r of runs) if (days.get(r.startedAt.slice(0, 10))) days.get(r.startedAt.slice(0, 10))!.runs++;
  for (const e of ledger) if (days.get(e.ts.slice(0, 10))) days.get(e.ts.slice(0, 10))!.credits += e.credits;

  const flowCounts: Record<string, number> = { happy: 0, adversarial: 0, regression: 0 };
  for (const f of flows) flowCounts[f.type]++;
  const regressionsCaught = runs.filter(
    (r) => r.purpose === 'guard' && r.status === 'failed' && (r.flowType === 'regression' || bugs.some((b) => b.flowId === r.flowId && b.runs.includes(r.id) && b.attempts.length)),
  ).length;

  return {
    app: { name: project.config.app.name, url: project.config.app.url, agent: project.config.agent.name, mode: project.config.loop.mode },
    counts: {
      flows: flowCounts,
      bugsFound: real.length,
      bugsFixed: fixed.length,
      open: real.filter((b) => ['candidate', 'confirmed', 'fixing'].includes(b.status)).length,
      escalated: real.filter((b) => b.status === 'escalated').length,
      regressionsCaught,
      flaky: runs.filter((r) => r.status === 'flaky').length,
      quarantined: flows.filter((f) => f.status === 'quarantined').length,
      byOrigin,
    },
    credits: {
      today: round(ledger.filter((e) => e.ts.startsWith(today)).reduce((s, e) => s + e.credits, 0)),
      week: round(ledger.filter((e) => e.ts >= weekAgo).reduce((s, e) => s + e.credits, 0)),
      total: round(total),
      perBugFound: real.length ? round(total / real.length) : null,
      perBugFixed: fixed.length ? round(total / fixed.length) : null,
      budget: project.config.budget,
    },
    timeline: [...days.values()].map((d) => ({ ...d, credits: round(d.credits) })),
  };
}

export function weeklyMarkdown(project: Project): string {
  const s = summarize(project);
  const bugs = listBugs(project.paths);
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const newBugs = bugs.filter((b) => b.createdAt >= weekAgo && !['cant-reproduce', 'rejected'].includes(b.status));
  const fixedBugs = bugs.filter((b) => b.fixedAt && b.fixedAt >= weekAgo);
  const flaky = flowViews(project).filter((f) => (f.stability ?? 100) < 90 || f.status === 'quarantined');
  return [
    `# Gremlin weekly: ${s.app.name}`,
    '',
    `- **New bugs:** ${newBugs.length} (${newBugs.filter((b) => b.origin === 'breaker').length} by Breaker, ${newBugs.filter((b) => b.origin === 'capture').length} from reports, ${newBugs.filter((b) => b.origin === 'guard').length} by Guard)`,
    `- **Fixed and proven by Kane:** ${fixedBugs.length}`,
    `- **Regressions caught before merge:** ${s.counts.regressionsCaught}`,
    `- **Flaky or quarantined flows:** ${flaky.length}`,
    `- **Kane credits:** ${s.credits.week} this week · ${s.credits.perBugFound ?? '–'} per bug found · ${s.credits.perBugFixed ?? '–'} per bug fixed`,
    `- **Library:** ${s.counts.flows.happy} happy · ${s.counts.flows.adversarial} adversarial · ${s.counts.flows.regression} regression`,
    '',
    newBugs.length ? '## New bugs' : '',
    ...newBugs.map((b) => `- ${b.id} [${b.severity}] ${b.title}: ${b.status}`),
    flaky.length ? '\n## Flows needing attention' : '',
    ...flaky.map((f) => `- ${f.title}: ${f.status === 'quarantined' ? 'quarantined' : `${f.stability}% stable`}`),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgent, extractJson } from './agent.ts';
import { ATTACKS, type AttackCategory, type AttackFlow } from './attacks.ts';
import type { Project } from './config.ts';
import { mapProduct, type ProductMap } from './discover.ts';
import { brokenContract, listFlows, lintFlow, saveFlow, updateFlowMeta, type Flow } from './flow.ts';
import { flowSafetyIssues, GuardrailError } from './guardrails.ts';
import { endJob, startJob, type Job } from './jobs.ts';
import { isAutomationFault } from './kane.ts';
import { ensureDir } from './paths.ts';
import { redactText } from './redact.ts';
import { FLOW_RULES, reviseFlow, shouldRevise } from './revise.ts';
import { findDuplicateBug } from './dedupe.ts';
import { describeRun, runFlow, silentReporter, type Reporter } from './runner.ts';
import { scoreConfidence, scoreSeverity, SEVERITY_ORDER } from './severity.ts';
import {
  emit,
  lockFlow,
  nextBugId,
  readStats,
  recordAttack,
  saveBug,
  type BugRecord,
  type RunRecord,
} from './store.ts';
import { ensureApp, isReachable } from './target.ts';
import { nowIso, round, truncate } from './util.ts';

export interface PlannedAttack extends AttackFlow {
  attack: string;
  category: AttackCategory | 'custom';
  why?: string;
  score: number;
  origin: 'catalog' | 'agent';
}

export interface Finding {
  flow: Flow;
  run: RunRecord;
  outcome: 'bug' | 'duplicate' | 'held' | 'flaky' | 'noise' | 'disputed' | 'error';
  bug?: BugRecord;
  /** Set when Kane blamed the flow but the agent argues the product is at fault. */
  dispute?: string;
}

export interface BreakerReport {
  job: Job;
  map: ProductMap;
  planned: PlannedAttack[];
  findings: Finding[];
  credits: number;
  reportPath?: string;
}

export interface BreakerOptions {
  areas?: string[];
  categories?: AttackCategory[];
  max?: number;
  useAgent?: boolean;
  dryRun?: boolean;
  reporter?: Reporter;
}

/** Learned value of an attack on this product: Laplace-smoothed hit rate, seeded by the catalog prior. */
function learnedScore(project: Project, attackId: string, prior: number): number {
  const a = readStats(project.paths).attacks[attackId];
  if (!a) return prior;
  return (a.found + prior * 2) / (a.tried + 2);
}

export function planAttacks(project: Project, map: ProductMap, opts: BreakerOptions): PlannedAttack[] {
  const cfg = project.config.breaker;
  const categories = new Set(opts.categories?.length ? opts.categories : cfg.categories);
  const scope = (opts.areas?.length ? opts.areas : cfg.scope).map((s) => s.toLowerCase());
  const avoid = cfg.avoid.map((s) => s.toLowerCase());
  const planned: PlannedAttack[] = [];
  for (const j of map.journeys) {
    const name = `${j.key} ${j.name} ${j.start}`.toLowerCase();
    if (scope.length && !scope.some((s) => name.includes(s))) continue;
    if (avoid.some((s) => name.includes(s))) continue;
    for (const atk of ATTACKS) {
      if (!categories.has(atk.category) || !atk.applies(j)) continue;
      planned.push({ ...atk.build(j), attack: atk.id, category: atk.category, score: learnedScore(project, atk.id, atk.prior), origin: 'catalog' });
    }
  }
  return planned;
}

interface AgentFlow {
  title: string;
  start?: string;
  steps: string[];
  expect: string[];
  tags?: string[];
  attack?: string;
  why?: string;
}

export async function agentAttacks(project: Project, map: ProductMap, max: number): Promise<PlannedAttack[]> {
  const agent = getAgent(project.config);
  if (!agent || !agent.available()) return [];
  const prompt = [
    'You are the Breaker in Gremlin, an adversarial QA loop. Read this repository and invent hostile but realistic user journeys that are likely to expose real bugs in the running app.',
    `The app runs at ${project.config.app.url}. Product map (discovered by crawling and scanning routes):`,
    '```json',
    JSON.stringify({ stack: map.stack, routes: map.routes.slice(0, 40), journeys: map.journeys }, null, 1).slice(0, 6000),
    '```',
    'Attack categories: input abuse (empty, very long, emoji, RTL, leading spaces, pasted formatting), timing (double-submit, rapid clicks), navigation (back mid-flow, refresh, deep links), state (expired session, stale data), accessibility (keyboard only, missing labels).',
    'Look at the code for weaknesses: missing validation, missing idempotency, unsafe parsing, numbers that can go negative, state kept only in memory, error paths without handling.',
    '',
    `Return ONLY a JSON array of at most ${max} flows, most likely to find a real bug first. Each flow:`,
    '{"title": "what the flow proves, one line", "start": "/path", "steps": ["plain English steps a user would say"], "expect": ["what must be true at the end"], "tags": ["area", "category"], "attack": "category.short-name", "why": "the weakness in the code you suspect, citing the file"}',
    'Rules: titles are short (under 70 characters). Expectations describe the CORRECT behaviour, so the flow fails if the bug exists. Never involve real money, real emails or production.',
    FLOW_RULES,
  ].join('\n');
  const res = await agent.ask(prompt, project.root);
  if (!res.ok) return [];
  const flows = extractJson<AgentFlow[]>(res.output) ?? [];
  return flows
    .filter((f) => f && f.title && Array.isArray(f.steps) && f.steps.length && Array.isArray(f.expect) && f.expect.length)
    .filter((f) => !lintFlow({ title: f.title, steps: f.steps, expect: f.expect }).some((i) => i.level === 'error'))
    .filter((f) => !flowSafetyIssues({ title: f.title, steps: f.steps, expect: f.expect }).length)
    .slice(0, max)
    .map((f) => {
      const attack = f.attack ?? 'custom.agent';
      const category = (attack.split('.')[0] as AttackCategory) ?? 'custom';
      return {
        title: f.title,
        start: f.start ?? '/',
        steps: f.steps.map(String),
        expect: f.expect.map(String),
        tags: (f.tags ?? []).map((t) => String(t).toLowerCase()),
        attack,
        category,
        why: f.why,
        // product-specific ideas grounded in the code rank above generic templates
        score: learnedScore(project, attack, 0.55),
        origin: 'agent' as const,
      };
    });
}

/** Pick a diverse, high-value set: best score first, but no more than two per attack type. */
export function selectAttacks(candidates: PlannedAttack[], max: number): PlannedAttack[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const picked: PlannedAttack[] = [];
  const perAttack = new Map<string, number>();
  const seen = new Set<string>();
  for (const c of sorted) {
    const key = c.title.toLowerCase();
    if (seen.has(key)) continue;
    const n = perAttack.get(c.attack) ?? 0;
    if (n >= 2) continue;
    picked.push(c);
    seen.add(key);
    perAttack.set(c.attack, n + 1);
    if (picked.length >= max) break;
  }
  return picked;
}

export async function runBreaker(project: Project, opts: BreakerOptions = {}): Promise<BreakerReport> {
  const reporter = opts.reporter ?? silentReporter;
  const { paths, config } = project;
  const max = opts.max ?? config.breaker.max_flows;
  const job = startJob(paths, 'break', `Breaker hunt (up to ${max} attacks)`);
  const app = opts.dryRun && !(await isReachable(config.app.url)) ? { stop() {}, startedByGremlin: false } : await ensureApp(project, reporter.info);
  try {
    reporter.info(`Mapping ${config.app.url} …`);
    const map = await mapProduct(project.root, config.app.url, await isReachable(config.app.url));
    emit(paths, 'info', `Mapped ${map.pages.length} pages, ${map.journeys.length} journeys: ${map.journeys.map((j) => j.name).join(', ')}`, { journeys: map.journeys.map((j) => j.key) }, job.id);
    reporter.info(`Found ${map.journeys.length} journeys: ${map.journeys.map((j) => j.name).join(', ') || 'none'}`);

    let candidates = planAttacks(project, map, opts);
    if (opts.useAgent !== false) {
      reporter.info('Asking your coding agent for product-specific attacks …');
      emit(paths, 'agent', 'Asking the coding agent for product-specific attacks', {}, job.id);
      const fromAgent = await agentAttacks(project, map, Math.ceil(max / 2) + 1);
      if (fromAgent.length) reporter.info(`Agent proposed ${fromAgent.length} attacks`);
      candidates = [...fromAgent, ...candidates];
    }
    // skip attacks already in the library
    const existing = listFlows(paths);
    const known = new Set(existing.map((f) => f.title.toLowerCase()));
    const planned = selectAttacks(candidates.filter((c) => !known.has(c.title.toLowerCase())), max);
    emit(paths, 'info', `Planned ${planned.length} attacks`, { planned: planned.map((p) => ({ title: p.title, attack: p.attack, origin: p.origin })) }, job.id);

    const report: BreakerReport = { job, map, planned, findings: [], credits: 0 };
    if (opts.dryRun) {
      endJob(paths, job, 'done', `Planned ${planned.length} attacks (dry run)`);
      return report;
    }

    for (const p of planned) {
      if (report.credits >= config.budget.per_run) {
        reporter.warn(`Run budget reached (${round(report.credits)} / ${config.budget.per_run} credits); stopping the hunt.`);
        emit(paths, 'warn', 'Run budget reached; stopping the hunt', {}, job.id);
        break;
      }
      let flow = saveFlow(paths, {
        title: p.title,
        type: 'adversarial',
        start: p.start,
        source: 'breaker',
        status: 'draft',
        tags: [...new Set(p.tags)],
        attack: p.attack,
        steps: p.steps,
        expect: p.expect,
        notes: p.why ? `Breaker's suspicion: ${p.why}` : undefined,
      });
      reporter.info(`\n⚔ ${flow.title}`);
      let run: RunRecord;
      try {
        run = await runFlow(project, flow, { purpose: 'breaker', job: job.id, reporter });
      } catch (err) {
        if (err instanceof GuardrailError && err.rule === 'budget') {
          reporter.warn(err.message);
          break;
        }
        throw err;
      }
      report.credits += run.credits;
      reporter.info(`  → ${describeRun(run)}`);
      let dispute: string | undefined;
      if (shouldRevise(flow, run) && report.credits < config.budget.per_run) {
        reporter.info('  Kane blamed the flow, not the product: asking the agent to revise it once …');
        const revision = await reviseFlow(project, flow, run, job.id);
        if (revision) {
          flow = revision.flow;
          dispute = revision.dispute;
          flow.steps.forEach((s, i) => reporter.info(`    ${i + 1}. ${s}`));
          reporter.info(`    Expect: ${flow.expect.join(' · ')}`);
          if (dispute) reporter.info(`    The agent disputes Kane's triage: ${dispute}`);
          run = await runFlow(project, flow, { purpose: 'breaker', job: job.id, reporter });
          report.credits += run.credits;
          reporter.info(`  → ${describeRun(run)}`);
        }
      }
      report.findings.push(triageFinding(project, flow, run, p, job, dispute));
    }

    report.findings.sort((a, b) => rank(b) - rank(a));
    report.reportPath = writeBreakerReport(project, report);
    const bugs = report.findings.filter((f) => f.outcome === 'bug').length;
    const dupes = report.findings.filter((f) => f.outcome === 'duplicate').length;
    endJob(paths, job, bugs ? 'failed' : 'passed', `${bugs} bug${bugs === 1 ? '' : 's'} found in ${report.findings.length} attacks${dupes ? ` (${dupes} more hit a bug already found)` : ''}`, {
      bugs,
      credits: round(report.credits, 2),
    });
    return report;
  } catch (err) {
    endJob(paths, job, 'error', (err as Error).message);
    throw err;
  } finally {
    app.stop();
  }
}

function rank(f: Finding): number {
  if (f.outcome !== 'bug' || !f.bug) return f.outcome === 'noise' ? -1 : -2;
  return SEVERITY_ORDER.indexOf(f.bug.severity) * 10 + f.bug.confidence;
}

function triageFinding(project: Project, flow: Flow, run: RunRecord, p: PlannedAttack, job: Job, dispute?: string): Finding {
  const { paths } = project;
  if (run.status === 'passed') {
    // the app held: keep the attack as a guard against future breakage
    const active = updateFlowMeta(flow, { status: 'active' });
    lockFlow(paths, active, 'breaker');
    recordAttack(paths, p.attack, false);
    return { flow: active, run, outcome: 'held' };
  }
  if (run.status === 'flaky') {
    recordAttack(paths, p.attack, false);
    return { flow, run, outcome: 'flaky' };
  }
  if (run.status === 'error') return { flow, run, outcome: 'error' };
  if (isAutomationFault(run.kane?.verdict)) {
    // Kane says the attack itself was at fault, not the product: don't cry wolf
    recordAttack(paths, p.attack, false);
    if (dispute) {
      // Kane's verdict stands (nothing is filed), but a disagreement with the agent is for a human to settle
      emit(paths, 'warn', `Kane and the agent disagree about "${flow.title}": Kane blamed the flow, the agent says the product is at fault. A human should decide.`, { runId: run.id, flowId: flow.id, dispute }, job.id);
      return { flow, run, outcome: 'disputed', dispute };
    }
    emit(paths, 'info', `Kane judged "${flow.title}" an automation problem, not a product bug; held for review`, { runId: run.id }, job.id);
    return { flow, run, outcome: 'noise' };
  }
  recordAttack(paths, p.attack, true);
  const title = bugTitle(flow, run);
  const same = findDuplicateBug(paths, run, title);
  if (same) {
    // another attack tripped a bug we already have: corroborating evidence, not a new bug
    same.runs.push(run.id);
    same.confidence = Math.min(0.99, Math.max(same.confidence, scoreConfidence(run)) + 0.02);
    same.credits += run.credits;
    same.updatedAt = nowIso();
    saveBug(paths, same);
    updateFlowMeta(flow, { bug: same.id, status: 'confirmed', fail_first: run.id });
    emit(paths, 'bug', `Same bug as ${same.id}, reproduced by a second attack: ${flow.title}`, { bugId: same.id, duplicate: true, runId: run.id }, job.id);
    return { flow, run, outcome: 'duplicate', bug: same };
  }
  const bug: BugRecord = {
    id: nextBugId(paths),
    title,
    origin: 'breaker',
    status: 'candidate',
    severity: scoreSeverity(run, { attack: p.attack, tags: flow.tags }),
    confidence: scoreConfidence(run),
    flowId: flow.id,
    attack: p.attack,
    tags: flow.tags,
    failingStep: run.kane?.failedStep?.heading,
    contract: brokenContract(flow, project.config, { heading: run.kane?.failedStep?.heading, reason: run.kane?.reason }),
    reason: run.kane?.reason,
    verdict: run.kane?.verdict,
    runs: [run.id],
    attempts: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    credits: run.credits,
  };
  saveBug(paths, bug);
  updateFlowMeta(flow, { bug: bug.id, status: 'confirmed', fail_first: run.id });
  emit(paths, 'bug', `${bug.id}: ${bug.title}`, { bugId: bug.id, severity: bug.severity, confidence: bug.confidence, origin: 'breaker', status: bug.status }, job.id);
  return { flow, run, outcome: 'bug', bug };
}

export function bugTitle(flow: Flow, run: RunRecord): string {
  const v = run.kane?.verdict;
  if (v?.title && !/^(test|automation)/i.test(v.title)) return truncate(redactText(v.title), 100);
  return truncate(flow.title, 100);
}

function writeBreakerReport(project: Project, r: BreakerReport): string {
  const dir = ensureDir(project.paths.reports);
  const path = join(dir, `breaker-${r.job.startedAt.replace(/[:.]/g, '-')}.md`);
  const lines = [
    `# Breaker report: ${project.config.app.name}`,
    '',
    `${r.findings.length} attacks · ${r.findings.filter((f) => f.outcome === 'bug').length} bugs · ${round(r.credits)} Kane credits`,
    '',
    '| Rank | Bug | Severity | Confidence | Attack | Flow | Kane verdict |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.findings
      .filter((f) => f.outcome === 'bug')
      .map((f, i) => `| ${i + 1} | ${f.bug!.id} ${f.bug!.title} | ${f.bug!.severity} | ${Math.round(f.bug!.confidence * 100)}% | ${f.bug!.attack} | ${f.flow.id} | ${f.run.kane?.reason ?? ''} |`),
    '',
    ...(r.findings.some((f) => f.outcome === 'duplicate')
      ? ['## Same bug, found again', ...r.findings.filter((f) => f.outcome === 'duplicate').map((f) => `- ${f.flow.title}: reproduced ${f.bug!.id}`), '']
      : []),
    ...(r.findings.some((f) => f.outcome === 'disputed')
      ? [
          '## Disputed (Kane blamed the flow, the agent blames the product: a human decides)',
          ...r.findings
            .filter((f) => f.outcome === 'disputed')
            .map((f) => `- ${f.flow.id}: ${f.flow.title}\n  - Kane: ${f.run.kane?.verdict?.oneLiner ?? f.run.kane?.reason ?? ''}\n  - Agent: ${f.dispute}`),
          '',
        ]
      : []),
    '## Held (the app handled the attack; saved as adversarial guards)',
    ...r.findings.filter((f) => f.outcome === 'held').map((f) => `- ${f.flow.title}`),
    '',
    '## Needs review',
    ...r.findings
      .filter((f) => f.outcome === 'noise' || f.outcome === 'flaky' || f.outcome === 'error')
      .map((f) => `- ${f.flow.title}: ${f.outcome}${f.run.kane?.verdict?.oneLiner ? ` (${f.run.kane.verdict.oneLiner})` : ''}`),
    '',
    'Approve a fix with `gremlin fix <BUG-id>`, or from the dashboard.',
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

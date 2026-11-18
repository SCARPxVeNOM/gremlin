import { writeFileSync, readFileSync } from 'node:fs';
import { extractJson, getAgent } from './agent.ts';
import type { Project } from './config.ts';
import { lintFlow, parseFlow, serializeFlow, type Flow } from './flow.ts';
import { flowSafetyIssues } from './guardrails.ts';
import { isAutomationFault } from './kane.ts';
import type { RunRecord } from './store.ts';
import { emit } from './store.ts';

/** Rules every drafted flow must follow so Kane can execute and judge it. */
export const FLOW_RULES = [
  'Write steps the way a user would say them, using the visible labels. No CSS selectors, ids, XPath or code.',
  'Kane checks every expectation once, at the end, on the page the last step leaves the user on. Every expectation must be visible there, so stop the steps at the moment you want to check.',
  'One flow tests one thing. Use test values (a @example.test email), never real personal data, real money or real messages.',
].join('\n');

/** Kane failed a draft flow and blamed the flow, not the product: the agent gets one chance to rewrite it. */
export function shouldRevise(flow: Flow, run: RunRecord): boolean {
  return flow.status === 'draft' && run.status === 'failed' && isAutomationFault(run.kane?.verdict);
}

/**
 * Close the loop on the tests themselves: hand Kane's triage back to the agent that drafted the flow,
 * and let it rewrite the steps and expectations once. Returns the revised flow, or undefined if the agent
 * couldn't produce a valid revision.
 */
export async function reviseFlow(project: Project, flow: Flow, run: RunRecord, job?: string): Promise<Flow | undefined> {
  const agent = getAgent(project.config);
  if (!agent || !agent.available()) return undefined;
  const v = run.kane?.verdict;
  const prompt = [
    'You drafted this user flow for Gremlin. Kane CLI ran it in a real browser and it failed, but Kane judged the failure to be a problem with the flow itself, not with the product.',
    '```markdown',
    `# ${flow.title}`,
    `Starts at ${flow.start}`,
    '',
    ...flow.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    'Expect:',
    ...flow.expect.map((e) => `- ${e}`),
    '```',
    `Kane failed it at "${run.kane?.failedStep?.heading ?? 'unknown step'}": ${run.kane?.reason ?? 'no reason given'}`,
    v ? `Kane's triage (${[v.family, v.category].filter(Boolean).join('/')}): ${v.rootCause ?? v.oneLiner ?? v.title ?? ''}` : '',
    run.evidence?.failure?.pageUrl ? `The browser was on ${run.evidence.failure.pageUrl} when it failed.` : '',
    '',
    'Rewrite the steps and expectations so Kane can execute and check them. Keep the intent: the flow must test the same behaviour, and if the product has the bug, the revised flow must still fail.',
    FLOW_RULES,
    'Return ONLY a JSON object: {"steps": ["..."], "expect": ["..."], "change": "one sentence: what you changed and why"}',
  ]
    .filter(Boolean)
    .join('\n');

  emit(project.paths, 'agent', `Kane blamed the flow, not the product; asking ${agent.label} to revise "${flow.title}"`, { flowId: flow.id, runId: run.id }, job);
  const res = await agent.ask(prompt, project.root);
  if (!res.ok) return undefined;
  const out = extractJson<{ steps?: unknown[]; expect?: unknown[]; change?: string }>(res.output);
  if (!out || !Array.isArray(out.steps) || !Array.isArray(out.expect) || !out.steps.length || !out.expect.length) return undefined;
  const steps = out.steps.map(String);
  const expect = out.expect.map(String);
  const draft = { title: flow.title, steps, expect };
  if (lintFlow(draft).some((i) => i.level === 'error') || flowSafetyIssues(draft).length) return undefined;
  if (JSON.stringify(steps) === JSON.stringify(flow.steps) && JSON.stringify(expect) === JSON.stringify(flow.expect)) return undefined;

  const note = `Revised after Kane's triage of ${run.id}: ${out.change ?? 'rewrote the steps so Kane can check them'}`;
  const text = serializeFlow({ ...flow, steps, expect, notes: [flow.notes, note].filter(Boolean).join('\n\n') });
  writeFileSync(flow.path, text);
  const revised = parseFlow(readFileSync(flow.path, 'utf8'), flow.path, flow.id);
  emit(project.paths, 'agent', note, { flowId: flow.id, steps, expect }, job);
  return revised;
}

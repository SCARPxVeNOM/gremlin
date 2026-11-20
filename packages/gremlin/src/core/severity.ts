import { isAutomationFault } from './kane.ts';
import type { RunRecord, Severity } from './store.ts';

const KANE_SEVERITY: Record<string, Severity> = {
  blocker: 'critical',
  critical: 'critical',
  major: 'high',
  high: 'high',
  moderate: 'medium',
  medium: 'medium',
  minor: 'medium',
  low: 'low',
  trivial: 'low',
  cosmetic: 'low',
};

const RANK: Severity[] = ['low', 'medium', 'high', 'critical'];
const max = (a: Severity, b: Severity) => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);

/**
 * Severity combines Kane's own triage with what the failure touched:
 * server errors and money or data-integrity attacks rank higher than cosmetic ones.
 */
export function scoreSeverity(run: RunRecord, ctx: { attack?: string; tags?: string[] } = {}): Severity {
  let s: Severity = 'medium';
  const v = run.kane?.verdict;
  if (v?.severity && KANE_SEVERITY[v.severity.toLowerCase()]) s = KANE_SEVERITY[v.severity.toLowerCase()];
  const tags = ctx.tags ?? [];
  const serverError = run.evidence?.networkFailures.some((n) => n.status >= 500);
  const crashText = /something went wrong|internal server error|stack trace|exception|500/i.test(
    `${run.kane?.reason ?? ''} ${run.kane?.summary ?? ''} ${run.evidence?.failure?.rootCause ?? ''}`,
  );
  if (serverError || crashText) s = max(s, 'high');
  if (tags.includes('money') || ctx.attack === 'timing.double-submit' || ctx.attack === 'input.negative') s = max(s, 'high');
  if ((tags.includes('money') || tags.includes('checkout')) && (serverError || ctx.attack === 'timing.double-submit')) s = 'critical';
  if (ctx.attack?.startsWith('accessibility')) s = s === 'critical' ? 'high' : s;
  return s;
}

/** How sure Gremlin is that a failure is a real product bug (0..1). */
export function scoreConfidence(run: RunRecord): number {
  const v = run.kane?.verdict;
  if (isAutomationFault(v)) return Math.min(0.3, 1 - (v?.confidence ?? 0.7));
  let c = run.retry ? (run.retry.status === 'failed' ? 0.75 : 0.35) : 0.55;
  if (v?.confirmed) c = Math.max(c, v.confidence ?? 0.85);
  else if (v?.family && /product|application/i.test(v.family)) c = Math.max(c, (v.confidence ?? 0.7) * 0.95);
  if (run.evidence?.networkFailures.some((n) => n.status >= 500)) c = Math.min(0.99, c + 0.1);
  return Math.round(c * 100) / 100;
}

export const SEVERITY_ORDER = RANK;

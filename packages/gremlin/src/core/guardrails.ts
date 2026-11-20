import picomatch from 'picomatch';
import type { Project } from './config.ts';
import type { Flow } from './flow.ts';
import { redact } from './redact.ts';
import { creditsForBug, creditsToday } from './store.ts';
import { round } from './util.ts';

export class GuardrailError extends Error {
  rule: string;
  constructor(message: string, rule: string) {
    super(message);
    this.rule = rule;
  }
}

/** Paths no fixer may ever change: the tests themselves, their locks (lock.json is the older single-file lock) and Gremlin's own config. */
export const ALWAYS_PROTECTED = ['.gremlin/flows/**', '.gremlin/locks/**', '.gremlin/lock.json', 'gremlin.config.yaml'];

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|.*\.localhost|.*\.local|.*\.test)$/i;
const PREVIEW_HOST = /(preview|staging|stage|dev|test|qa|sandbox|uat|vercel\.app|netlify\.app|pages\.dev|ngrok|onrender\.com|fly\.dev|railway\.app)/i;

export function targetRisk(url: string): 'local' | 'preview' | 'unknown' {
  try {
    const host = new URL(url).hostname;
    if (LOCAL_HOST.test(host)) return 'local';
    if (PREVIEW_HOST.test(host)) return 'preview';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Never against production: refuse targets marked production, and unknown hosts not explicitly cleared. */
export function assertTargetSafe(project: Project): void {
  const { config, raw } = project;
  if (config.app.production) {
    throw new GuardrailError(`${config.app.url} is marked as production. Gremlin never runs against production.`, 'never-production');
  }
  const risk = targetRisk(config.app.url);
  const explicitlyCleared = (raw as any)?.app?.production === false;
  if (risk === 'unknown' && !explicitlyCleared) {
    throw new GuardrailError(
      `${config.app.url} doesn't look like a local or preview target. If it is a test environment, set \`app.production: false\` in gremlin.config.yaml to confirm.`,
      'never-production',
    );
  }
}

const UNSAFE_FLOW: [RegExp, string][] = [
  [/\breal\s+(money|card|credit card|payment|bank|wallet)\b/i, 'uses real money'],
  [/\b(live|production)\s+(mode|keys?|payment|card)\b/i, 'uses live payment mode'],
  [/\b(wire|transfer|withdraw)\s+(money|funds|\$|₹|€|£)/i, 'moves real money'],
  [/\bmainnet\b/i, 'touches a mainnet wallet'],
];

export function flowSafetyIssues(flow: Pick<Flow, 'steps' | 'expect' | 'title'>): string[] {
  const text = [flow.title, ...flow.steps, ...flow.expect].join('\n');
  const issues: string[] = [];
  for (const [re, why] of UNSAFE_FLOW) if (re.test(text)) issues.push(why);
  const r = redact(text, { keepEmails: /@(example\.(com|org|net)|[\w-]+\.test|[\w-]+\.local|[\w-]+\.localhost)$/i });
  if (r.found.card) issues.push('contains a real-looking card number (use a published test card)');
  if (r.found.email && /\b(send|email|message|invite|notify)\b/i.test(text)) issues.push('would send a message to a real email address');
  return issues;
}

export function assertFlowSafe(flow: Flow): void {
  const issues = flowSafetyIssues(flow);
  if (issues.length) {
    throw new GuardrailError(`Refusing to run "${flow.title}": it ${issues.join('; ')}.`, 'no-real-side-effects');
  }
}

export function protectedMatcher(project: Project): (file: string) => boolean {
  const globs = [...ALWAYS_PROTECTED, ...project.config.protected_paths];
  const isMatch = picomatch(globs, { dot: true });
  return (file: string) => isMatch(file.replace(/^\.\//, ''));
}

export function assertBudget(project: Project, opts: { bugId?: string; planned?: number } = {}): void {
  const { budget } = project.config;
  const today = creditsToday(project.paths);
  if (today >= budget.per_day) {
    throw new GuardrailError(`Daily Kane budget reached (${round(today)} / ${budget.per_day} credits). Raise budget.per_day to continue.`, 'budget');
  }
  if (opts.bugId) {
    const spent = creditsForBug(project.paths, opts.bugId);
    if (spent >= budget.per_bug) {
      throw new GuardrailError(`${opts.bugId} has used its budget (${round(spent)} / ${budget.per_bug} credits).`, 'budget');
    }
  }
}

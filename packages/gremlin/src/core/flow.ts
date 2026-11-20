import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { resolveUrl, type GremlinConfig } from './config.ts';
import { ensureDir, FLOW_TYPES, type ProjectPaths } from './paths.ts';
import { sha256, slugify, nowIso } from './util.ts';

export type FlowType = (typeof FLOW_TYPES)[number];
export type FlowStatus = 'draft' | 'confirmed' | 'active' | 'quarantined' | 'retired';

export interface FlowMeta {
  title: string;
  type: FlowType;
  platforms: string[];
  start: string;
  account?: string;
  /** breaker | human | capture:<report-ref> | guard */
  source: string;
  status: FlowStatus;
  tags: string[];
  attack?: string;
  bug?: string;
  /** Run that proved this regression flow fails against the bug (the fail-first rule). */
  fail_first?: string;
  created?: string;
}

export interface Flow extends FlowMeta {
  /** e.g. "adversarial/double-submit-place-order" */
  id: string;
  path: string;
  steps: string[];
  expect: string[];
  notes: string;
  /** Hash of what the flow tests. Used to detect anyone editing a flow to make it pass. */
  hash: string;
}

export interface FlowDraft {
  title: string;
  type: FlowType;
  start?: string;
  account?: string;
  source: string;
  status?: FlowStatus;
  tags?: string[];
  attack?: string;
  bug?: string;
  steps: string[];
  expect: string[];
  notes?: string;
  platforms?: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function semanticHash(f: Pick<Flow, 'title' | 'start' | 'account' | 'steps' | 'expect'>): string {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return sha256(
    JSON.stringify({
      title: norm(f.title),
      start: f.start ?? '',
      account: f.account ?? '',
      steps: f.steps.map(norm),
      expect: f.expect.map(norm),
    }),
  ).slice(0, 16);
}

export function parseFlow(text: string, path: string, id: string): Flow {
  const m = FRONTMATTER.exec(text);
  const meta = (m ? YAML.parse(m[1]) : {}) ?? {};
  const body = m ? text.slice(m[0].length) : text;

  const steps: string[] = [];
  const expect: string[] = [];
  const notes: string[] = [];
  let section: 'steps' | 'expect' | 'notes' = 'steps';

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      const h = heading[1].toLowerCase();
      if (/^(expect|expected|expectations|then|outcome)/.test(h)) section = 'expect';
      else if (/^(notes?|context|report)/.test(h)) section = 'notes';
      else if (/^steps?/.test(h)) section = 'steps';
      continue;
    }
    if (!line.trim()) continue;
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (section === 'steps') {
      if (numbered) steps.push(numbered[1].trim());
      else if (bullet) steps.push(bullet[1].trim());
      else if (steps.length) steps[steps.length - 1] += ' ' + line.trim();
      else notes.push(line);
    } else if (section === 'expect') {
      if (numbered || bullet) expect.push((numbered ?? bullet)![1].trim());
      else if (expect.length) expect[expect.length - 1] += ' ' + line.trim();
      else expect.push(line.trim());
    } else {
      notes.push(line);
    }
  }

  const flow: Flow = {
    id,
    path,
    title: String(meta.title ?? id),
    type: (FLOW_TYPES as readonly string[]).includes(meta.type) ? meta.type : 'happy',
    platforms: toList(meta.platforms, ['web']),
    start: String(meta.start ?? '/'),
    account: meta.account ? String(meta.account) : undefined,
    source: String(meta.source ?? 'human'),
    status: (meta.status ?? 'draft') as FlowStatus,
    tags: toList(meta.tags, []).map((t) => t.toLowerCase()),
    attack: meta.attack ? String(meta.attack) : undefined,
    bug: meta.bug ? String(meta.bug) : undefined,
    fail_first: meta.fail_first ? String(meta.fail_first) : undefined,
    created: meta.created ? String(meta.created) : undefined,
    steps,
    expect,
    notes: notes.join('\n').trim(),
    hash: '',
  };
  flow.hash = semanticHash(flow);
  return flow;
}

function toList(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return fallback;
}

export function serializeFlow(f: FlowMeta & { steps: string[]; expect: string[]; notes?: string }): string {
  const meta: Record<string, unknown> = {
    title: f.title,
    type: f.type,
    platforms: f.platforms,
    start: f.start,
  };
  if (f.account) meta.account = f.account;
  meta.source = f.source;
  meta.status = f.status;
  meta.tags = f.tags;
  if (f.attack) meta.attack = f.attack;
  if (f.bug) meta.bug = f.bug;
  if (f.fail_first) meta.fail_first = f.fail_first;
  meta.created = f.created ?? nowIso();

  const fm = YAML.stringify(meta, { flowCollectionPadding: false }).trimEnd();
  const steps = f.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const expect = f.expect.map((e) => `- ${e}`).join('\n');
  const notes = f.notes?.trim() ? `\n## Notes\n\n${f.notes.trim()}\n` : '';
  return `---\n${fm}\n---\n\n${steps}\n\n## Expect\n\n${expect}\n${notes}`;
}

// ---------------------------------------------------------------------------
// Library access

export function listFlows(paths: ProjectPaths): Flow[] {
  const out: Flow[] = [];
  for (const type of FLOW_TYPES) {
    const dir = join(paths.flows, type);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.md')) continue;
      const path = join(dir, file);
      const id = `${type}/${file.replace(/\.md$/, '')}`;
      out.push(parseFlow(readFileSync(path, 'utf8'), path, id));
    }
  }
  return out;
}

export function getFlow(paths: ProjectPaths, idOrSlug: string): Flow | undefined {
  const flows = listFlows(paths);
  return (
    flows.find((f) => f.id === idOrSlug) ??
    flows.find((f) => f.id.endsWith('/' + idOrSlug)) ??
    flows.find((f) => f.id.includes(idOrSlug))
  );
}

export function saveFlow(paths: ProjectPaths, draft: FlowDraft): Flow {
  const type = draft.type;
  const dir = ensureDir(join(paths.flows, type));
  let slug = slugify(draft.title);
  let n = 2;
  while (existsSync(join(dir, `${slug}.md`))) slug = `${slugify(draft.title, 54)}-${n++}`;
  const path = join(dir, `${slug}.md`);
  const meta: FlowMeta = {
    title: draft.title,
    type,
    platforms: draft.platforms ?? ['web'],
    start: draft.start ?? '/',
    account: draft.account,
    source: draft.source,
    status: draft.status ?? 'draft',
    tags: (draft.tags ?? []).map((t) => t.toLowerCase()),
    attack: draft.attack,
    bug: draft.bug,
    created: nowIso(),
  };
  // agents often number their steps or bullet their expectations; the flow format does that itself
  const steps = draft.steps.map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, ''));
  const expect = draft.expect.map((e) => e.replace(/^\s*[-*•]\s+/, ''));
  writeFileSync(path, serializeFlow({ ...meta, steps, expect, notes: draft.notes }));
  return parseFlow(readFileSync(path, 'utf8'), path, `${type}/${slug}`);
}

/** Rewrite only a flow's header (status, links). The body, and so the hash, never changes here. */
export function updateFlowMeta(flow: Flow, patch: Partial<FlowMeta>): Flow {
  const next = { ...flow, ...patch };
  writeFileSync(flow.path, serializeFlow(next));
  return parseFlow(readFileSync(flow.path, 'utf8'), flow.path, flow.id);
}

/** Move a flow to another library section (e.g. a confirmed Capture repro into regression/). */
export function moveFlow(paths: ProjectPaths, flow: Flow, type: FlowType, patch: Partial<FlowMeta> = {}): Flow {
  const saved = saveFlow(paths, {
    ...flow,
    ...patch,
    type,
    source: patch.source ?? flow.source,
    status: patch.status ?? flow.status,
  });
  if (saved.path !== flow.path) {
    // keep provenance fields that saveFlow doesn't take
    const final = updateFlowMeta(saved, { fail_first: patch.fail_first ?? flow.fail_first, created: flow.created });
    rmSync(flow.path, { force: true });
    return final;
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Lint: flows are human documents. Selectors mean the product needs better labels.

export interface FlowIssue {
  level: 'error' | 'warn';
  message: string;
}

const SELECTOR_PATTERNS: [RegExp, string][] = [
  [/(^|\s)[#.][a-z][\w-]*\b/i, 'CSS selector'],
  [/\bxpath\b|\/\/[a-z]+\[/i, 'XPath'],
  [/data-(testid|test|cy|qa)\b/i, 'test id attribute'],
  [/\b(getElementBy|querySelector|\$\()/i, 'code'],
  [/<\/?[a-z]+[^>]*>/i, 'HTML markup'],
];

export function lintFlow(f: Pick<Flow, 'title' | 'steps' | 'expect'>): FlowIssue[] {
  const issues: FlowIssue[] = [];
  if (!f.title.trim()) issues.push({ level: 'error', message: 'Flow needs a title.' });
  if (!f.steps.length) issues.push({ level: 'error', message: 'Flow has no numbered steps.' });
  if (!f.expect.length) issues.push({ level: 'error', message: 'Flow must end with explicit expectations (## Expect).' });
  for (const text of [...f.steps, ...f.expect]) {
    for (const [re, what] of SELECTOR_PATTERNS) {
      if (re.test(text)) {
        issues.push({
          level: 'warn',
          message: `"${text.slice(0, 60)}" contains a ${what}. Write it the way a user would say it; if it can't be, the product needs a clearer label.`,
        });
        break;
      }
    }
  }
  return issues;
}

// Contracts are checked by Kane on whatever page a flow ends on, and Kane reads a rule literally: "every price on the
// page" took in a footer's "Free shipping over $60", and a rule listing four totals failed on a search page with none.

export interface ContractIssue {
  message: string;
  hint: string;
}

const PAGE_WIDE = /\b(?:(?:on|across) (?:the|this|that|any|every|each) (?:page|screen|site)|on screen|(?:the )?(?:whole|entire) (?:page|screen|site)|anywhere|everywhere|(?:site|page)[- ]?wide)\b/gi;
// "in the cart summary", "on each product card": the rule says which part of the page it means
const ANCHOR = /\b(?:in|inside|within|under|on|below|above|beside) (?:the|each|every|any|a|an|its|their) (?!(?:format|style|same|right|correct|usual|form of|way)\b)[a-z]/i;
const VAGUE = /\b(properly|correctly|appropriately|reasonably|nicely|as expected|as intended|user[- ]friendly|intuitive(?:ly)?|looks? (?:good|right|fine|ok|okay|nice|correct|clean))\b/i;

/** Heuristic warnings for a behaviour contract worded so broadly that Kane will likely fail it where it doesn't apply. */
export function lintContract(rule: string): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const pageWide = rule.match(PAGE_WIDE);
  if (pageWide && !ANCHOR.test(rule.replace(PAGE_WIDE, ''))) {
    issues.push({
      message: `"${pageWide[0]}" makes Kane check everything it can see, banners and footers included`,
      hint: 'name the part it covers, e.g. "in the cart summary"',
    });
  }
  const listed = longestList(rule);
  if (listed >= 3) {
    issues.push({
      message: `lists ${listed} things, and Kane may expect all of them on every page it checks`,
      hint: 'one rule per thing, or tag it to the flows that end where they all show',
    });
  }
  const vague = VAGUE.exec(rule);
  if (vague) issues.push({ message: `"${vague[1]}" doesn't say what Kane should look for`, hint: 'say what a person would check, e.g. "shows two decimals"' });
  return issues;
}

/** Items in the longest "a, b, c and d" run in the rule (0 when there's none). */
function longestList(rule: string): number {
  const short = (s: string) => s.trim().split(/\s+/).length <= 3;
  let best = 0;
  // a full stop ends a clause, a decimal point ("$12.00") doesn't
  for (const clause of rule.split(/[;:]|\.(?!\d)/)) {
    const parts = clause.split(',');
    // at least one item between commas: "When a coupon applies, the total drops and a message says so" is no list
    if (parts.length < 3) continue;
    const last = parts[parts.length - 1].trim();
    const and = /^(.*?)\band\b/.exec(last);
    if (!and) continue;
    const oxford = !and[1].trim(); // "a, b, and c"
    if (!parts.slice(1, -1).every(short) || (!oxford && !short(and[1]))) continue;
    best = Math.max(best, parts.length + (oxford ? 0 : 1));
  }
  return best;
}

// ---------------------------------------------------------------------------
// Compile a Gremlin flow into a Kane CLI _test.md

export interface CompiledFlow {
  testMdPath: string;
  content: string;
  /** Kane variables for persona credentials, passed on the command line, never written to disk. */
  variables: Record<string, { value: string; secret?: boolean }>;
  /** Maps Kane test.md step index (1-based) to the flow's step text. */
  stepMap: string[];
}

const LOGIN_RE = /\b(log\s?in|sign\s?in|signs\s?in|logs\s?in|authenticate)\b/i;

export function compileFlow(flow: Flow, config: GremlinConfig, paths: ProjectPaths): CompiledFlow {
  const dir = ensureDir(join(paths.kane, flow.type));
  const stem = flow.id.split('/')[1];
  const testMdPath = join(dir, `${stem}_test.md`);
  const variables: CompiledFlow['variables'] = {};
  const persona = flow.account ? config.personas[flow.account] : undefined;
  const key = flow.account ? slugify(flow.account).replace(/-/g, '_') : '';
  if (persona) {
    const login = persona.email ?? persona.username;
    if (login) variables[`${key}_login`] = { value: login };
    if (persona.password) variables[`${key}_password`] = { value: persona.password, secret: true };
  }

  const url = resolveUrl(config, flow.start);
  const lines: string[] = [];
  lines.push('---');
  lines.push('mode: testing');
  lines.push(`url: ${url}`);
  lines.push(`max_steps: ${config.kane.max_steps}`);
  if (flow.tags.length) lines.push(`tags: [${flow.tags.map((t) => slugify(t)).join(', ')}]`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${flow.title}`);
  lines.push('');
  lines.push(`<!-- compiled by gremlin from ${relative(paths.root, flow.path)} (${flow.hash}). Edit the flow, not this file. -->`);

  const stepMap: string[] = [];
  flow.steps.forEach((step, i) => {
    let body = step.trim();
    if (!/[.!?]$/.test(body)) body += '.';
    if (persona && LOGIN_RE.test(body)) {
      const creds: string[] = [];
      if (variables[`${key}_login`]) creds.push(`the login {{${key}_login}}`);
      if (variables[`${key}_password`]) creds.push(`the password {{${key}_password}}`);
      if (creds.length) body += ` Use ${creds.join(' and ')}.`;
    }
    lines.push('');
    lines.push(`## Step ${i + 1}: ${headingFor(step)}`);
    if (i === 0 && !/^(open|go to|navigate|visit|start)/i.test(step)) {
      lines.push(`Start on ${url}. ${body}`);
    } else {
      lines.push(body);
    }
    stepMap.push(step);
  });

  lines.push('');
  lines.push('## Check the expected outcome');
  lines.push(flow.expect.map((e) => `Verify that ${lowerFirst(e.replace(/\.$/, ''))}.`).join('\n'));
  stepMap.push(`Expect: ${flow.expect.join(' / ')}`);

  // A separate step, so a broken contract is told apart from the flow's own expectations.
  // One step per rule: Kane stops at the first failed check, and a shared step would let one broken rule hide
  // another and leave Gremlin guessing which one it was. The step's number names the rule.
  contractsFor(flow, config).forEach((c, i) => {
    lines.push('');
    lines.push(`## ${CONTRACT_STEP} ${i + 1}: ${truncateRule(c.rule)}`);
    lines.push(`Without leaving this page, verify that ${lowerFirst(c.rule.replace(/\.$/, ''))}. If nothing on this page falls under this rule, it holds.`);
    stepMap.push(`Rule ${i + 1}: ${c.rule}`);
  });
  lines.push('');

  const content = lines.join('\n');
  const prev = existsSync(testMdPath) ? readFileSync(testMdPath, 'utf8') : '';
  // Only rewrite when content changed, so Kane's replay cache for unchanged steps stays valid.
  if (prev !== content) writeFileSync(testMdPath, content);
  return { testMdPath, content, variables, stepMap };
}

function headingFor(step: string): string {
  const clean = step.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  const first = clean.split(/(?<=[.!?])\s/)[0];
  return first.length > 64 ? first.slice(0, 63).trimEnd() + '…' : first.replace(/[.!?]$/, '');
}

export const CONTRACT_STEP = 'Product rule';

function truncateRule(rule: string): string {
  const r = rule.replace(/\.$/, '');
  return r.length > 90 ? r.slice(0, 89).trimEnd() + '…' : r;
}

/** The behaviour contracts a flow is held to: every untagged rule, plus rules tagged with one of the flow's areas. */
export function contractsFor(flow: Pick<Flow, 'tags'>, config: GremlinConfig): GremlinConfig['contracts'] {
  return config.contracts.filter((c) => !c.tags.length || c.tags.some((t) => flow.tags.includes(t.toLowerCase())));
}

/** Which contract a failed run broke: the failed step is the rule's own, and its number says which. */
export function brokenContract(flow: Pick<Flow, 'tags'>, config: GremlinConfig, failed?: { heading?: string; reason?: string }): string | undefined {
  const n = new RegExp(`^${CONTRACT_STEP} (\\d+):`, 'i').exec(failed?.heading ?? '')?.[1];
  return n ? contractsFor(flow, config)[Number(n) - 1]?.rule : undefined;
}

function lowerFirst(s: string): string {
  if (/^[A-Z][a-z]/.test(s)) return s[0].toLowerCase() + s.slice(1);
  return s;
}

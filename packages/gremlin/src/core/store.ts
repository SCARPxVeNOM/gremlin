import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ArenaRecord } from './arena.ts';
import type { EvidenceDigest } from './evidence.ts';
import type { Flow, FlowType } from './flow.ts';
import type { KaneRunResult } from './kane.ts';
import { ensureDir, type ProjectPaths } from './paths.ts';
import { appendJsonl, nowIso, readJson, readJsonl, todayKey, writeJson } from './util.ts';

// ---------------------------------------------------------------------------
// Runs

export type RunPurpose = 'guard' | 'breaker' | 'capture' | 'fix' | 'manual' | 'init' | 'verify';

export interface RunRecord {
  id: string;
  flowId: string;
  flowTitle: string;
  flowType: FlowType;
  flowHash: string;
  purpose: RunPurpose;
  job?: string;
  bugId?: string;
  attempt?: number;
  target: string;
  startedAt: string;
  endedAt?: string;
  /** flaky = failed, then passed on the automatic retry */
  status: 'running' | 'passed' | 'failed' | 'error' | 'flaky';
  kane?: KaneRunResult;
  /** The automatic re-run of a failure; `verdict` is the triage that wasn't chosen, when both attempts failed. */
  retry?: { status: string; credits: number; logPath: string; evidencePack?: string; verdict?: KaneRunResult['verdict'] };
  evidence?: EvidenceDigest;
  credits: number;
}

export function saveRun(paths: ProjectPaths, run: RunRecord): void {
  writeJson(join(paths.runs, `${run.id}.json`), run);
}

export function getRun(paths: ProjectPaths, id: string): RunRecord | undefined {
  return readJson<RunRecord | undefined>(join(paths.runs, `${id}.json`), undefined);
}

export function listRuns(paths: ProjectPaths, limit = 200): RunRecord[] {
  if (!existsSync(paths.runs)) return [];
  const files = readdirSync(paths.runs).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit);
  return files.map((f) => readJson<RunRecord>(join(paths.runs, f), undefined as never)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Bugs

export type BugStatus = 'candidate' | 'confirmed' | 'fixing' | 'fixed' | 'escalated' | 'cant-reproduce' | 'rejected';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface FixAttempt {
  n: number;
  at: string;
  agent: string;
  promptFile: string;
  changedFiles: string[];
  outsideArea: string[];
  blocked: string[];
  agentSummary?: string;
  runId?: string;
  relatedRuns?: string[];
  /** The app wouldn't start after the change; this is why. */
  appError?: string;
  result: 'passed' | 'failed' | 'blocked' | 'agent-error' | 'pending';
  durationS?: number;
}

export interface BugRecord {
  id: string;
  title: string;
  origin: 'breaker' | 'capture' | 'guard';
  status: BugStatus;
  severity: Severity;
  confidence: number;
  flowId: string;
  attack?: string;
  tags: string[];
  report?: { source: string; ref?: string; url?: string; text: string };
  failingStep?: string;
  reason?: string;
  /** The behaviour contract the failure broke, when it was one. */
  contract?: string;
  /** Why a human rejected it (the product works as intended, the attack expected too much). */
  rejectedBecause?: string;
  verdict?: KaneRunResult['verdict'];
  runs: string[];
  attempts: FixAttempt[];
  questions?: string[];
  createdAt: string;
  updatedAt: string;
  fixedAt?: string;
  /** Set when Guard caught a fixed bug coming back. */
  regressedAt?: string;
  /** Set when several agents competed to fix this bug and Kane judged them. */
  arena?: ArenaRecord;
  /**
   * The pull request with the fix, recorded on this checkout's copy (the branch's copy can't name its own commit).
   * Until `sha` is in HEAD's history, Guard reads a failing flow as the fix not being merged, not as a regression.
   */
  pr?: { url: string; branch: string; sha: string };
  /**
   * Kane watched the repro fail but blamed the test; a human read the agent's evidence and ruled it a product bug.
   * Kane still has to pass the same flow before a fix counts.
   */
  confirmedBy?: { by: string; at: string; kane: string };
  credits: number;
}

/**
 * Bug numbers in use on fix branches that aren't merged yet (open Gremlin pull requests). Their records aren't in
 * this checkout, so without asking origin a new bug would be numbered BUG-001 again, and its pull request branch
 * would land on the open one's. Asked once per repo per process, or again when a long-running loop refreshes it.
 */
const openFixBranches = new Map<string, number[]>();

export function reserveOpenFixBranches(root: string): number[] {
  const r = spawnSync('git', ['ls-remote', '--heads', 'origin', 'gremlin/bug-*'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const taken = r.status === 0 ? [...(r.stdout ?? '').matchAll(/refs\/heads\/gremlin\/bug-(\d+)\b/g)].map((m) => Number(m[1])) : [];
  openFixBranches.set(root, taken);
  return taken;
}

export function nextBugId(paths: ProjectPaths): string {
  const local = existsSync(paths.bugs)
    ? readdirSync(paths.bugs)
        .map((f) => /^BUG-(\d+)\.json$/.exec(f)?.[1])
        .filter(Boolean)
        .map(Number)
    : [];
  const elsewhere = openFixBranches.get(paths.root) ?? reserveOpenFixBranches(paths.root);
  const n = Math.max(0, ...local, ...elsewhere);
  return `BUG-${String(n + 1).padStart(3, '0')}`;
}

export function saveBug(paths: ProjectPaths, bug: BugRecord): void {
  bug.updatedAt = nowIso();
  writeJson(join(paths.bugs, `${bug.id}.json`), bug);
}

export function getBug(paths: ProjectPaths, id: string): BugRecord | undefined {
  const norm = /^\d+$/.test(id) ? `BUG-${id.padStart(3, '0')}` : id.toUpperCase();
  return readJson<BugRecord | undefined>(join(paths.bugs, `${norm}.json`), undefined);
}

export function listBugs(paths: ProjectPaths): BugRecord[] {
  if (!existsSync(paths.bugs)) return [];
  return readdirSync(paths.bugs)
    .filter((f) => /^BUG-\d+\.json$/.test(f))
    .sort()
    .map((f) => readJson<BugRecord>(join(paths.bugs, f), undefined as never))
    .filter(Boolean);
}

export function bugForFlow(paths: ProjectPaths, flow: Flow): BugRecord | undefined {
  if (flow.bug) return getBug(paths, flow.bug);
  return listBugs(paths).find((b) => b.flowId === flow.id);
}

// ---------------------------------------------------------------------------
// Event feed (tailed by the dashboard, written by every process: CLI, hooks, MCP)

export type EventKind =
  | 'job-start'
  | 'job-end'
  | 'flow-start'
  | 'flow-end'
  | 'kane-step'
  | 'kane-action'
  | 'bug'
  | 'agent'
  | 'info'
  | 'warn'
  | 'error';

export interface GremlinEvent {
  ts: string;
  kind: EventKind;
  job?: string;
  msg: string;
  data?: Record<string, unknown>;
}

export function emit(paths: ProjectPaths, kind: EventKind, msg: string, data?: Record<string, unknown>, job?: string): GremlinEvent {
  const e: GremlinEvent = { ts: nowIso(), kind, msg, ...(job ? { job } : {}), ...(data ? { data } : {}) };
  try {
    appendJsonl(paths.events, e);
  } catch {
    // the feed is best effort; never fail a run over it
  }
  return e;
}

export function readEvents(paths: ProjectPaths, limit = 500): GremlinEvent[] {
  const all = readJsonl<GremlinEvent>(paths.events);
  return all.slice(-limit);
}

// ---------------------------------------------------------------------------
// Credit ledger

export interface LedgerEntry {
  ts: string;
  runId: string;
  flowId: string;
  purpose: RunPurpose;
  bugId?: string;
  credits: number;
}

export function recordCredits(paths: ProjectPaths, entry: Omit<LedgerEntry, 'ts'>): void {
  if (!entry.credits) return;
  appendJsonl(paths.ledger, { ts: nowIso(), ...entry });
}

export function readLedger(paths: ProjectPaths): LedgerEntry[] {
  return readJsonl<LedgerEntry>(paths.ledger);
}

export function creditsToday(paths: ProjectPaths): number {
  const today = todayKey();
  return readLedger(paths)
    .filter((e) => e.ts.startsWith(today))
    .reduce((s, e) => s + e.credits, 0);
}

export function creditsForBug(paths: ProjectPaths, bugId: string): number {
  return readLedger(paths)
    .filter((e) => e.bugId === bugId)
    .reduce((s, e) => s + e.credits, 0);
}

// ---------------------------------------------------------------------------
// Stats: flow stability and which attacks actually find bugs

export interface FlowStats {
  runs: number;
  passes: number;
  fails: number;
  flakes: number;
  errors: number;
  last?: string;
  lastRunAt?: string;
  lastRunId?: string;
  history: string[];
}

export interface Stats {
  flows: Record<string, FlowStats>;
  attacks: Record<string, { tried: number; found: number }>;
}

export function readStats(paths: ProjectPaths): Stats {
  return readJson<Stats>(paths.stats, { flows: {}, attacks: {} });
}

export function recordFlowResult(paths: ProjectPaths, flowId: string, status: string, runIdValue: string): FlowStats {
  const stats = readStats(paths);
  const s = (stats.flows[flowId] ??= { runs: 0, passes: 0, fails: 0, flakes: 0, errors: 0, history: [] });
  s.runs++;
  if (status === 'passed') s.passes++;
  else if (status === 'failed') s.fails++;
  else if (status === 'flaky') s.flakes++;
  else s.errors++;
  s.last = status;
  s.lastRunAt = nowIso();
  s.lastRunId = runIdValue;
  s.history = [...s.history, status].slice(-20);
  writeJson(paths.stats, stats);
  return s;
}

export function recordAttack(paths: ProjectPaths, attack: string, found: boolean): void {
  const stats = readStats(paths);
  const a = (stats.attacks[attack] ??= { tried: 0, found: 0 });
  a.tried++;
  if (found) a.found++;
  writeJson(paths.stats, stats);
}

/** Share of recent runs that were clean, flakes counting against the score. */
export function stability(s?: FlowStats): number | null {
  if (!s || !s.history.length) return null;
  const clean = s.history.filter((h) => h === 'passed' || h === 'failed').length;
  return Math.round((clean / s.history.length) * 100);
}

// ---------------------------------------------------------------------------
// Lock: the hash of every confirmed flow. Guard refuses a flow edited without a human approving it.
// Each flow's lock is a file of its own, .gremlin/locks/<type>/<stem>.json: every fix pull request locks a flow, and
// with one shared lock.json, two open pull requests made from the same commit conflicted when the second was merged.

export interface LockEntry {
  hash: string;
  approvedAt: string;
  by: string;
}

export interface Lock {
  flows: Record<string, LockEntry>;
}

const lockFile = (dir: string, flowId: string) => join(dir, ...flowId.split('/')) + '.json';

/** Where a flow's lock lives, e.g. .gremlin/locks/regression/coupon-codes-ignore-case.json */
export function lockPath(paths: ProjectPaths, flowId: string): string {
  return lockFile(paths.locks, flowId);
}

function perFlowLocks(paths: ProjectPaths): Lock['flows'] {
  const flows: Lock['flows'] = {};
  if (!existsSync(paths.locks)) return flows;
  for (const type of readdirSync(paths.locks, { withFileTypes: true })) {
    if (!type.isDirectory()) continue;
    for (const file of readdirSync(join(paths.locks, type.name)).sort()) {
      if (!file.endsWith('.json')) continue;
      const entry = readJson<LockEntry | undefined>(join(paths.locks, type.name, file), undefined);
      if (entry?.hash) flows[`${type.name}/${file.slice(0, -'.json'.length)}`] = entry;
    }
  }
  return flows;
}

export function readLock(paths: ProjectPaths): Lock {
  const flows = perFlowLocks(paths);
  // An older project's lock.json counts only until a flow has a lock file of its own. After that it's ignored, so one
  // left behind (checking out a branch that still has it can bring it back) can't revive a lock that was removed since.
  if (Object.keys(flows).length) return { flows };
  return { flows: readJson<Partial<Lock>>(paths.legacyLock, {}).flows ?? {} };
}

/** Move an older project's lock.json into per-flow files, then remove it. Runs before any lock change. */
function migrateLegacyLock(paths: ProjectPaths): void {
  if (!existsSync(paths.legacyLock)) return;
  if (!Object.keys(perFlowLocks(paths)).length) {
    // Built aside and moved into place at once: a half-written locks/ would hide the rest of lock.json for good.
    // Entries are copied as they are, so two branches that each migrate write identical files and still merge cleanly.
    const tmp = `${paths.locks}.${process.pid}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    for (const [id, entry] of Object.entries(readLock(paths).flows)) {
      const parts = id.split('/');
      if (parts.length === 2 && parts.every((s) => s && s !== '.' && s !== '..')) writeJson(lockFile(tmp, id), entry);
    }
    ensureDir(tmp);
    rmSync(paths.locks, { recursive: true, force: true }); // holds no locks: at most empty folders
    renameSync(tmp, paths.locks);
  }
  rmSync(paths.legacyLock, { force: true });
}

export function lockFlow(paths: ProjectPaths, flow: Flow, by: string): void {
  migrateLegacyLock(paths);
  const entry: LockEntry = { hash: flow.hash, approvedAt: nowIso(), by };
  writeJson(lockPath(paths, flow.id), entry);
}

export function unlockFlow(paths: ProjectPaths, flowId: string): void {
  migrateLegacyLock(paths);
  rmSync(lockPath(paths, flowId), { force: true });
}

export function tamperedFlows(paths: ProjectPaths, flows: Flow[]): Flow[] {
  const lock = readLock(paths);
  return flows.filter((f) => lock.flows[f.id] && lock.flows[f.id].hash !== f.hash);
}

// ---------------------------------------------------------------------------
// Session state for agent hooks

export interface HookSession {
  attempts: number;
  baseline?: string;
  /** Untracked files at session start, with their content hash: only new or changed ones count as the session's work. */
  untracked?: Record<string, string>;
  startedAt: string;
  lastGuardAt?: string;
  lastResult?: string;
  escalated?: boolean;
}

export interface State {
  sessions: Record<string, HookSession>;
}

export function readState(paths: ProjectPaths): State {
  return readJson<State>(paths.state, { sessions: {} });
}

export function writeState(paths: ProjectPaths, state: State): void {
  // keep the newest 50 sessions
  const entries = Object.entries(state.sessions).sort((a, b) => b[1].startedAt.localeCompare(a[1].startedAt));
  state.sessions = Object.fromEntries(entries.slice(0, 50));
  writeJson(paths.state, state);
}

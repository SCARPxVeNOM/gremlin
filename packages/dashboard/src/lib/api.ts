// Types mirror the JSON the Gremlin CLI server returns (packages/gremlin/src/server).

export type FlowType = 'happy' | 'adversarial' | 'regression'
export type FlowStatus = 'draft' | 'confirmed' | 'active' | 'quarantined' | 'retired'
export type RunStatus = 'running' | 'passed' | 'failed' | 'error' | 'flaky'
export type BugStatus = 'candidate' | 'confirmed' | 'fixing' | 'fixed' | 'escalated' | 'cant-reproduce' | 'rejected'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface FlowView {
  id: string
  title: string
  type: FlowType
  platforms: string[]
  start: string
  account?: string
  source: string
  status: FlowStatus
  tags: string[]
  attack?: string
  bug?: string
  fail_first?: string
  created?: string
  steps: string[]
  expect: string[]
  notes: string
  hash: string
  file: string
  stability: number | null
  last?: string
  lastRunAt?: string
  lastRunId?: string
  runs: number
  locked: boolean
  tampered: boolean
}

export interface KaneVerdict {
  confirmed: boolean
  family?: string
  category?: string
  severity?: string
  confidence?: number
  title?: string
  oneLiner?: string
  rootCause?: string
  suggestion?: string
}

export interface KaneStep {
  index: number
  heading: string
  status: string
  durationS?: number
  reason?: string
  summary?: string
  replayed?: boolean
  actions?: string[]
}

export interface KaneResult {
  status: 'passed' | 'failed' | 'error'
  exitCode?: number
  steps: KaneStep[]
  failedStep?: KaneStep
  reason?: string
  oneLiner?: string
  summary?: string
  verdict?: KaneVerdict
  credits?: number
  durationS: number
  sessionId?: string
  shareUrl?: string
  evidencePack?: string
  replayed: number
  authored: number
  healed?: boolean
  errors?: string[]
}

export interface EvidenceDigest {
  pack: string
  failure?: {
    step?: string
    message: string
    pageUrl?: string
    title?: string
    rootCause?: string
    category?: string
    confidence?: number
    severity?: string
    suggestedFix?: string
    screenshot?: string
  }
  consoleErrors: string[]
  networkFailures: { method: string; url: string; status: number }[]
  steps: { ordinal: number; id: string; kind?: string; status: string; summary?: string; url?: string; screenshot?: string }[]
  screenshots: string[]
}

export interface Run {
  id: string
  flowId: string
  flowTitle: string
  flowType: FlowType
  flowHash: string
  purpose: string
  job?: string
  bugId?: string
  attempt?: number
  target: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  kane?: KaneResult
  retry?: { status: string; credits: number }
  evidence?: EvidenceDigest
  credits: number
}

/** The list endpoint trims evidence to counts. */
export interface RunLite extends Omit<Run, 'evidence'> {
  evidence?: { screenshots: string[]; failure?: EvidenceDigest['failure']; consoleErrors: number; networkFailures: number }
}

export interface FixAttempt {
  n: number
  at: string
  agent: string
  promptFile: string
  changedFiles: string[]
  outsideArea: string[]
  blocked: string[]
  agentSummary?: string
  runId?: string
  relatedRuns?: string[]
  result: 'passed' | 'failed' | 'blocked' | 'agent-error' | 'pending'
  durationS?: number
}

export interface ArenaEntry {
  contender: string
  label: string
  durationS?: number
  changedFiles: string[]
  added: number
  removed: number
  blocked: string[]
  runId?: string
  relatedRuns: string[]
  result: 'won' | 'passed' | 'flaky' | 'failed' | 'broke-related' | 'broke-startup' | 'no-change' | 'agent-error'
  note?: string
  summary?: string
}

export interface Bug {
  id: string
  title: string
  origin: 'breaker' | 'capture' | 'guard'
  status: BugStatus
  severity: Severity
  confidence: number
  flowId: string
  attack?: string
  tags: string[]
  report?: { source: string; ref?: string; url?: string; text: string }
  failingStep?: string
  reason?: string
  /** The behaviour contract the failure broke, when it was one. */
  contract?: string
  rejectedBecause?: string
  verdict?: KaneVerdict
  runs: string[]
  attempts: FixAttempt[]
  questions?: string[]
  createdAt: string
  updatedAt: string
  fixedAt?: string
  regressedAt?: string
  /** Several agents competed to fix this bug and Kane judged them. */
  arena?: { at: string; entries: ArenaEntry[]; winner?: string }
  /** The pull request with the fix; Guard waits for it to merge before calling a failure a regression. */
  pr?: { url: string; branch: string; sha: string }
  credits: number
}

export interface Summary {
  app: { name: string; url: string; agent: string; mode: string }
  counts: {
    flows: Record<FlowType, number>
    bugsFound: number
    bugsFixed: number
    open: number
    escalated: number
    regressionsCaught: number
    flaky: number
    quarantined: number
    byOrigin: Record<string, { found: number; fixed: number }>
  }
  credits: {
    today: number
    week: number
    total: number
    perBugFound: number | null
    perBugFixed: number | null
    budget: { per_run: number; per_day: number; per_bug: number }
  }
  timeline: { day: string; found: number; fixed: number; runs: number; credits: number }[]
  busy: { kind: string; title: string; startedAt: string } | null
}

export interface GEvent {
  ts: string
  kind: 'job-start' | 'job-end' | 'flow-start' | 'flow-end' | 'kane-step' | 'kane-action' | 'bug' | 'agent' | 'info' | 'warn' | 'error'
  job?: string
  msg: string
  data?: Record<string, any>
}

export interface ConfigView {
  raw: any
  root: string
  kane: { installed: boolean; version?: string; authenticated: boolean; user?: string; credits?: number }
  agent: { name: string; label: string; available: boolean; detected: string[] }
  appReachable: boolean
  integrations: { claudeHooks: boolean; mcp: boolean; rules: boolean; ci: boolean }
  busy: Summary['busy']
}

export interface CatalogEntry {
  id: string
  category: string
  categoryLabel: string
  name: string
  prior: number
  tried: number
  found: number
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`)
  return data as T
}

export const post = <T = { started: boolean }>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const evidenceUrl = (runId: string, file: string) => `/api/evidence/${runId}/${encodeURIComponent(file)}`

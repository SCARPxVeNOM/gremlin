import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from './paths.ts';
import { round } from './util.ts';
import { onInterrupt } from './interrupt.ts';

export const KANE_BIN = process.env.GREMLIN_KANE_BIN ?? 'kane-cli';

export interface KaneVerdict {
  /** Kane's investigator confirmed a product bug. */
  confirmed: boolean;
  /** e.g. product_bug, automation_bug */
  family?: string;
  category?: string;
  severity?: string;
  confidence?: number;
  title?: string;
  oneLiner?: string;
  rootCause?: string;
  suggestion?: string;
}

export interface KaneStepResult {
  index: number;
  heading: string;
  status: 'passed' | 'failed' | 'skipped' | 'running';
  durationS?: number;
  reason?: string;
  summary?: string;
  replayed?: boolean;
  actions: string[];
}

export interface KaneRunResult {
  status: 'passed' | 'failed' | 'error';
  exitCode: number;
  steps: KaneStepResult[];
  failedStep?: KaneStepResult;
  reason?: string;
  oneLiner?: string;
  summary?: string;
  verdict?: KaneVerdict;
  credits: number;
  durationS: number;
  sessionId?: string;
  shareUrl?: string;
  evidencePack?: string;
  replayed: number;
  authored: number;
  healed: boolean;
  errors: string[];
  logPath: string;
}

export type KaneEvent =
  | { kind: 'step-start'; index: number; heading: string }
  | { kind: 'step-end'; index: number; heading: string; status: string; durationS?: number; reason?: string }
  | { kind: 'action'; index: number; detail: string; ok?: boolean }
  | { kind: 'mode'; index: number; mode: 'replay' | 'author' }
  | { kind: 'verdict'; verdict: KaneVerdict }
  | { kind: 'error'; message: string };

export interface KaneRunOptions {
  file: string;
  cwd: string;
  logPath: string;
  variables?: Record<string, { value: string; secret?: boolean }>;
  headless?: boolean;
  maxSteps?: number;
  timeoutS?: number;
  bugDetection?: 'off' | 'stop' | 'continue';
  url?: string;
  author?: boolean;
  onEvent?: (e: KaneEvent) => void;
  signal?: AbortSignal;
}

export async function runKaneTest(opts: KaneRunOptions): Promise<KaneRunResult> {
  const args = ['testmd', 'run', opts.file, '--agent'];
  if (opts.headless !== false) args.push('--headless');
  if (opts.bugDetection) args.push('--bug-detection', opts.bugDetection);
  if (opts.maxSteps) args.push('--max-steps', String(opts.maxSteps));
  if (opts.url) args.push('--url', opts.url);
  if (opts.author) args.push('--author');
  if (opts.variables && Object.keys(opts.variables).length) args.push('--variables', JSON.stringify(opts.variables));
  // CI: Kane authenticates with basic auth from secrets instead of the interactive OAuth login
  if (process.env.LT_USERNAME && process.env.LT_ACCESS_KEY) args.push('--username', process.env.LT_USERNAME, '--access-key', process.env.LT_ACCESS_KEY);

  ensureDir(dirname(opts.logPath));
  const log = createWriteStream(opts.logPath);
  const started = Date.now();

  const result: KaneRunResult = {
    status: 'error',
    exitCode: -1,
    steps: [],
    credits: 0,
    durationS: 0,
    replayed: 0,
    authored: 0,
    healed: false,
    errors: [],
    logPath: opts.logPath,
  };
  const stepByIndex = new Map<number, KaneStepResult>();
  let current: KaneStepResult | undefined;
  let stderr = '';
  let overall: string | undefined;

  const handle = (o: any) => {
    switch (o.type) {
      case 'test_md_step_start': {
        current = { index: o.step_index, heading: o.heading ?? `Step ${o.step_index}`, status: 'running', actions: [] };
        stepByIndex.set(o.step_index, current);
        result.steps.push(current);
        opts.onEvent?.({ kind: 'step-start', index: current.index, heading: current.heading });
        break;
      }
      case 'bifurcation':
        if (current) {
          current.replayed = false;
          opts.onEvent?.({ kind: 'mode', index: current.index, mode: 'author' });
        }
        break;
      case 'step_event':
        if (o.event === 'replay_started' && current) {
          current.replayed = true;
          opts.onEvent?.({ kind: 'mode', index: current.index, mode: 'replay' });
        } else if ((o.event === 'action' || o.event === 'assertion') && current && o.detail) {
          const detail = String(o.detail);
          current.actions.push(o.event === 'assertion' ? `assert ${o.passed ? '✓' : '✗'} ${detail}` : detail);
          opts.onEvent?.({ kind: 'action', index: current.index, detail, ok: o.success ?? o.passed });
        }
        break;
      case 'run_end':
        result.credits += Number(o.credits_consumed ?? 0);
        if (current) {
          current.summary = o.one_liner || o.summary || current.summary;
          if (o.status === 'failed') current.reason = o.reason;
        }
        if (o.status === 'failed') {
          result.reason = o.reason ?? result.reason;
          result.oneLiner = o.one_liner ?? result.oneLiner;
          result.summary = o.summary ?? result.summary;
          if (o.verdict) result.verdict = toVerdict(o.verdict);
        }
        if (o.session_dir && !result.sessionId) result.sessionId = String(o.session_dir).split('/').pop();
        break;
      case 'test_md_bug_verdict': {
        const v = toVerdict(o);
        result.verdict = { ...result.verdict, ...v, rootCause: result.verdict?.rootCause, suggestion: result.verdict?.suggestion };
        opts.onEvent?.({ kind: 'verdict', verdict: result.verdict });
        break;
      }
      case 'test_md_step_end': {
        const s = stepByIndex.get(o.step_index);
        if (s) {
          s.status = o.status;
          s.durationS = o.duration_s;
          if (o.status === 'failed' && !result.failedStep) result.failedStep = s;
          opts.onEvent?.({ kind: 'step-end', index: s.index, heading: s.heading, status: s.status, durationS: s.durationS, reason: s.reason });
        }
        break;
      }
      case 'test_md_summary':
        result.replayed = o.steps?.replay_decisions ?? 0;
        result.authored = o.steps?.author_decisions ?? 0;
        result.healed = Boolean(o.adaptive_heal?.triggered);
        if (o.share_url) result.shareUrl = o.share_url;
        break;
      case 'coverage':
        if (o.pack) result.evidencePack = o.pack;
        break;
      case 'test_md_done':
        overall = o.overall_status;
        if (o.session_id) result.sessionId = o.session_id;
        if (o.share_url) result.shareUrl = o.share_url;
        if (o.coverage?.pack && !result.evidencePack) result.evidencePack = o.coverage.pack;
        break;
      case 'error':
        result.errors.push(String(o.message ?? 'kane-cli error'));
        opts.onEvent?.({ kind: 'error', message: String(o.message ?? 'kane-cli error') });
        break;
    }
  };

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(KANE_BIN, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const release = onInterrupt(() => child.kill('SIGTERM'));
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      log.write(chunk);
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          // non-JSON or partial line: ignore per Kane's parsing contract
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = opts.timeoutS
      ? setTimeout(() => {
          result.errors.push(`Gremlin stopped the run after ${opts.timeoutS}s`);
          child.kill('SIGTERM');
        }, opts.timeoutS * 1000)
      : undefined;
    opts.signal?.addEventListener('abort', () => child.kill('SIGTERM'));
    child.on('error', (err) => {
      result.errors.push(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `${KANE_BIN} not found. Install it: npm install -g @testmuai/kane-cli`
          : err.message,
      );
      resolve(127);
    });
    child.on('close', (code) => {
      release();
      if (timer) clearTimeout(timer);
      if (buf.trim().startsWith('{')) {
        try {
          handle(JSON.parse(buf.trim()));
        } catch {}
      }
      resolve(code ?? 1);
    });
  });
  log.end();

  if (!result.evidencePack) {
    const m = /evidence serve\s+([^\s`]+\.evidence)/.exec(stderr);
    if (m) result.evidencePack = m[1];
  }
  if (exitCode === 2 && !result.errors.length) {
    const line = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !/update available/i.test(l)).pop();
    if (line) result.errors.push(line);
  }

  result.exitCode = exitCode;
  result.durationS = round((Date.now() - started) / 1000);
  result.credits = round(result.credits, 2);
  if (overall === 'passed' && exitCode === 0) result.status = 'passed';
  else if (overall === 'failed' || exitCode === 1) result.status = 'failed';
  else result.status = 'error';
  if (result.status === 'failed' && !result.failedStep) {
    result.failedStep = result.steps.find((s) => s.status === 'failed') ?? result.steps[result.steps.length - 1];
  }
  return result;
}

function toVerdict(o: any): KaneVerdict {
  return {
    confirmed: Boolean(o.confirmed),
    family: o.family,
    category: o.category,
    severity: o.severity,
    confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
    title: o.bug_title,
    oneLiner: o.one_liner,
    rootCause: o.root_cause,
    suggestion: o.suggestion,
  };
}

/** True when Kane judged the failure to be the test's or the automation's fault, not the product's. */
export function isAutomationFault(v?: KaneVerdict): boolean {
  return Boolean(v && v.family && /automation|test_|config|environment|infra/i.test(v.family));
}

// ---------------------------------------------------------------------------
// Account checks

export interface KaneStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  user?: string;
  credits?: number;
}

export function kaneStatus(): KaneStatus {
  const v = spawnSync(KANE_BIN, ['--version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) return { installed: false, authenticated: false };
  const who = spawnSync(KANE_BIN, ['whoami'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const whoText = `${who.stdout}\n${who.stderr}`;
  const authenticated = /Authenticated/.test(whoText) && !/Not logged in/i.test(whoText);
  const user = /User\s+(\S+)/.exec(whoText)?.[1];
  let credits: number | undefined;
  if (authenticated) {
    const bal = spawnSync(KANE_BIN, ['balance'], { encoding: 'utf8' });
    const m = /credits:\s*([\d,.]+)/i.exec(`${bal.stdout}\n${bal.stderr}`);
    if (m) credits = Number(m[1].replace(/,/g, ''));
  }
  return { installed: true, version: v.stdout.trim(), authenticated, user, credits };
}

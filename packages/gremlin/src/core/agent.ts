import { spawn, spawnSync } from 'node:child_process';
import type { GremlinConfig } from './config.ts';
import { round } from './util.ts';
import { onInterrupt } from './interrupt.ts';

/**
 * Gremlin does not ship a coding agent. It drives the one you already use, headless,
 * through that agent's own CLI.
 */

export interface AgentActivity {
  kind: 'read' | 'edit' | 'run' | 'text' | 'done';
  detail: string;
}

export interface AgentResult {
  ok: boolean;
  output: string;
  summary: string;
  durationS: number;
}

export interface AgentConnector {
  name: string;
  label: string;
  available(): boolean;
  /** Read-only question (drafting flows). Returns the agent's text answer. */
  ask(prompt: string, cwd: string): Promise<AgentResult>;
  /** Hand over a fix package. The agent edits the working tree. */
  fix(prompt: string, promptFile: string, cwd: string, onActivity?: (a: AgentActivity) => void): Promise<AgentResult>;
}

function has(bin: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0;
}

interface ExecOptions {
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  shell?: boolean;
  onLine?: (line: string) => void;
}

function exec(bin: string, args: string[], opts: ExecOptions): Promise<{ code: number; stdout: string; stderr: string; durationS: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      shell: opts.shell ?? false,
      env: { ...process.env, GREMLIN_AGENT_RUN: '1' },
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const release = onInterrupt(() => child.kill('SIGTERM'));
    let stdout = '';
    let stderr = '';
    let buf = '';
    child.stdout!.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      stdout += s;
      if (opts.onLine) {
        buf += s;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          opts.onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
    });
    child.stderr!.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    if (opts.stdin !== undefined) {
      child.stdin!.write(opts.stdin);
      child.stdin!.end();
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + err.message, durationS: round((Date.now() - started) / 1000) });
    });
    child.on('close', (code) => {
      release();
      clearTimeout(timer);
      if (buf && opts.onLine) opts.onLine(buf);
      resolve({ code: code ?? 1, stdout, stderr, durationS: round((Date.now() - started) / 1000) });
    });
  });
}

const ASK_TIMEOUT = 5 * 60_000;
const FIX_TIMEOUT = 20 * 60_000;

// ---------------------------------------------------------------------------
// Claude Code

/** Claude Code, optionally pinned to a model ("sonnet", "opus", "haiku" or a full model id). */
export function claudeCodeAgent(model?: string): AgentConnector {
  const pin = model ? ['--model', model] : [];
  return {
    name: 'claude-code',
    label: model ? `Claude Code (${model})` : 'Claude Code',
    available: () => has('claude'),
    async ask(prompt, cwd) {
      const r = await exec('claude', ['-p', ...pin, '--output-format', 'text', '--allowedTools', 'Read', 'Glob', 'Grep', 'LS'], {
        cwd,
        stdin: prompt,
        timeoutMs: ASK_TIMEOUT,
      });
      return { ok: r.code === 0, output: r.stdout, summary: r.stdout.trim().slice(0, 400), durationS: r.durationS };
    },
    async fix(prompt, _promptFile, cwd, onActivity) {
      let summary = '';
      const r = await exec(
        'claude',
        [
          '-p',
          ...pin,
          '--output-format',
          'stream-json',
          '--verbose',
          '--permission-mode',
          'acceptEdits',
          '--allowedTools',
          'Read',
          'Edit',
          'Write',
          'MultiEdit',
          'Glob',
          'Grep',
          'LS',
          'Bash(node --check:*)',
          'Bash(npm test:*)',
          'Bash(npx tsc:*)',
          'Bash(git diff:*)',
          'Bash(git status:*)',
          '--disallowedTools',
          'Edit(.gremlin/**)',
          'Write(.gremlin/**)',
          'MultiEdit(.gremlin/**)',
          'Edit(gremlin.config.yaml)',
          'Write(gremlin.config.yaml)',
        ],
        {
          cwd,
          stdin: prompt,
          timeoutMs: FIX_TIMEOUT,
          onLine: (line) => {
            if (!line.startsWith('{')) return;
            try {
              const o = JSON.parse(line);
              if (o.type === 'assistant') {
                for (const c of o.message?.content ?? []) {
                  if (c.type === 'tool_use') {
                    const input = c.input ?? {};
                    const file = input.file_path ?? input.path ?? input.pattern ?? input.command ?? '';
                    const kind = /Edit|Write/.test(c.name) ? 'edit' : c.name === 'Bash' ? 'run' : 'read';
                    const shown = String(file).split(cwd + '/').join('').split(cwd).join('.');
                    onActivity?.({ kind, detail: `${c.name} ${shown}`.trim() });
                  } else if (c.type === 'text' && c.text?.trim()) {
                    onActivity?.({ kind: 'text', detail: c.text.trim().slice(0, 300) });
                  }
                }
              } else if (o.type === 'result') {
                summary = String(o.result ?? '').trim();
                onActivity?.({ kind: 'done', detail: o.is_error ? 'agent reported an error' : 'agent finished' });
              }
            } catch {}
          },
        },
      );
      return { ok: r.code === 0, output: r.stdout + r.stderr, summary: summary || r.stderr.trim().slice(-400), durationS: r.durationS };
    },
  };
}
const claudeCode = claudeCodeAgent();

// ---------------------------------------------------------------------------
// Other agents: prompt as an argument, plain output

function simpleConnector(
  name: string,
  label: string,
  bin: string,
  askArgs: (p: string) => string[],
  fixArgs: (p: string) => string[],
): AgentConnector {
  return {
    name,
    label,
    available: () => has(bin),
    async ask(prompt, cwd) {
      const r = await exec(bin, askArgs(prompt), { cwd, timeoutMs: ASK_TIMEOUT });
      return { ok: r.code === 0, output: r.stdout, summary: r.stdout.trim().slice(-400), durationS: r.durationS };
    },
    async fix(prompt, _file, cwd, onActivity) {
      const r = await exec(bin, fixArgs(prompt), {
        cwd,
        timeoutMs: FIX_TIMEOUT,
        onLine: (l) => l.trim() && onActivity?.({ kind: 'text', detail: l.trim().slice(0, 200) }),
      });
      return { ok: r.code === 0, output: r.stdout + r.stderr, summary: r.stdout.trim().slice(-600), durationS: r.durationS };
    },
  };
}

const codex = simpleConnector(
  'codex',
  'Codex CLI',
  'codex',
  (p) => ['exec', '--sandbox', 'read-only', p],
  (p) => ['exec', '--full-auto', p],
);
const cursor = simpleConnector(
  'cursor',
  'Cursor Agent',
  'cursor-agent',
  (p) => ['-p', '--output-format', 'text', p],
  (p) => ['-p', '--force', '--output-format', 'text', p],
);
const gemini = simpleConnector(
  'gemini',
  'Gemini CLI',
  'gemini',
  (p) => ['-p', p],
  (p) => ['-p', p, '--yolo'],
);

function customConnector(config: GremlinConfig): AgentConnector {
  const run = async (template: string | undefined, prompt: string, file: string, cwd: string, onActivity?: (a: AgentActivity) => void) => {
    if (!template) return { ok: false, output: 'agent.command is not set', summary: 'agent.command is not set', durationS: 0 };
    const cmd = template.replace(/\{prompt_file\}/g, JSON.stringify(file));
    const r = await exec(cmd, [], {
      cwd,
      shell: true,
      stdin: template.includes('{prompt_file}') ? undefined : prompt,
      timeoutMs: FIX_TIMEOUT,
      onLine: (l) => l.trim() && onActivity?.({ kind: 'text', detail: l.trim().slice(0, 200) }),
    });
    return { ok: r.code === 0, output: r.stdout + r.stderr, summary: r.stdout.trim().slice(-600), durationS: r.durationS };
  };
  return {
    name: 'custom',
    label: 'Custom agent',
    available: () => Boolean(config.agent.command),
    ask: (prompt, cwd) => run(config.agent.ask_command ?? config.agent.command, prompt, '', cwd),
    fix: (prompt, file, cwd, onActivity) => run(config.agent.command, prompt, file, cwd, onActivity),
  };
}

export const CONNECTORS: Record<string, AgentConnector> = {
  'claude-code': claudeCode,
  codex,
  cursor,
  gemini,
};

export function getAgent(config: GremlinConfig): AgentConnector | null {
  if (config.agent.name === 'none') return null;
  if (config.agent.name === 'custom') return customConnector(config);
  return CONNECTORS[config.agent.name] ?? null;
}

/**
 * One contender for the arena, written "agent" or "agent:model" (e.g. "claude-code:sonnet", "codex").
 * Only Claude Code takes a model here; other agents use whatever their own CLI is set to.
 */
export function contender(spec: string): AgentConnector {
  const [name, model] = spec.split(':');
  if (name === 'claude-code') return claudeCodeAgent(model || undefined);
  const c = CONNECTORS[name];
  if (!c) throw new Error(`Unknown agent "${name}". Use one of: ${Object.keys(CONNECTORS).join(', ')}.`);
  if (model) throw new Error(`Choosing a model is supported for claude-code only, not ${name}.`);
  return c;
}

export function detectAgents(): string[] {
  return Object.values(CONNECTORS)
    .filter((c) => c.available())
    .map((c) => c.name);
}

/** Pull the first JSON value (object or array) out of an agent's free-text answer. */
export function extractJson<T>(text: string): T | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const open = c[start];
    const close = open === '[' ? ']' : '}';
    const end = c.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1)) as T;
    } catch {}
  }
  return undefined;
}

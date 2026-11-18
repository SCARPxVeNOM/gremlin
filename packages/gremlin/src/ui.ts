import pc from 'picocolors';
import type { Flow } from './core/flow.ts';
import type { KaneEvent } from './core/kane.ts';
import type { Reporter } from './core/runner.ts';
import type { BugRecord, RunRecord } from './core/store.ts';

export const g = {
  brand: (s: string) => pc.bold(pc.green(s)),
  dim: pc.dim,
  bold: pc.bold,
  ok: (s: string) => pc.green(s),
  bad: (s: string) => pc.red(s),
  warn: (s: string) => pc.yellow(s),
  info: (s: string) => pc.cyan(s),
};

export function banner(sub?: string) {
  const line = `${pc.bold('👹 gremlin')}${sub ? pc.dim('  ' + sub) : ''}`;
  console.log(`\n${line}\n`);
}

export function consoleReporter(opts: { verbose?: boolean } = {}): Reporter {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.log(pc.yellow(m)),
    kane: (_flow: Flow, e: KaneEvent) => {
      if (e.kind === 'step-end') {
        const mark = e.status === 'passed' ? pc.green('✓') : e.status === 'failed' ? pc.red('✗') : pc.dim('–');
        const t = e.durationS !== undefined ? pc.dim(` ${e.durationS}s`) : '';
        console.log(`    ${mark} ${e.heading}${t}${e.status === 'failed' && e.reason ? pc.dim(`\n      ${e.reason}`) : ''}`);
      } else if (e.kind === 'mode' && opts.verbose) {
        console.log(pc.dim(`      ${e.mode === 'replay' ? 'replaying recording' : 'authoring with Kane'}`));
      } else if (e.kind === 'action' && opts.verbose) {
        console.log(pc.dim(`      · ${e.detail}`));
      } else if (e.kind === 'verdict') {
        const v = e.verdict;
        console.log(pc.dim(`      Kane triage: ${v.family ?? '?'}${v.category ? `/${v.category}` : ''}${v.confidence ? ` (${Math.round(v.confidence * 100)}%)` : ''}: ${v.oneLiner ?? ''}`));
      } else if (e.kind === 'error') {
        console.log(pc.red(`      kane-cli: ${e.message}`));
      }
    },
  };
}

export const sevColor = (s: string) => (s === 'critical' ? pc.red(pc.bold(s)) : s === 'high' ? pc.red(s) : s === 'medium' ? pc.yellow(s) : pc.dim(s));

export const statusColor = (s: string) =>
  (({
    passed: pc.green,
    active: pc.green,
    fixed: pc.green,
    failed: pc.red,
    confirmed: pc.red,
    candidate: pc.yellow,
    fixing: pc.cyan,
    flaky: pc.yellow,
    quarantined: pc.yellow,
    escalated: pc.magenta,
    draft: pc.dim,
    retired: pc.dim,
    error: pc.magenta,
  }) as Record<string, (t: string) => string>)[s]?.(s) ?? s;

export function table(rows: string[][], headers?: string[]) {
  const all = headers ? [headers, ...rows] : rows;
  // eslint-disable-next-line no-control-regex
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const widths = all[0].map((_, i) => Math.min(60, Math.max(...all.map((r) => strip(r[i] ?? '').length))));
  const fmt = (r: string[]) =>
    r
      .map((c, i) => {
        const s = c ?? '';
        const len = strip(s).length;
        return len > widths[i] ? s.slice(0, widths[i] - 1) + '…' : s + ' '.repeat(widths[i] - len);
      })
      .join('  ');
  if (headers) {
    console.log(pc.dim(fmt(headers)));
  }
  for (const r of rows) console.log(fmt(r));
}

export function bugLine(b: BugRecord): string[] {
  return [pc.bold(b.id), sevColor(b.severity), statusColor(b.status), `${Math.round(b.confidence * 100)}%`, b.origin, b.title];
}

export function runMark(r: RunRecord): string {
  return r.status === 'passed' ? pc.green('✓') : r.status === 'flaky' ? pc.yellow('~') : r.status === 'error' ? pc.magenta('!') : pc.red('✗');
}

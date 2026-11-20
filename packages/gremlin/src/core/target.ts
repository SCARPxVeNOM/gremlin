import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import type { Project } from './config.ts';
import { onInterrupt } from './interrupt.ts';

export async function isReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return res.status > 0;
  } catch {
    return false;
  }
}

export interface AppHandle {
  startedByGremlin: boolean;
  stop: () => void;
  warned?: boolean;
}

/**
 * A dev server from another project on the same port answers just as happily, and every flow would then test
 * the wrong app. lsof names the processes listening on a local app's port and their working directories; one
 * that is neither inside the repo nor above it (Docker's proxy runs from /) belongs to something else.
 * Returns that process, or undefined when there is none or lsof can't tell.
 */
export function foreignListener(root: string, url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(u.hostname)) return undefined;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const listening = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  const pids = [...new Set((listening.stdout ?? '').split('\n').filter(Boolean))];
  if (!pids.length) return undefined;
  const cwds = spawnSync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], { encoding: 'utf8' });
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  const repo = real(top.status === 0 ? top.stdout.trim() : root);
  const related = (dir: string) => dir === repo || dir.startsWith(repo + sep) || repo.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  let pid = '';
  for (const line of (cwds.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('n') && pid) {
      const dir = real(line.slice(1));
      if (related(dir)) continue;
      const cmd = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).stdout?.trim().slice(0, 100) || 'a process';
      return `\`${cmd}\` (pid ${pid}), running in ${dir}`;
    }
  }
  return undefined;
}

function refuseForeign(project: Project): void {
  const other = foreignListener(project.root, project.config.app.url);
  if (other) {
    throw new Error(
      `Something else is answering at ${project.config.app.url}: ${other}. Every flow would test that app instead of this one. Stop it, or give this app its own port (app.url and app.start in gremlin.config.yaml).`,
    );
  }
}

/** Make sure the target answers. Start it with app.start when it doesn't, and wait until ready. */
export async function ensureApp(project: Project, log: (msg: string) => void = () => {}): Promise<AppHandle> {
  const { url, start } = project.config.app;
  if (await isReachable(url)) {
    refuseForeign(project);
    return { startedByGremlin: false, stop: () => {} };
  }
  if (!start) {
    throw new Error(`The app isn't reachable at ${url}. Start it, or set app.start in gremlin.config.yaml so Gremlin can.`);
  }
  log(`Starting the app: ${start}`);
  const child: ChildProcess = spawn(start, {
    cwd: project.root,
    shell: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
    env: { ...process.env, BROWSER: 'none' },
  });
  // keep the tail of stderr: if a change breaks startup, it's the evidence the agent needs
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
  child.stderr?.on('error', () => {});
  const release = onInterrupt(() => stop());
  const stop = () => {
    release();
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {}
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`\`${start}\` exited with code ${child.exitCode} before the app came up.${stderr.trim() ? `\n${stderr.trim().split('\n').slice(-12).join('\n')}` : ''}`);
    }
    if (await isReachable(url, 1500)) {
      // the port can be shared: ours on ::1, another project's on 127.0.0.1, and the browser may reach either
      try {
        refuseForeign(project);
      } catch (err) {
        stop();
        throw err;
      }
      log(`App is up at ${url}`);
      return { startedByGremlin: true, stop };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  throw new Error(`The app didn't answer at ${url} within 90s of running \`${start}\`.`);
}

/**
 * The agent just changed the code: make sure Kane tests the new code, not a process still running the old one.
 * An app Gremlin started is restarted. One started elsewhere can't be; it has to reload on its own (next dev, vite,
 * node --watch), so wait for it to answer again and say so once.
 */
export async function restartApp(project: Project, app: AppHandle, log: (msg: string) => void = () => {}): Promise<AppHandle> {
  const { url } = project.config.app;
  if (app.startedByGremlin) {
    log('Restarting the app so Kane tests the changed code …');
    app.stop();
    const gone = Date.now() + 10_000;
    while (Date.now() < gone && (await isReachable(url, 500))) await new Promise((r) => setTimeout(r, 250));
    return ensureApp(project, log);
  }
  if (!app.warned) {
    log(`The app at ${url} was already running, so Gremlin can't restart it. If it doesn't reload code changes, stop it and let Gremlin start it (app.start).`);
    app.warned = true;
  }
  await new Promise((r) => setTimeout(r, 1500)); // a watcher restarting on the change
  const back = Date.now() + 30_000;
  while (Date.now() < back && !(await isReachable(url, 1500))) await new Promise((r) => setTimeout(r, 500));
  return app;
}

/** Reset test data before a run, when the target offers a reset endpoint ("POST /__reset"). */
export async function resetData(project: Project): Promise<boolean> {
  const spec = project.config.app.reset;
  if (!spec) return false;
  const m = /^(GET|POST|PUT|DELETE)?\s*(\S+)$/i.exec(spec.trim());
  if (!m) return false;
  const method = (m[1] ?? 'POST').toUpperCase();
  const url = new URL(m[2], project.config.app.url).toString();
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

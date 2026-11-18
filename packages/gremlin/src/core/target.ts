import { spawn, type ChildProcess } from 'node:child_process';
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

/** Make sure the target answers. Start it with app.start when it doesn't, and wait until ready. */
export async function ensureApp(project: Project, log: (msg: string) => void = () => {}): Promise<AppHandle> {
  const { url, start } = project.config.app;
  if (await isReachable(url)) return { startedByGremlin: false, stop: () => {} };
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

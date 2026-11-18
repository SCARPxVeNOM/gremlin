import { spawn, type ChildProcess } from 'node:child_process';
import type { Project } from './config.ts';

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
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    env: { ...process.env, BROWSER: 'none' },
  });
  const stop = () => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {}
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`\`${start}\` exited with code ${child.exitCode} before the app came up.`);
    if (await isReachable(url, 1500)) {
      log(`App is up at ${url}`);
      return { startedByGremlin: true, stop };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  throw new Error(`The app didn't answer at ${url} within 90s of running \`${start}\`.`);
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

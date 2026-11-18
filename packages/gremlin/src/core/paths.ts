import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CONFIG_FILE = 'gremlin.config.yaml';

/** Walk up from `start` until a directory holding gremlin.config.yaml is found. */
export function findRoot(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ProjectPaths {
  root: string;
  config: string;
  dir: string;
  flows: string;
  bugs: string;
  runs: string;
  kane: string;
  evidence: string;
  events: string;
  ledger: string;
  lock: string;
  stats: string;
  state: string;
  reports: string;
}

export function projectPaths(root: string): ProjectPaths {
  const dir = join(root, '.gremlin');
  return {
    root,
    config: join(root, CONFIG_FILE),
    dir,
    flows: join(dir, 'flows'),
    bugs: join(dir, 'bugs'),
    runs: join(dir, 'runs'),
    kane: join(dir, 'kane'),
    evidence: join(dir, 'evidence'),
    events: join(dir, 'events.jsonl'),
    ledger: join(dir, 'ledger.jsonl'),
    lock: join(dir, 'lock.json'),
    stats: join(dir, 'stats.json'),
    state: join(dir, 'state.json'),
    reports: join(dir, 'reports'),
  };
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export const FLOW_TYPES = ['happy', 'adversarial', 'regression'] as const;

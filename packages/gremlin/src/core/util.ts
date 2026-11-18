import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from './paths.ts';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function slugify(text: string, max = 60): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'flow'
  );
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write JSON atomically so a concurrent reader (the dashboard) never sees half a file. */
export function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

export function appendJsonl(path: string, data: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(data) + '\n');
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn trailing line from a concurrent writer; skip it
    }
  }
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function shortId(): string {
  return randomBytes(3).toString('hex');
}

export function runId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `RUN-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${shortId()}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Run async tasks with a fixed concurrency, preserving input order in the results. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

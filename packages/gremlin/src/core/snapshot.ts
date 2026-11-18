import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { walk } from './discover.ts';
import { ensureDir } from './paths.ts';
import { dirname } from 'node:path';

/**
 * A snapshot of the working tree taken before a fixer runs, so Gremlin can tell exactly
 * which files the agent changed, put back anything it must not touch, and (with git)
 * revert the whole attempt.
 */
export interface Snapshot {
  root: string;
  hashes: Map<string, string>;
  /** Full contents of files the agent may not change, for restoring them. */
  guarded: Map<string, string | null>;
  gitBase?: string;
  untrackedBefore: Set<string>;
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

export function isGitRepo(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree']).ok;
}

function hashFile(path: string): string {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return '';
  }
}

function extraFiles(root: string): string[] {
  const out: string[] = [];
  const flows = join(root, '.gremlin', 'flows');
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else out.push(p);
    }
  };
  visit(flows);
  for (const f of ['.gremlin/lock.json', 'gremlin.config.yaml']) if (existsSync(join(root, f))) out.push(join(root, f));
  for (const e of readdirSync(root)) if (e.startsWith('.env')) out.push(join(root, e));
  return out;
}

export function takeSnapshot(root: string, isGuarded: (rel: string) => boolean): Snapshot {
  const hashes = new Map<string, string>();
  const guarded = new Map<string, string | null>();
  for (const abs of [...walk(root, 6000), ...extraFiles(root)]) {
    const rel = relative(root, abs).split(sep).join('/');
    hashes.set(rel, hashFile(abs));
    if (isGuarded(rel)) guarded.set(rel, readFileSync(abs, 'utf8'));
  }
  let gitBase: string | undefined;
  const untrackedBefore = new Set<string>();
  if (isGitRepo(root)) {
    const stash = git(root, ['stash', 'create']);
    gitBase = stash.out || git(root, ['rev-parse', 'HEAD']).out || undefined;
    for (const f of git(root, ['ls-files', '--others', '--exclude-standard']).out.split('\n')) if (f) untrackedBefore.add(f);
  }
  return { root, hashes, guarded, gitBase, untrackedBefore };
}

/** Files added, changed or removed since the snapshot. */
export function changedSince(snap: Snapshot): string[] {
  const now = new Map<string, string>();
  for (const abs of [...walk(snap.root, 6000), ...extraFiles(snap.root)]) {
    const rel = relative(snap.root, abs).split(sep).join('/');
    now.set(rel, hashFile(abs));
  }
  const changed = new Set<string>();
  for (const [rel, h] of now) if (snap.hashes.get(rel) !== h) changed.add(rel);
  for (const rel of snap.hashes.keys()) if (!now.has(rel)) changed.add(rel);
  return [...changed].sort();
}

/** Put guarded files back exactly as they were. Returns the files restored. */
export function restoreGuarded(snap: Snapshot, files: string[]): string[] {
  const restored: string[] = [];
  for (const rel of files) {
    const abs = join(snap.root, rel);
    if (snap.guarded.has(rel)) {
      ensureDir(dirname(abs));
      writeFileSync(abs, snap.guarded.get(rel)!);
      restored.push(rel);
    } else if (!snap.hashes.has(rel)) {
      // a new file the agent created inside a guarded path
      rmSync(abs, { force: true });
      restored.push(rel);
    }
  }
  return restored;
}

/** Revert the agent's changes to `files` using git. Returns false when the project isn't a git repo. */
export function revertFiles(snap: Snapshot, files: string[]): boolean {
  if (!snap.gitBase) return false;
  for (const rel of files) {
    const abs = join(snap.root, rel);
    if (snap.guarded.has(rel)) {
      writeFileSync(abs, snap.guarded.get(rel)!);
      continue;
    }
    const exists = spawnSync('git', ['cat-file', '-e', `${snap.gitBase}:./${rel}`], { cwd: snap.root }).status === 0;
    if (exists && !snap.untrackedBefore.has(rel)) {
      const r = spawnSync('git', ['show', `${snap.gitBase}:./${rel}`], { cwd: snap.root });
      if (r.status === 0) {
        ensureDir(dirname(abs));
        writeFileSync(abs, r.stdout);
      }
    } else if (!snap.hashes.has(rel)) {
      rmSync(abs, { force: true });
    }
  }
  return true;
}

export function diffStat(root: string, files: string[]): string {
  if (!files.length || !isGitRepo(root)) return '';
  return git(root, ['diff', '--stat', '--relative', '--', ...files]).out;
}

export function gitChangedFiles(root: string, base?: string): string[] {
  if (!isGitRepo(root)) return [];
  const files = new Set<string>();
  const ref = base ?? 'HEAD';
  const diff = base ? git(root, ['diff', '--name-only', '--relative', `${base}...HEAD`]) : { ok: true, out: '' };
  for (const f of diff.out.split('\n')) if (f) files.add(f);
  for (const f of git(root, ['diff', '--name-only', '--relative', ref]).out.split('\n')) if (f) files.add(f);
  for (const f of git(root, ['ls-files', '--others', '--exclude-standard']).out.split('\n')) if (f) files.add(f);
  return [...files];
}

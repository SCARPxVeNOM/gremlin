import type { ProjectPaths } from './paths.ts';
import { emit } from './store.ts';
import { nowIso, shortId } from './util.ts';

export type JobKind = 'guard' | 'break' | 'capture' | 'fix' | 'run' | 'init';

export interface Job {
  id: string;
  kind: JobKind;
  title: string;
  startedAt: string;
}

/** A job groups the events of one Gremlin operation so the dashboard can show it live. */
export function startJob(paths: ProjectPaths, kind: JobKind, title: string, data?: Record<string, unknown>): Job {
  const job: Job = { id: `${kind}-${shortId()}`, kind, title, startedAt: nowIso() };
  emit(paths, 'job-start', title, { kind, ...data }, job.id);
  return job;
}

export function endJob(paths: ProjectPaths, job: Job, status: 'passed' | 'failed' | 'error' | 'done', summary: string, data?: Record<string, unknown>): void {
  emit(paths, 'job-end', summary, { kind: job.kind, status, ...data }, job.id);
}

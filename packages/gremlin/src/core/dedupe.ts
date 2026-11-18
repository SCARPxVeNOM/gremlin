import type { ProjectPaths } from './paths.ts';
import { getRun, listBugs, type BugRecord, type RunRecord } from './store.ts';

const OPEN = new Set(['candidate', 'confirmed', 'fixing', 'escalated']);
const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'is', 'are', 'with', 'as', 'it', 'its', 'when', 'instead', 'shown', 'shows']);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .map((w) => w.replace(/(ies|es|s)$/, (m) => (m === 'ies' ? 'y' : '')))
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

/** Kane's defect category and the page it failed on: the fingerprint of a product bug. */
export function failureSignature(run: RunRecord | undefined): { category?: string; path?: string; title: string } {
  if (!run) return { title: '' };
  const category = run.kane?.verdict?.category ?? run.evidence?.failure?.category?.split('/').pop();
  let path: string | undefined;
  try {
    path = run.evidence?.failure?.pageUrl ? new URL(run.evidence.failure.pageUrl).pathname : undefined;
  } catch {}
  return { category, path, title: run.kane?.verdict?.title ?? run.kane?.verdict?.oneLiner ?? '' };
}

/**
 * Two attacks often trip the same defect (a catalog "negative quantity" attack and the agent's own version of it).
 * A failure is the same bug as an open one when Kane puts it in the same defect category and describes it in mostly
 * the same words (a lower bar when it also failed on the same page).
 */
export function findDuplicateBug(paths: ProjectPaths, run: RunRecord, title: string): BugRecord | undefined {
  const sig = failureSignature(run);
  if (!sig.category) return undefined;
  const mine = words(`${title} ${sig.title}`);
  let best: { bug: BugRecord; score: number } | undefined;
  for (const bug of listBugs(paths)) {
    if (!OPEN.has(bug.status) || bug.runs.includes(run.id)) continue;
    const theirs = failureSignature(getRun(paths, bug.runs[0]));
    if (theirs.category !== sig.category) continue;
    const score = overlap(mine, words(`${bug.title} ${theirs.title}`));
    const samePage = Boolean(sig.path && sig.path === theirs.path);
    if (score >= (samePage ? 0.2 : 0.34) && (!best || score > best.score)) best = { bug, score };
  }
  return best?.bug;
}

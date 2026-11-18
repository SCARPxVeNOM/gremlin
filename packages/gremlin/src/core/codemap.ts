import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { walk } from './discover.ts';

const CODE = /\.(m?[jt]sx?|vue|svelte|astro|py|rb|go|php|html|css|java|kt|swift|rs|cs)$/i;
const STOP = new Set(
  'the a an and or to of in on for with from into by is are be it this that then than as at your you user page button field click type press open go any every each should shows show visible error message app make sure not no only one two new value values ordinary valid fill form other required'.split(
    ' ',
  ),
);

export function terms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/https?:\/\/[^\s]+/g, (u) => {
          try {
            return new URL(u).pathname.replace(/[/_-]/g, ' ');
          } catch {
            return ' ';
          }
        })
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOP.has(t)),
    ),
  ];
}

export interface CodeHit {
  file: string;
  score: number;
  matched: string[];
}

/** Rank source files by how strongly they match the words of a failure. A lead for the fixer, not a verdict. */
export function likelyCode(root: string, text: string, limit = 6): CodeHit[] {
  const words = terms(text);
  if (!words.length) return [];
  const hits: CodeHit[] = [];
  for (const abs of walk(root, 4000)) {
    if (!CODE.test(abs)) continue;
    const rel = relative(root, abs).split(sep).join('/');
    if (/(^|\/)(test|tests|__tests__|spec|examples?|fixtures?)\//.test(rel) || /\.(test|spec)\./.test(rel)) continue;
    let src = '';
    try {
      src = readFileSync(abs, 'utf8').toLowerCase();
    } catch {
      continue;
    }
    let score = 0;
    const matched: string[] = [];
    const relLower = rel.toLowerCase();
    for (const w of words) {
      const inPath = relLower.includes(w);
      let count = 0;
      let idx = src.indexOf(w);
      while (idx >= 0 && count < 8) {
        count++;
        idx = src.indexOf(w, idx + w.length);
      }
      if (inPath || count) {
        matched.push(w);
        score += (inPath ? 4 : 0) + Math.min(count, 8);
      }
    }
    if (score) hits.push({ file: rel, score: score * (matched.length / words.length + 0.5), matched });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

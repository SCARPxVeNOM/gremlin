import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import YAML from 'yaml';
import { ensureDir } from './paths.ts';
import { redactText } from './redact.ts';

export interface NetworkFailure {
  method: string;
  url: string;
  status: number;
}

export interface EvidenceStep {
  ordinal: number;
  id: string;
  kind?: string;
  status: string;
  summary?: string;
  url?: string;
  screenshot?: string;
}

export interface EvidenceDigest {
  pack: string;
  failure?: {
    step?: string;
    message: string;
    pageUrl?: string;
    title?: string;
    rootCause?: string;
    category?: string;
    confidence?: number;
    severity?: string;
    suggestedFix?: string;
    screenshot?: string;
  };
  consoleErrors: string[];
  networkFailures: NetworkFailure[];
  steps: EvidenceStep[];
  /** Screenshots copied out of the pack, relative to the run's evidence dir. */
  screenshots: string[];
}

const MAX_SCREENSHOTS = 16;

/**
 * Digest a sealed Kane evidence pack (a plain zip) into the facts a fixer needs,
 * copying screenshots to `outDir`. Everything textual is redacted.
 */
export function digestEvidence(packPath: string, outDir: string): EvidenceDigest | undefined {
  if (!packPath || !existsSync(packPath)) return undefined;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(readFileSync(packPath));
  } catch {
    return undefined;
  }
  ensureDir(outDir);
  const names = Object.keys(files);
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : '');
  const yaml = (name: string) => {
    try {
      return YAML.parse(text(name)) ?? {};
    } catch {
      return {};
    }
  };

  const testRoot = names.find((n) => /^tests\/[^/]+\/result\.yaml$/.test(n))?.replace(/result\.yaml$/, '') ?? '';
  const digest: EvidenceDigest = { pack: packPath, consoleErrors: [], networkFailures: [], steps: [], screenshots: [] };

  // Steps
  const stepDirs = new Map<string, string>();
  for (const n of names) {
    const m = /^tests\/[^/]+\/steps\/([^/]+)\//.exec(n);
    if (m) stepDirs.set(m[1], n.slice(0, n.indexOf(m[1]) + m[1].length + 1));
  }
  const ordered = [...stepDirs.entries()].sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
  for (const [key, dir] of ordered) {
    let info: any = {};
    try {
      info = JSON.parse(text(`${dir}step.json`) || '{}');
    } catch {}
    digest.steps.push({
      ordinal: Number(info.ordinal ?? parseInt(key)),
      id: String(info.id ?? key),
      kind: info.kind,
      status: String(info.status ?? 'unknown'),
      summary: info.summary ? redactText(String(info.summary)) : undefined,
      url: info.url,
    });
  }

  // Failure record
  const failureFile = names.find((n) => /^tests\/[^/]+\/steps\/[^/]+\/failure\.yaml$/.test(n));
  if (failureFile) {
    const f = yaml(failureFile);
    digest.failure = {
      step: f.step,
      message: redactText(String(f.error?.message ?? f.title ?? 'Step failed')),
      pageUrl: f.page_state?.url,
      title: f.title ? redactText(String(f.title)) : undefined,
      rootCause: f.triage?.rca?.root_cause ? redactText(String(f.triage.rca.root_cause)) : undefined,
      category: f.triage?.rca?.category,
      confidence: f.triage?.rca?.confidence,
      severity: f.triage?.severity,
      suggestedFix: f.triage?.suggested_fix?.summary ? redactText(String(f.triage.suggested_fix.summary)) : undefined,
    };
  }

  // Console errors and failed requests, across every run index in the pack
  for (const n of names) {
    if (testRoot && !n.startsWith(testRoot)) continue;
    if (/logs\/\d+-console\.ndjson$/.test(n)) {
      for (const line of text(n).split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          const level = String(o.level ?? o.type ?? '').toLowerCase();
          if (level === 'error' || level === 'pageerror' || o.exception) {
            const msg = String(o.text ?? o.message ?? o.args?.join?.(' ') ?? JSON.stringify(o)).slice(0, 400);
            const clean = redactText(msg);
            if (!digest.consoleErrors.includes(clean)) digest.consoleErrors.push(clean);
          }
        } catch {}
      }
    }
    if (/logs\/\d+-network\.har$/.test(n)) {
      try {
        const har = JSON.parse(text(n));
        for (const e of har.log?.entries ?? []) {
          const status = Number(e.response?.status ?? 0);
          const url = String(e.request?.url ?? '');
          if (/favicon|\.map$|hot-update|__vite|sockjs/.test(url)) continue;
          if (status >= 400 || status === 0) {
            const item = { method: String(e.request?.method ?? 'GET'), url: redactText(url), status };
            if (!digest.networkFailures.some((x) => x.url === item.url && x.status === item.status)) digest.networkFailures.push(item);
          }
        }
      } catch {}
    }
  }
  digest.consoleErrors = digest.consoleErrors.slice(0, 20);
  digest.networkFailures = digest.networkFailures.slice(0, 20);

  // Screenshots: keep the failing step's, then spread the rest evenly
  const shots = ordered
    .map(([key, dir]) => {
      const file = ['annotated.png', 'screenshot.png', 'screenshot.jpg'].map((f) => dir + f).find((f) => files[f]);
      return file ? { key, file } : undefined;
    })
    .filter(Boolean) as { key: string; file: string }[];
  const failKey = failureFile ? /steps\/([^/]+)\//.exec(failureFile)?.[1] : undefined;
  const keep = new Set<string>();
  if (failKey) keep.add(failKey);
  const stride = Math.max(1, Math.ceil(shots.length / MAX_SCREENSHOTS));
  shots.forEach((s, i) => {
    if (keep.size < MAX_SCREENSHOTS && (i % stride === 0 || i === shots.length - 1)) keep.add(s.key);
  });
  for (const s of shots) {
    if (!keep.has(s.key)) continue;
    const ext = s.file.split('.').pop();
    const name = `step-${s.key}.${ext}`;
    writeFileSync(join(outDir, name), files[s.file]);
    digest.screenshots.push(name);
    const step = digest.steps.find((st) => s.key.startsWith(String(st.ordinal) + '-'));
    if (step) step.screenshot = name;
    if (s.key === failKey && digest.failure) digest.failure.screenshot = name;
  }

  writeFileSync(join(outDir, 'digest.json'), JSON.stringify(digest, null, 2));
  return digest;
}

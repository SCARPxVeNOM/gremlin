import { createReadStream, existsSync, readFileSync, statSync, watch, openSync, readSync, closeSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTACKS, CATEGORY_LABELS } from '../core/attacks.ts';
import { runBreaker } from '../core/breaker.ts';
import { runCapture } from '../core/capture.ts';
import { loadProject, type Project } from '../core/config.ts';
import { compileFlow, getFlow, updateFlowMeta } from '../core/flow.ts';
import { runFixer, verifyBug } from '../core/fixer.ts';
import { runGuard } from '../core/guard.ts';
import { getAgent, detectAgents } from '../core/agent.ts';
import { kaneShareLink, kaneStatus, type KaneStatus } from '../core/kane.ts';
import { runFlow } from '../core/runner.ts';
import { getBug, getRun, listBugs, listRuns, lockFlow, readEvents, readStats, saveBug, unlockFlow } from '../core/store.ts';
import { flowViews, summarize, weeklyMarkdown } from '../core/summary.ts';
import { ensureApp, isReachable } from '../core/target.ts';
import { startJob, endJob } from '../core/jobs.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function dashboardDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, 'dashboard'), join(here, '..', 'dist', 'dashboard'), join(here, '..', '..', 'dashboard', 'dist')]) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return join(here, 'dashboard');
}

function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

export interface ServeOptions {
  port: number;
  root: string;
  onReady?: (url: string) => void;
}

export async function serveDashboard(opts: ServeOptions): Promise<void> {
  const load = (): Project => loadProject(opts.root);
  const staticDir = dashboardDir();
  let busy: { kind: string; title: string; startedAt: string } | null = null;
  let kaneCache: { at: number; status: KaneStatus } | null = null;
  const kane = () => {
    if (!kaneCache || Date.now() - kaneCache.at > 60_000) kaneCache = { at: Date.now(), status: kaneStatus() };
    return kaneCache.status;
  };

  /** Run a long job in the background; the dashboard follows it through the event stream. */
  const background = (res: ServerResponse, kind: string, title: string, fn: () => Promise<unknown>) => {
    if (busy) return json(res, 409, { error: `Gremlin is busy: ${busy.title}` });
    busy = { kind, title, startedAt: new Date().toISOString() };
    json(res, 202, { started: true, kind, title });
    fn()
      .catch((err) => {
        const p = load();
        const job = startJob(p.paths, 'run', title);
        endJob(p.paths, job, 'error', (err as Error).message);
      })
      .finally(() => {
        busy = null;
      });
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      if (path.startsWith('/api/')) {
        const p = load();
        const seg = path.split('/').filter(Boolean).slice(1); // after "api"

        if (seg[0] === 'summary') return json(res, 200, { ...summarize(p), busy });
        if (seg[0] === 'flows' && seg.length === 1) return json(res, 200, flowViews(p));
        if (seg[0] === 'flows' && seg.length >= 3) {
          const id = `${seg[1]}/${seg[2]}`;
          const flow = getFlow(p.paths, id);
          if (!flow) return json(res, 404, { error: 'no such flow' });
          const action = seg[3];
          if (!action && method === 'GET') {
            const view = flowViews(p).find((f) => f.id === id);
            const runs = listRuns(p.paths, 400).filter((r) => r.flowId === id).slice(0, 30).map((r) => trimRun(r));
            return json(res, 200, { flow: view, markdown: readFileSync(flow.path, 'utf8'), kane: compileFlow(flow, p.config, p.paths).content, runs });
          }
          if (method === 'POST' && action === 'approve') {
            const next = updateFlowMeta(flow, { status: 'active' });
            lockFlow(p.paths, next, 'human (dashboard)');
            return json(res, 200, { ok: true });
          }
          if (method === 'POST' && action === 'retire') {
            updateFlowMeta(flow, { status: 'retired' });
            unlockFlow(p.paths, flow.id);
            return json(res, 200, { ok: true });
          }
          if (method === 'POST' && action === 'run') {
            return background(res, 'run', `Run ${flow.title}`, async () => {
              const job = startJob(p.paths, 'run', `Run: ${flow.title}`);
              const app = await ensureApp(p);
              try {
                const run = await runFlow(p, flow, { purpose: 'manual', job: job.id });
                endJob(p.paths, job, run.status === 'passed' ? 'passed' : 'failed', `${flow.title}: ${run.status}`);
              } finally {
                app.stop();
              }
            });
          }
        }
        if (seg[0] === 'bugs' && seg.length === 1) return json(res, 200, listBugs(p.paths));
        if (seg[0] === 'bugs' && seg[1]) {
          const bug = getBug(p.paths, seg[1]);
          if (!bug) return json(res, 404, { error: 'no such bug' });
          const action = seg[2];
          if (!action && method === 'GET') {
            const flow = flowViews(p).find((f) => f.id === bug.flowId);
            const runs = bug.runs.map((id) => getRun(p.paths, id)).filter(Boolean).map((r) => r!);
            const packages = bug.attempts.map((a) => {
              const file = join(p.root, a.promptFile);
              return existsSync(file) ? readFileSync(file, 'utf8') : '';
            });
            return json(res, 200, { bug, flow, runs, packages });
          }
          if (method === 'POST' && action === 'fix') {
            // the click is the human approval: run the loop without asking again
            const mode = p.config.loop.mode === 'suggest' ? 'suggest' : 'autonomous';
            return background(res, 'fix', `Fix ${bug.id}`, () => runFixer(p, bug.id, { mode }));
          }
          if (method === 'POST' && action === 'verify') return background(res, 'verify', `Verify ${bug.id}`, () => verifyBug(p, bug.id));
          if (method === 'POST' && action === 'reject') {
            bug.status = 'rejected';
            saveBug(p.paths, bug);
            return json(res, 200, { ok: true });
          }
        }
        if (seg[0] === 'runs' && seg.length === 1) return json(res, 200, listRuns(p.paths, Number(url.searchParams.get('limit') ?? 100)).map((r) => trimRun(r)));
        if (seg[0] === 'runs' && seg[1]) {
          const run = getRun(p.paths, seg[1]);
          return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
        }
        if (seg[0] === 'evidence' && seg[1] && seg[2]) {
          const file = normalize(join(p.paths.evidence, seg[1], seg[2]));
          if (!file.startsWith(p.paths.evidence) || !existsSync(file)) return json(res, 404, { error: 'not found' });
          res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' });
          return createReadStream(file).pipe(res);
        }
        if (seg[0] === 'events') return json(res, 200, readEvents(p.paths, Number(url.searchParams.get('limit') ?? 300)));
        if (seg[0] === 'stream') return stream(req, res, p);
        if (seg[0] === 'report') return json(res, 200, { markdown: weeklyMarkdown(p) });
        if (seg[0] === 'catalog') {
          const stats = readStats(p.paths).attacks;
          return json(
            res,
            200,
            ATTACKS.map((a) => ({ id: a.id, category: a.category, categoryLabel: CATEGORY_LABELS[a.category], name: a.name, prior: a.prior, ...(stats[a.id] ?? { tried: 0, found: 0 }) })),
          );
        }
        if (seg[0] === 'config') {
          const agent = getAgent(p.config);
          return json(res, 200, {
            raw: p.raw,
            root: p.root,
            kane: kane(),
            agent: { name: p.config.agent.name, label: agent?.label ?? 'none', available: agent?.available() ?? false, detected: detectAgents() },
            appReachable: await isReachable(p.config.app.url),
            integrations: {
              claudeHooks: existsSync(join(p.root, '.claude', 'settings.json')) && readFileSync(join(p.root, '.claude', 'settings.json'), 'utf8').includes('hook claude stop'),
              mcp: existsSync(join(p.root, '.mcp.json')) || existsSync(join(p.root, '.cursor', 'mcp.json')),
              rules: ['CLAUDE.md', 'AGENTS.md'].some((f) => existsSync(join(p.root, f)) && readFileSync(join(p.root, f), 'utf8').includes('gremlin:start')),
              ci: existsSync(join(p.root, '.github', 'workflows', 'gremlin-guard.yml')),
            },
            busy,
          });
        }
        if (method === 'POST' && seg[0] === 'capture') {
          const b = await body(req);
          if (!b.text?.trim()) return json(res, 400, { error: 'Paste a bug report first.' });
          return background(res, 'capture', 'Capture a bug report', () => runCapture(p, { text: String(b.text), source: b.source ?? 'paste', ref: b.ref }));
        }
        if (method === 'POST' && seg[0] === 'break') {
          const b = await body(req);
          return background(res, 'break', 'Breaker hunt', () => runBreaker(p, { areas: b.areas, categories: b.categories, max: b.max, useAgent: b.useAgent }));
        }
        if (method === 'POST' && seg[0] === 'guard') {
          const b = await body(req);
          return background(res, 'guard', 'Guard replay', () => runGuard(p, { all: b.all ?? true }));
        }
        return json(res, 404, { error: 'unknown endpoint' });
      }

      // Static dashboard (SPA)
      let file = normalize(join(staticDir, decodeURIComponent(path)));
      if (!file.startsWith(resolve(staticDir)) || !existsSync(file) || statSync(file).isDirectory()) file = join(staticDir, 'index.html');
      if (!existsSync(file)) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('Dashboard assets are missing. Build them with `npm run build` in the Gremlin repo.');
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-store' : 'max-age=31536000, immutable' });
      createReadStream(file).pipe(res);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolveListen());
  });
  opts.onReady?.(`http://127.0.0.1:${opts.port}`);
}

/** Server-sent events: tail .gremlin/events.jsonl, which every Gremlin process appends to. */
function stream(req: IncomingMessage, res: ServerResponse, p: Project) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': connected\n\n');
  let offset = existsSync(p.paths.events) ? statSync(p.paths.events).size : 0;
  let partial = '';
  const pump = () => {
    if (!existsSync(p.paths.events)) return;
    const size = statSync(p.paths.events).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fd = openSync(p.paths.events, 'r');
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const text = partial + buf.toString('utf8');
    const lines = text.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) res.write(`data: ${line}\n\n`);
  };
  const timer = setInterval(pump, 700);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(p.paths.dir, (_, f) => f === 'events.jsonl' && pump());
  } catch {}
  req.on('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    watcher?.close();
  });
}

function trimRun(r: NonNullable<ReturnType<typeof getRun>>) {
  const { kane, evidence, ...rest } = r;
  return {
    ...rest,
    kane: kane
      ? {
          status: kane.status,
          reason: kane.reason,
          oneLiner: kane.oneLiner,
          failedStep: kane.failedStep ? { heading: kane.failedStep.heading } : undefined,
          verdict: kane.verdict,
          durationS: kane.durationS,
          replayed: kane.replayed,
          authored: kane.authored,
          shareUrl: kaneShareLink(kane),
          steps: kane.steps.map((s) => ({ index: s.index, heading: s.heading, status: s.status, durationS: s.durationS })),
        }
      : undefined,
    evidence: evidence ? { screenshots: evidence.screenshots, failure: evidence.failure, consoleErrors: evidence.consoleErrors.length, networkFailures: evidence.networkFailures.length } : undefined,
  };
}

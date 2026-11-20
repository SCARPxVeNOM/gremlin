import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, type Project } from '../src/core/config.ts';
import { projectPaths } from '../src/core/paths.ts';
import type { BugRecord, RunRecord } from '../src/core/store.ts';

// Stand-ins: a `claude` whose fix depends on the model it is given, and a `kane-cli` that passes
// the flow only when the running shop really upper-cases coupon codes.
const bin = mkdtempSync(join(tmpdir(), 'gremlin-arena-bin-'));
writeFileSync(
  join(bin, 'claude'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
fs.readFileSync(0, 'utf8');
const src = fs.readFileSync('server.js', 'utf8');
if (model === 'opus') {
  fs.writeFileSync('server.js', src.replace('coupons[code]', 'coupons[normalise(code)]') + '\\nfunction normalise(code) {\\n  // codes are stored in capitals\\n  const s = String(code ?? "");\\n  return s.trim().toUpperCase();\\n}\\n');
} else if (model === 'sonnet') {
  fs.writeFileSync('server.js', src.replace('coupons[code]', 'coupons[String(code).toUpperCase()]'));
} else {
  fs.writeFileSync('server.js', src + '// TODO: coupons\\n');
  fs.writeFileSync('gremlin.config.yaml', fs.readFileSync('gremlin.config.yaml', 'utf8') + '# quietly weakened\\n');
}
console.log(JSON.stringify({ type: 'result', result: model + ' is done' }));
`,
);
writeFileSync(
  join(bin, 'kane-cli'),
  `#!/usr/bin/env node
const http = require('node:http');
const url = require('node:fs').readFileSync(process.argv[4], 'utf8').match(/^url: (.*)$/m)[1];
http.get(new URL('/coupon?code=welcome10', url), (res) => {
  let body = '';
  res.on('data', (c) => (body += c));
  res.on('end', () => {
    const ok = body === '10%';
    const out = (o) => console.log(JSON.stringify(o));
    out({ type: 'test_md_step_start', step_index: 1, heading: 'Check the expected outcome' });
    out({ type: 'test_md_step_end', step_index: 1, status: ok ? 'passed' : 'failed', duration_s: 1 });
    out({ type: 'run_end', status: ok ? 'passed' : 'failed', reason: ok ? undefined : 'The coupon was rejected.', credits_consumed: 0 });
    out({ type: 'test_md_done', overall_status: ok ? 'passed' : 'failed' });
    process.exit(ok ? 0 : 1);
  });
});
`,
);
chmodSync(join(bin, 'claude'), 0o755);
chmodSync(join(bin, 'kane-cli'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.GREMLIN_KANE_BIN = join(bin, 'kane-cli');
process.env.GREMLIN_KANE_LOCK = join(bin, 'kane.lock'); // stand-ins share no browser, and a real run elsewhere must not hold this up

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

test('the arena gives every agent the same bug, Kane judges each fix, and the smallest passing fix wins', async () => {
  const { saveFlow } = await import('../src/core/flow.ts');
  const { saveBug, saveRun, getBug, readLock } = await import('../src/core/store.ts');
  const { runArena } = await import('../src/core/arena.ts');

  const root = mkdtempSync(join(tmpdir(), 'gremlin-arena-shop-'));
  const port = 43000 + Math.floor(Math.random() * 2000);
  const yaml = `app:\n  name: Shop\n  url: http://127.0.0.1:${port}\n  start: node app.mjs\n`;
  writeFileSync(join(root, 'gremlin.config.yaml'), yaml);
  writeFileSync(join(root, 'server.js'), "export const coupons = { WELCOME10: '10%' };\nexport const find = (code) => coupons[code];\n");
  writeFileSync(
    join(root, 'app.mjs'),
    `import http from 'node:http';\nconst { find } = await import('./server.js?' + Date.now());\nhttp.createServer((q, s) => s.end(String(find(new URL(q.url, 'http://x').searchParams.get('code')) ?? 'invalid'))).listen(${port}, '127.0.0.1');\n`,
  );
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(root, '.gremlin'), { recursive: true });
  writeFileSync(join(root, '.gremlin', '.gitignore'), 'runs/\nevidence/\nevents.jsonl\nstate.json\nledger.jsonl\nstats.json\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.com');
  git(root, 'config', 'user.name', 'Dev');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'shop');

  const p = { root, paths: projectPaths(root), config: ConfigSchema.parse({ app: { name: 'Shop', url: `http://127.0.0.1:${port}`, start: 'node app.mjs' } }), raw: {} } as Project;
  const flow = saveFlow(p.paths, {
    title: 'A lowercase coupon code is accepted',
    type: 'regression',
    start: '/',
    source: 'capture:paste',
    status: 'confirmed',
    tags: ['checkout'],
    steps: ['Type welcome10 into the "Coupon code" field and click "Apply"'],
    expect: ['A message says the 10% welcome discount was applied'],
  });
  const red: RunRecord = {
    id: 'RUN-20261120-090000-aaaaaa',
    flowId: flow.id,
    flowTitle: flow.title,
    flowType: 'regression',
    flowHash: flow.hash,
    purpose: 'capture',
    target: p.config.app.url,
    startedAt: '2026-11-20T09:00:00.000Z',
    status: 'failed',
    credits: 0,
    kane: { status: 'failed', exitCode: 1, steps: [], credits: 0, durationS: 1, replayed: 0, authored: 0, healed: false, errors: [], logPath: '', reason: 'The coupon was rejected.' },
  };
  saveRun(p.paths, red);
  const bug: BugRecord = {
    id: 'BUG-001',
    title: 'Lowercase coupon codes are rejected',
    origin: 'capture',
    status: 'confirmed',
    severity: 'high',
    confidence: 0.9,
    flowId: flow.id,
    tags: ['checkout'],
    runs: [red.id],
    attempts: [],
    createdAt: '',
    updatedAt: '',
    credits: 0,
  };
  saveBug(p.paths, bug);

  const r = await runArena(p, 'BUG-001', ['claude-code:opus', 'claude-code:sonnet', 'claude-code:haiku']);
  const by = Object.fromEntries(r.entries.map((e) => [e.contender, e]));

  assert.equal(r.outcome, 'fixed');
  assert.equal(r.winner?.contender, 'claude-code:sonnet', 'the smallest fix that Kane passed');
  assert.equal(by['claude-code:sonnet'].result, 'won');
  assert.deepEqual([by['claude-code:sonnet'].added, by['claude-code:sonnet'].removed], [1, 1]);
  assert.equal(by['claude-code:opus'].result, 'passed', 'it works, but it is the bigger change');
  assert.ok(by['claude-code:opus'].added > 1);
  assert.equal(by['claude-code:haiku'].result, 'failed', 'Kane rejects a fix that does not fix it');
  assert.deepEqual(by['claude-code:haiku'].blocked, ['gremlin.config.yaml'], 'its edit to the config was dropped from its patch');

  // only the winner's change is left in the tree, and no contender's worktree is
  assert.match(readFileSync(join(root, 'server.js'), 'utf8'), /coupons\[String\(code\)\.toUpperCase\(\)\]/);
  assert.doesNotMatch(readFileSync(join(root, 'server.js'), 'utf8'), /normalise|TODO/);
  assert.doesNotMatch(readFileSync(join(root, 'gremlin.config.yaml'), 'utf8'), /weakened/);
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);

  // the bug is fixed the same way the Fixer fixes one: the flow is locked into the regression library
  const saved = getBug(p.paths, 'BUG-001')!;
  assert.equal(saved.status, 'fixed');
  assert.equal(saved.arena?.winner, 'claude-code:sonnet');
  assert.equal(saved.attempts.at(-1)?.agent, 'Claude Code (sonnet)');
  assert.equal(readLock(p.paths).flows[saved.flowId]?.by, 'arena:claude-code:sonnet');
  const report = readFileSync(r.reportFile!, 'utf8');
  assert.match(report, /\| Claude Code \(sonnet\) \| \d+s \| `server.js` \| \+1 −1 \| `RUN-[^`]+` \| 🏆 Winner \|/);
  assert.match(report, /Claude Code \(haiku\) also changed protected files \(gremlin\.config\.yaml\)/);
  assert.ok(existsSync(join(p.paths.bugs, 'BUG-001', 'arena-package.md')));
});

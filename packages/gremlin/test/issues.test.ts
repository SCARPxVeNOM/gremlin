import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, type Project } from '../src/core/config.ts';
import { projectPaths } from '../src/core/paths.ts';
import type { BugRecord, RunRecord } from '../src/core/store.ts';

// A stand-in for the GitHub CLI: it answers the calls the issue autopilot makes and logs every one.
const scratch = mkdtempSync(join(tmpdir(), 'gremlin-gh-'));
const ghLog = join(scratch, 'gh-log.jsonl');
const fakeGh = join(scratch, 'gh');
writeFileSync(
  fakeGh,
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stdin = args.includes('-') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ args, stdin, repo: process.env.GH_REPO }) + '\\n');
const [a, b] = args;
if (a === 'repo' && b === 'view') console.log(JSON.stringify({ nameWithOwner: 'acme/shop', defaultBranchRef: { name: 'main' } }));
else if (a === 'pr' && b === 'create') console.log('https://github.com/acme/shop/pull/43');
else if (a === 'issue' && b === 'list') console.log(process.env.FAKE_GH_ISSUES ?? '[]');
`,
);
chmodSync(fakeGh, 0o755);
process.env.GREMLIN_GH_BIN = fakeGh;

const ghCalls = (): { args: string[]; stdin: string; repo?: string }[] =>
  existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function shopRepo(): Project {
  const root = mkdtempSync(join(tmpdir(), 'gremlin-shop-'));
  const remote = mkdtempSync(join(tmpdir(), 'gremlin-remote-'));
  git(remote, 'init', '--bare', '-q', '-b', 'main');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.com');
  git(root, 'config', 'user.name', 'Dev');
  writeFileSync(join(root, 'gremlin.config.yaml'), 'app:\n  name: Shop\n  url: http://localhost:4000\n');
  mkdirSync(join(root, '.gremlin'), { recursive: true });
  writeFileSync(join(root, '.gremlin', '.gitignore'), 'runs/\nevidence/\nevents.jsonl\nstate.json\nledger.jsonl\nstats.json\n');
  writeFileSync(join(root, 'server.js'), "const coupon = coupons[code];\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'shop');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  const config = ConfigSchema.parse({ app: { name: 'Shop', url: 'http://localhost:4000' } });
  return { root, paths: projectPaths(root), config, raw: {} } as Project;
}

function run(id: string, status: RunRecord['status'], shots: string[], failure?: string): RunRecord {
  return {
    id,
    flowId: 'regression/coupon',
    flowTitle: 'A lowercase coupon is accepted',
    flowType: 'regression',
    flowHash: 'x',
    purpose: status === 'failed' ? 'capture' : 'fix',
    target: 'http://localhost:4000',
    startedAt: '2026-11-20T10:00:00.000Z',
    status,
    credits: 7,
    kane:
      status === 'failed'
        ? ({ failedStep: { heading: 'Type welcome10 and click "Apply"' }, reason: 'The coupon was rejected as not valid.', errors: [] } as any)
        : ({ errors: [] } as any),
    evidence: { pack: '', consoleErrors: [], networkFailures: [], steps: [], screenshots: shots, failure: failure ? { message: 'rejected', screenshot: failure } : undefined },
  };
}

test('a proven fix is committed on a branch and opened as a pull request with Kane’s before and after', async () => {
  const { saveFlow } = await import('../src/core/flow.ts');
  const { saveBug, saveRun } = await import('../src/core/store.ts');
  const { openFixPr } = await import('../src/core/issues.ts');
  const p = shopRepo();

  const flow = saveFlow(p.paths, {
    title: 'A lowercase coupon code is accepted',
    type: 'regression',
    start: '/checkout',
    source: 'capture:github:#42',
    status: 'active',
    tags: ['checkout'],
    steps: ['Type welcome10 into the "Coupon code" field and click "Apply"'],
    expect: ['A message says the 10% welcome discount was applied'],
  });
  const red = run('RUN-20261120-100000-aaaaaa', 'failed', ['step-1.jpg', 'step-3.jpg'], 'step-3.jpg');
  const green = run('RUN-20261120-100500-bbbbbb', 'passed', ['step-1.jpg', 'step-4.jpg']);
  for (const [r, files] of [[red, ['step-1.jpg', 'step-3.jpg']], [green, ['step-1.jpg', 'step-4.jpg']]] as const) {
    mkdirSync(join(p.paths.evidence, r.id), { recursive: true });
    for (const f of files) writeFileSync(join(p.paths.evidence, r.id, f), `${r.id}/${f}`);
    saveRun(p.paths, r);
  }
  const bug: BugRecord = {
    id: 'BUG-001',
    title: 'Lowercase coupon codes are rejected',
    origin: 'capture',
    status: 'fixed',
    severity: 'high',
    confidence: 0.9,
    flowId: flow.id,
    tags: ['checkout'],
    runs: [red.id, green.id],
    attempts: [
      { n: 1, at: '', agent: 'claude-code', promptFile: '', changedFiles: ['server.js'], outsideArea: [], blocked: [], runId: green.id, relatedRuns: ['RUN-20261120-100600-cccccc'], result: 'passed', agentSummary: 'Codes are stored in capitals; normalise before lookup.' },
    ],
    createdAt: '',
    updatedAt: '',
    credits: 54,
  };
  saveBug(p.paths, bug);
  writeFileSync(join(p.root, 'server.js'), "const coupon = coupons[String(code).toUpperCase()];\n"); // the agent's fix

  const url = openFixPr(p, { number: 42, title: 'Coupon rejected', url: 'https://github.com/acme/shop/issues/42' }, bug, red);
  assert.equal(url, 'https://github.com/acme/shop/pull/43');

  // the user's checkout is back where it was, untouched
  assert.equal(git(p.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(p.root, 'status', '--porcelain'), '');
  assert.match(readFileSync(join(p.root, 'server.js'), 'utf8'), /coupons\[code\]/);

  // the branch carries the fix, the regression flow, the bug and Kane's screenshots, but not local run artifacts
  const branch = 'gremlin/bug-001-issue-42';
  const files = git(p.root, 'ls-tree', '-r', '--name-only', `origin/${branch}`).split('\n');
  assert.ok(files.includes('server.js'));
  assert.ok(files.includes(`.gremlin/flows/${flow.id}.md`), 'the regression flow ships with the fix');
  assert.ok(files.includes('.gremlin/bugs/BUG-001.json'));
  assert.ok(files.includes('.gremlin/bugs/BUG-001/kane-before.jpg'));
  assert.ok(files.includes('.gremlin/bugs/BUG-001/kane-after.jpg'));
  assert.ok(!files.some((f) => f.startsWith('.gremlin/evidence/') || f.startsWith('.gremlin/runs/')));
  assert.match(git(p.root, 'show', `origin/${branch}:server.js`), /toUpperCase/);
  assert.equal(git(p.root, 'show', `origin/${branch}:.gremlin/bugs/BUG-001/kane-before.jpg`), `${red.id}/step-3.jpg`, 'before = the failing step');
  assert.equal(git(p.root, 'show', `origin/${branch}:.gremlin/bugs/BUG-001/kane-after.jpg`), `${green.id}/step-4.jpg`, 'after = the last step of the passing run');
  assert.match(git(p.root, 'log', '-1', '--format=%B', `origin/${branch}`), /Fixes #42/);

  const create = ghCalls().find((c) => c.args[0] === 'pr' && c.args[1] === 'create')!;
  assert.deepEqual(create.args.slice(0, 6), ['pr', 'create', '--base', 'main', '--head', branch]);
  const sha = git(p.root, 'rev-parse', `origin/${branch}`);
  assert.ok(create.stdin.includes(`https://github.com/acme/shop/blob/${sha}/.gremlin/bugs/BUG-001/kane-before.jpg?raw=true`));
  assert.match(create.stdin, /🔴 Before .*Failed at “Type welcome10 and click "Apply"”: The coupon was rejected/);
  assert.match(create.stdin, /🟢 After .*Passed on attempt 1 of 1/);
  assert.match(create.stdin, /Related flows .*All passed/);
  assert.match(create.stdin, /1\. Type welcome10 into the "Coupon code" field/);
  assert.match(create.stdin, /\nFixes #42$/);
  assert.match(create.stdin, /handed it to Claude Code\./, 'the agent by its name, not its id');
});

test('the watcher only picks up labeled issues Gremlin has not started on', async () => {
  const { pendingIssues } = await import('../src/core/issues.ts');
  const p = shopRepo();
  process.env.FAKE_GH_ISSUES = JSON.stringify([
    { number: 7, labels: [{ name: 'gremlin' }] },
    { number: 3, labels: [{ name: 'gremlin' }, { name: 'bug' }] },
    { number: 5, labels: [{ name: 'gremlin' }, { name: 'gremlin:fix-proposed' }] },
    { number: 9, labels: [{ name: 'gremlin' }, { name: 'gremlin:working' }] },
  ]);
  assert.deepEqual(pendingIssues(p, 'gremlin'), [3, 7]);
  const list = ghCalls().findLast((c) => c.args[0] === 'issue' && c.args[1] === 'list')!;
  assert.ok(list.args.includes('--label') && list.args.includes('gremlin'));
});

test("uncommitted product changes block the loop, Gremlin's own records don't", async () => {
  const { uncommittedChanges } = await import('../src/core/snapshot.ts');
  const p = shopRepo();
  writeFileSync(join(p.root, '.gremlin', 'lock.json'), '{"flows":{}}\n'); // new and untracked
  mkdirSync(join(p.root, '.gremlin', 'bugs'), { recursive: true });
  writeFileSync(join(p.root, '.gremlin', 'bugs', 'BUG-001.json'), '{}');
  assert.deepEqual(uncommittedChanges(p.root), []);
  git(p.root, 'add', '.gremlin/lock.json');
  git(p.root, 'commit', '-q', '-m', 'lock');
  writeFileSync(join(p.root, '.gremlin', 'lock.json'), '{"flows":{"x":1}}\n'); // " M .gremlin/lock.json" as the first entry
  assert.deepEqual(uncommittedChanges(p.root), []);
  writeFileSync(join(p.root, 'server.js'), 'changed\n');
  writeFileSync(join(p.root, 'new file.js'), 'x\n');
  assert.deepEqual(uncommittedChanges(p.root).sort(), ['new file.js', 'server.js']);
});

test('a bug number held by an open fix branch is not handed out again', async () => {
  const { reserveOpenFixBranches } = await import('../src/core/issues.ts');
  const { nextBugId } = await import('../src/core/store.ts');
  const p = shopRepo();
  assert.equal(nextBugId(p.paths), 'BUG-001');
  git(p.root, 'push', '-q', 'origin', 'main:gremlin/bug-004-issue-9'); // an open PR's branch, not merged yet
  reserveOpenFixBranches(p);
  assert.equal(nextBugId(p.paths), 'BUG-005');
});

test('a bug the Breaker found becomes a pull request of its own, and only the fix goes in', async () => {
  const { saveFlow } = await import('../src/core/flow.ts');
  const { saveBug, saveRun } = await import('../src/core/store.ts');
  const { openBugPr } = await import('../src/core/issues.ts');
  const p = shopRepo();
  // a clone made by `gh repo fork --clone`: gh's own default is upstream, but the fix belongs on the fork
  const bare = git(p.root, 'remote', 'get-url', 'origin');
  git(p.root, 'remote', 'set-url', 'origin', 'https://github.com/me/shop.git');
  git(p.root, 'remote', 'set-url', '--push', 'origin', bare);
  git(p.root, 'remote', 'add', 'upstream', 'https://github.com/acme/shop.git');
  git(p.root, 'config', 'remote.upstream.gh-resolved', 'base');
  const flow = saveFlow(p.paths, {
    title: 'A lowercase coupon code is accepted',
    type: 'adversarial',
    start: '/checkout',
    source: 'breaker',
    status: 'active',
    tags: ['checkout'],
    steps: ['Type welcome10 into the "Coupon code" field and click "Apply"'],
    expect: ['A message says the 10% welcome discount was applied'],
  });
  const red = run('RUN-20261120-110000-aaaaaa', 'failed', ['step-1.jpg']);
  const green = run('RUN-20261120-110500-bbbbbb', 'passed', ['step-1.jpg']);
  saveRun(p.paths, red);
  saveRun(p.paths, green);
  const bug: BugRecord = {
    id: 'BUG-001',
    title: 'Lowercase coupon codes are rejected',
    origin: 'breaker',
    status: 'fixed',
    severity: 'high',
    confidence: 0.98,
    flowId: flow.id,
    tags: ['checkout'],
    verdict: { confirmed: true, family: 'application_issue', confidence: 0.98 },
    runs: [red.id, green.id],
    attempts: [{ n: 1, at: '', agent: 'claude-code', promptFile: '', changedFiles: ['server.js'], outsideArea: [], blocked: [], runId: green.id, result: 'passed' }],
    createdAt: '',
    updatedAt: '',
    credits: 40,
  };
  saveBug(p.paths, bug);
  writeFileSync(join(p.root, 'server.js'), 'const coupon = coupons[String(code).toUpperCase()];\n');

  writeFileSync(join(p.root, 'notes.txt'), 'my own work in progress\n');
  assert.throws(() => openBugPr(p, 'BUG-001'), /notes\.txt/, 'unrelated work never rides along');
  git(p.root, 'add', 'notes.txt');
  git(p.root, 'commit', '-q', '-m', 'notes');

  assert.equal(openBugPr(p, 'BUG-001'), 'https://github.com/acme/shop/pull/43');
  const create = ghCalls().findLast((c) => c.args[0] === 'pr' && c.args[1] === 'create')!;
  assert.deepEqual(create.args.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', 'gremlin/bug-001', '--title', 'Fix: Lowercase coupon codes are rejected']);
  assert.match(create.stdin, /^### 👹 Fixes BUG-001:/);
  assert.match(create.stdin, /Breaker found this by attacking the app .*98% sure/);
  assert.doesNotMatch(create.stdin, /Fixes #/);
  assert.match(git(p.root, 'show', 'origin/gremlin/bug-001:server.js'), /toUpperCase/);
  const [view, created] = ghCalls().slice(-2);
  assert.deepEqual(view.args.slice(0, 3), ['repo', 'view', 'me/shop'], '`gh repo view` ignores GH_REPO, so the fork is named');
  assert.equal(created.repo, 'me/shop', 'the pull request is opened on the fork it was pushed to, never upstream');
});

test('the repo gh works on is read from origin', async () => {
  const { originRepo } = await import('../src/core/capture.ts');
  const p = shopRepo();
  assert.equal(originRepo(p.root), undefined, 'a remote that is not a GitHub repo leaves gh to its own default');
  for (const [url, repo] of [
    ['https://github.com/me/it-tools.git', 'me/it-tools'],
    ['https://x-access-token:abc@github.com/me/it-tools', 'me/it-tools'],
    ['git@github.com:me/it-tools.git', 'me/it-tools'],
    ['https://ghe.acme.dev/team/shop.git', 'ghe.acme.dev/team/shop'],
  ]) {
    git(p.root, 'remote', 'set-url', 'origin', url);
    assert.equal(originRepo(p.root), repo, url);
  }
});

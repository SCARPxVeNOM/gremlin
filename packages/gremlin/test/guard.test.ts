import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, type Project } from '../src/core/config.ts';
import { projectPaths } from '../src/core/paths.ts';
import type { BugRecord } from '../src/core/store.ts';
import type { Reporter } from '../src/core/runner.ts';

// Stand-ins: a `kane-cli` that walks the compiled flow and fails the step whose heading starts with FAKE_KANE_FAIL
// (every step passes when it's unset), and a `gh` that opens pull request #43.
const bin = mkdtempSync(join(tmpdir(), 'gremlin-guard-bin-'));
writeFileSync(
  join(bin, 'kane-cli'),
  `#!/usr/bin/env node
const headings = [...require('node:fs').readFileSync(process.argv[4], 'utf8').matchAll(/^## (.*)$/gm)].map((m) => m[1]);
const fail = process.env.FAKE_KANE_FAIL;
const out = (o) => console.log(JSON.stringify(o));
let failed = false;
for (const [i, heading] of headings.entries()) {
  failed = Boolean(fail) && heading.startsWith(fail);
  out({ type: 'test_md_step_start', step_index: i + 1, heading });
  out({ type: 'test_md_step_end', step_index: i + 1, status: failed ? 'failed' : 'passed', duration_s: 1 });
  if (failed) break; // Kane stops at the first check that fails
}
out({ type: 'run_end', status: failed ? 'failed' : 'passed', reason: failed ? 'The check did not hold.' : undefined, credits_consumed: 0 });
out({ type: 'test_md_done', overall_status: failed ? 'failed' : 'passed' });
process.exit(failed ? 1 : 0);
`,
);
writeFileSync(
  join(bin, 'gh'),
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('-')) require('node:fs').readFileSync(0, 'utf8');
if (args[0] === 'repo' && args[1] === 'view') console.log(JSON.stringify({ nameWithOwner: 'acme/shop', defaultBranchRef: { name: 'main' } }));
else if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/acme/shop/pull/43');
`,
);
chmodSync(join(bin, 'kane-cli'), 0o755);
chmodSync(join(bin, 'gh'), 0o755);
process.env.GREMLIN_KANE_BIN = join(bin, 'kane-cli');
process.env.GREMLIN_KANE_LOCK = join(bin, 'kane.lock'); // stand-ins share no browser, and a real run elsewhere must not hold this up
process.env.GREMLIN_GH_BIN = join(bin, 'gh');

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A shop in a git repo with a remote, an app Gremlin can start, and these behaviour contracts. */
function shop(contracts: string[] = []): Project {
  const root = mkdtempSync(join(tmpdir(), 'gremlin-guard-shop-'));
  const remote = mkdtempSync(join(tmpdir(), 'gremlin-guard-remote-'));
  const port = 47000 + Math.floor(Math.random() * 2000);
  const app = { name: 'Shop', url: `http://127.0.0.1:${port}`, start: 'node app.mjs' };
  writeFileSync(join(root, 'gremlin.config.yaml'), `app:\n  name: Shop\n  url: ${app.url}\n  start: ${app.start}\n`);
  writeFileSync(join(root, 'app.mjs'), `import http from 'node:http';\nhttp.createServer((q, s) => s.end('shop')).listen(${port}, '127.0.0.1');\n`);
  writeFileSync(join(root, 'server.js'), 'const coupon = coupons[code];\n');
  mkdirSync(join(root, '.gremlin'), { recursive: true });
  writeFileSync(join(root, '.gremlin', '.gitignore'), 'runs/\nevidence/\nevents.jsonl\nstate.json\nledger.jsonl\nstats.json\n');
  git(remote, 'init', '--bare', '-q', '-b', 'main');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.com');
  git(root, 'config', 'user.name', 'Dev');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'shop');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  return { root, paths: projectPaths(root), config: ConfigSchema.parse({ app, contracts }), raw: {} } as Project;
}

function listening(): { said: string[]; reporter: Reporter } {
  const said: string[] = [];
  return { said, reporter: { info: (m) => said.push(m), warn: (m) => said.push(m) } };
}

test("a fix waiting in an open pull request is not a regression on main, until it's merged", async () => {
  const { KANE_BIN } = await import('../src/core/kane.ts');
  assert.equal(KANE_BIN, join(bin, 'kane-cli'), 'only ever the stand-in');
  const { saveFlow } = await import('../src/core/flow.ts');
  const { getBug, listBugs, lockFlow, saveBug } = await import('../src/core/store.ts');
  const { openBugPr } = await import('../src/core/issues.ts');
  const { guardBrief, guardMarkdown, runGuard } = await import('../src/core/guard.ts');
  const p = shop();

  // BUG-001 is fixed and its repro is a locked regression flow, the way the Fixer leaves it
  const flow = saveFlow(p.paths, {
    title: 'A lowercase coupon code is accepted',
    type: 'regression',
    start: '/',
    source: 'capture:paste',
    status: 'active',
    tags: ['checkout'],
    bug: 'BUG-001',
    steps: ['Type welcome10 into the "Coupon code" field and click "Apply"'],
    expect: ['A message says the 10% welcome discount was applied'],
  });
  lockFlow(p.paths, flow, 'fixer');
  const bug: BugRecord = {
    id: 'BUG-001',
    title: 'Lowercase coupon codes are rejected',
    origin: 'capture',
    status: 'fixed',
    severity: 'high',
    confidence: 0.9,
    flowId: flow.id,
    tags: ['checkout'],
    runs: [],
    attempts: [{ n: 1, at: '', agent: 'claude-code', promptFile: '', changedFiles: ['server.js'], outsideArea: [], blocked: [], result: 'passed' }],
    createdAt: '',
    updatedAt: '',
    fixedAt: '2026-11-20T10:00:00.000Z',
    credits: 0,
  };
  saveBug(p.paths, bug);
  writeFileSync(join(p.root, 'server.js'), 'const coupon = coupons[String(code).toUpperCase()];\n'); // the agent's fix

  const url = openBugPr(p, 'BUG-001');
  assert.equal(url, 'https://github.com/acme/shop/pull/43');
  assert.equal(git(p.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.match(readFileSync(join(p.root, 'server.js'), 'utf8'), /coupons\[code\]/, 'main does not have the fix');

  // nor does the Fixer hold it against the next fix made on main: it isn't one of that fix's related flows
  const { relatedFlows } = await import('../src/core/fixer.ts');
  const next = saveFlow(p.paths, {
    title: 'A second coupon code is accepted',
    type: 'adversarial',
    start: '/',
    source: 'breaker',
    status: 'draft',
    tags: ['checkout'],
    steps: ['Type kiln20 into the "Coupon code" field and click "Apply"'],
    expect: ['A message says the 20% discount was applied'],
  });
  assert.deepEqual(relatedFlows(p, next).map((f) => f.id), [], "BUG-001's flow waits for its pull request");

  // so on main, Kane fails the regression flow: that's the fix not being merged, not the bug coming back
  process.env.FAKE_KANE_FAIL = 'Check the expected outcome';
  const before = listening();
  const waiting = await runGuard(p, { flowIds: [flow.id], reporter: before.reporter });
  const [r] = waiting.results;
  assert.equal(r.run?.status, 'failed', 'Kane did fail it');
  assert.equal(r.status, 'unmerged');
  assert.equal(r.bug?.id, 'BUG-001');
  assert.equal(r.regression, false);
  assert.equal(waiting.blocking, false, 'a fix waiting for review blocks nothing');
  assert.ok(before.said.includes("  ⏳ Not a regression: BUG-001's fix isn't merged yet (https://github.com/acme/shop/pull/43)"), before.said.join('\n'));
  const untouched = getBug(p.paths, 'BUG-001')!;
  assert.equal(untouched.status, 'fixed');
  assert.equal(untouched.regressedAt, undefined);
  assert.deepEqual(untouched.runs, []);
  assert.deepEqual(listBugs(p.paths).map((b) => b.id), ['BUG-001'], 'and no new bug is opened for it');
  assert.equal(
    guardBrief(p, waiting),
    `Gremlin Guard: 0 of 1 relevant flows passed in a real browser (verified by Kane CLI).\nNot blocking: "A lowercase coupon code is accepted" failed only because BUG-001's fix isn't merged yet (https://github.com/acme/shop/pull/43). It is not a regression.`,
  );
  assert.match(guardMarkdown(p, waiting), /## 👹 Gremlin Guard: passed[\s\S]*\| ⏳ \| A lowercase coupon code is accepted \| regression \| failed at .*\*\*\(not a regression: BUG-001's fix isn't merged yet \(https:\/\/github\.com\/acme\/shop\/pull\/43\)\)\*\*/);

  // The PR merges. Pulling it means moving the records aside first (git won't write over untracked files), and
  // this checkout keeps its own copy, the one that names the PR. Its commit is in main's history now.
  const local = readFileSync(join(p.paths.bugs, 'BUG-001.json'), 'utf8');
  git(p.root, 'clean', '-fdq', '--', '.gremlin');
  git(p.root, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #43', 'gremlin/bug-001');
  writeFileSync(join(p.paths.bugs, 'BUG-001.json'), local);
  assert.equal(getBug(p.paths, 'BUG-001')!.pr?.url, url);

  assert.deepEqual(relatedFlows(p, next).map((f) => f.id), [flow.id], 'merged, it guards every later fix again');

  // from here on a failure is what it always was: the bug is back
  const after = await runGuard(p, { flowIds: [flow.id] });
  assert.equal(after.results[0].status, 'failed');
  assert.equal(after.results[0].regression, true);
  assert.equal(after.blocking, true);
  const back = getBug(p.paths, 'BUG-001')!;
  assert.equal(back.status, 'confirmed');
  assert.ok(back.regressedAt);
  assert.deepEqual(back.runs, [after.results[0].run!.id]);
  assert.match(guardBrief(p, after), /\*\*Regression:\*\* this flow guards BUG-001, which was fixed before and is back\./);
  assert.doesNotMatch(guardBrief(p, after), /isn't merged/);
});

test('a flow that breaks a different product rule than its open bug opens a new bug', async () => {
  const { saveFlow } = await import('../src/core/flow.ts');
  const { getBug, listBugs } = await import('../src/core/store.ts');
  const { runGuard } = await import('../src/core/guard.ts');
  const prices = 'Every price shows a dollar sign and two decimals, like $12.00';
  const html = 'Nothing the shopper typed is shown as HTML formatting';
  const p = shop([prices, html]);
  const flow = saveFlow(p.paths, {
    title: 'Search for a mug',
    type: 'happy',
    start: '/',
    source: 'human',
    status: 'active',
    tags: ['search'],
    steps: ['Type "mug" into the search box and press Enter'],
    expect: ['Ember Mug is in the results'],
  });

  process.env.FAKE_KANE_FAIL = 'Product rule 1:';
  const first = await runGuard(p, { flowIds: [flow.id] });
  assert.equal(first.results[0].bug?.id, 'BUG-001');
  assert.equal(getBug(p.paths, 'BUG-001')!.contract, prices);

  // the same rule breaking again is more evidence for the same bug
  const again = await runGuard(p, { flowIds: [flow.id] });
  assert.equal(again.results[0].bug?.id, 'BUG-001');
  assert.equal(getBug(p.paths, 'BUG-001')!.runs.length, 2);

  // another rule on the same flow is another bug, and the first one keeps its own evidence
  process.env.FAKE_KANE_FAIL = 'Product rule 2:';
  const other = await runGuard(p, { flowIds: [flow.id] });
  assert.equal(other.results[0].status, 'failed');
  assert.equal(other.blocking, true);
  assert.deepEqual(listBugs(p.paths).map((b) => b.id), ['BUG-001', 'BUG-002']);
  const b2 = getBug(p.paths, 'BUG-002')!;
  assert.equal(other.results[0].bug?.id, 'BUG-002');
  assert.equal(b2.contract, html);
  assert.equal(b2.origin, 'guard');
  assert.equal(b2.flowId, flow.id);
  assert.equal(b2.failingStep, `Product rule 2: ${html}`);
  assert.deepEqual(b2.runs, [other.results[0].run!.id]);
  const b1 = getBug(p.paths, 'BUG-001')!;
  assert.equal(b1.contract, prices);
  assert.deepEqual(b1.runs, [first.results[0].run!.id, again.results[0].run!.id]);

  // and that second rule breaking again goes to its own bug, not a third one
  const twice = await runGuard(p, { flowIds: [flow.id] });
  assert.equal(twice.results[0].bug?.id, 'BUG-002');
  assert.deepEqual(listBugs(p.paths).map((b) => b.id), ['BUG-001', 'BUG-002']);
  assert.equal(getBug(p.paths, 'BUG-002')!.runs.length, 2);
  assert.deepEqual(getBug(p.paths, 'BUG-001')!.runs, b1.runs);
});

test('after the pull request merges, gremlin pull brings it in where git pull refuses', async () => {
  const { saveFlow } = await import('../src/core/flow.ts');
  const { getBug, lockFlow, saveBug } = await import('../src/core/store.ts');
  const { openBugPr, pullMergedFixes } = await import('../src/core/issues.ts');
  const p = shop();
  const flow = saveFlow(p.paths, {
    title: 'A lowercase coupon code is accepted',
    type: 'regression',
    start: '/',
    source: 'capture:paste',
    status: 'active',
    tags: ['checkout'],
    bug: 'BUG-001',
    steps: ['Type welcome10 into the "Coupon code" field and click "Apply"'],
    expect: ['A message says the 10% welcome discount was applied'],
  });
  lockFlow(p.paths, flow, 'fixer');
  saveBug(p.paths, {
    id: 'BUG-001',
    title: 'Lowercase coupon codes are rejected',
    origin: 'capture',
    status: 'fixed',
    severity: 'high',
    confidence: 0.9,
    flowId: flow.id,
    tags: ['checkout'],
    runs: [],
    attempts: [{ n: 1, at: '', agent: 'claude-code', promptFile: '', changedFiles: ['server.js'], outsideArea: [], blocked: [], result: 'passed' }],
    createdAt: '',
    updatedAt: '',
    fixedAt: '2026-11-20T10:00:00.000Z',
    credits: 0,
  });
  writeFileSync(join(p.root, 'server.js'), 'const coupon = coupons[String(code).toUpperCase()];\n');
  git(p.root, 'branch', '-q', '-u', 'origin/main');
  openBugPr(p, 'BUG-001');
  writeFileSync(join(p.paths.bugs, 'BUG-002.json'), '{"id":"BUG-002"}\n'); // found since, and no merge knows about it

  // a reviewer merges the pull request
  const reviewer = mkdtempSync(join(tmpdir(), 'gremlin-guard-reviewer-'));
  git(reviewer, 'clone', '-q', git(p.root, 'remote', 'get-url', 'origin'), '.');
  git(reviewer, 'config', 'user.email', 'reviewer@example.com');
  git(reviewer, 'config', 'user.name', 'Reviewer');
  git(reviewer, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #43', 'origin/gremlin/bug-001');
  git(reviewer, 'push', '-q', 'origin', 'main');
  const plain = spawnSync('git', ['pull', '-q', '--no-edit'], { cwd: p.root, encoding: 'utf8' });
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /untracked working tree files would be overwritten by merge/, 'a plain git pull refuses');

  // a pull that fails for a reason of the app's own puts every record back
  writeFileSync(join(p.root, 'server.js'), 'const coupon = coupons[code.trim()];\n');
  assert.throws(() => pullMergedFixes(p), /git pull failed, so Gremlin's records are back as they were/);
  assert.equal(getBug(p.paths, 'BUG-001')!.pr?.url, 'https://github.com/acme/shop/pull/43');
  git(p.root, 'checkout', '--', 'server.js');

  const pulled = pullMergedFixes(p);
  assert.equal(pulled.upstream, 'origin/main');
  assert.ok(pulled.dropped.includes('.gremlin/bugs/BUG-001.json'), pulled.dropped.join(', '));
  assert.deepEqual(pulled.kept, ['.gremlin/bugs/BUG-002.json']);
  assert.equal(git(p.root, 'rev-parse', 'HEAD'), git(p.root, 'rev-parse', 'origin/main'));
  assert.match(readFileSync(join(p.root, 'server.js'), 'utf8'), /toUpperCase/, 'the fix is in');
  const merged = getBug(p.paths, 'BUG-001')!;
  assert.equal(merged.status, 'fixed');
  assert.equal(merged.pr, undefined, 'merged, so there is no pull request to wait for');
  assert.equal(git(p.root, 'status', '--porcelain', '--', '.gremlin'), '?? .gremlin/bugs/BUG-002.json');
});

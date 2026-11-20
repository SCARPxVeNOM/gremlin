import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ConfigSchema, type Project } from '../src/core/config.ts';
import { saveFlow, type Flow } from '../src/core/flow.ts';
import { protectedMatcher } from '../src/core/guardrails.ts';
import { projectPaths } from '../src/core/paths.ts';
import { changedSince, restoreGuarded, takeSnapshot } from '../src/core/snapshot.ts';
import { lockFlow, lockPath, lockStatus, readLock, tamperedFlows, unlockFlow, type BugRecord } from '../src/core/store.ts';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

function shop(): Project {
  const root = mkdtempSync(join(tmpdir(), 'gremlin-lock-'));
  writeFileSync(join(root, 'gremlin.config.yaml'), 'app:\n  name: Shop\n  url: http://localhost:4000\n');
  const config = ConfigSchema.parse({ app: { name: 'Shop', url: 'http://localhost:4000' } });
  return { root, paths: projectPaths(root), config, raw: {} } as Project;
}

function flow(p: Project, title: string, type: Flow['type'] = 'regression'): Flow {
  return saveFlow(p.paths, { title, type, start: '/', source: 'human', status: 'active', tags: ['checkout'], steps: ['Open the cart'], expect: [`${title} holds`] });
}

/** A flow with what it checks weakened, the way an agent would make it pass. */
function weakened(f: Flow): Flow {
  return { ...f, expect: ['The page loads'], hash: 'weakened00000000' };
}

test('each flow is locked in a file of its own, and an edit is still caught', () => {
  const p = shop();
  const a = flow(p, 'Coupon codes ignore case');
  const b = flow(p, 'Cart totals add up', 'happy');
  lockFlow(p.paths, a, 'fixer');
  lockFlow(p.paths, b, 'human');

  assert.equal(relative(p.root, lockPath(p.paths, a.id)), '.gremlin/locks/regression/coupon-codes-ignore-case.json');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(lockPath(p.paths, a.id), 'utf8'))), ['hash', 'status', 'tags', 'approvedAt', 'by']);
  assert.deepEqual(Object.keys(readLock(p.paths).flows).sort(), [a.id, b.id].sort());
  assert.equal(readLock(p.paths).flows[a.id].hash, a.hash);
  assert.ok(!existsSync(p.paths.legacyLock), 'no shared lock.json is written');

  assert.deepEqual(tamperedFlows(p.paths, [a, b]), []);
  assert.deepEqual(tamperedFlows(p.paths, [weakened(a), b]).map((f) => f.id), [a.id]);

  // a human re-approves the edit, or retires the flow: either way it's no longer tampered
  lockFlow(p.paths, weakened(a), 'human');
  assert.deepEqual(tamperedFlows(p.paths, [weakened(a), b]), []);
  unlockFlow(p.paths, b.id);
  assert.ok(!existsSync(lockPath(p.paths, b.id)));
  assert.deepEqual(Object.keys(readLock(p.paths).flows), [a.id]);
  assert.deepEqual(tamperedFlows(p.paths, [weakened(b)]), [], 'an unlocked flow is not checked');
});

test('a locked flow taken out of Guard is caught too: no longer active, or missing a tag Guard picks it by', () => {
  const p = shop();
  const a = flow(p, 'Coupon codes ignore case');
  lockFlow(p.paths, a, 'fixer');
  assert.deepEqual(tamperedFlows(p.paths, [{ ...a, status: 'quarantined' }]).map((f) => f.id), [a.id], 'switched off');
  assert.deepEqual(tamperedFlows(p.paths, [{ ...a, tags: [] }]).map((f) => f.id), [a.id], 'its area tag dropped');
  assert.deepEqual(tamperedFlows(p.paths, [{ ...a, tags: ['checkout', 'coupon'] }]), [], 'a tag added only widens what it guards');

  // Gremlin quarantining a flaky flow says so in the lock, so that isn't tampering, and it keeps the approved hash
  lockStatus(p.paths, { ...a, status: 'quarantined' }, 'quarantine: 3 flakes in 10 runs');
  assert.deepEqual(tamperedFlows(p.paths, [{ ...a, status: 'quarantined' }]), []);
  assert.deepEqual(tamperedFlows(p.paths, [{ ...weakened(a), status: 'quarantined' }]).map((f) => f.id), [a.id], 'so it lets no edit through');

  // a lock written before status and tags were kept checks the hash only
  writeFileSync(lockPath(p.paths, a.id), JSON.stringify({ hash: a.hash, approvedAt: '', by: 'fixer' }));
  assert.deepEqual(tamperedFlows(p.paths, [{ ...a, status: 'quarantined', tags: [] }]), []);
  assert.deepEqual(tamperedFlows(p.paths, [weakened(a)]).map((f) => f.id), [a.id]);
});

test('an attack moved into regression/ when its fix is accepted leaves no lock behind under its old name', async () => {
  const { acceptFix } = await import('../src/core/fixer.ts');
  const p = shop();
  const attack = saveFlow(p.paths, { title: 'Cart rejects a negative quantity', type: 'adversarial', start: '/', source: 'breaker', status: 'confirmed', tags: ['cart'], steps: ['Open the cart'], expect: ['No line has a negative quantity'] });
  lockFlow(p.paths, attack, 'breaker');
  const bug = { id: 'BUG-002', title: attack.title, origin: 'breaker', status: 'fixing', flowId: attack.id, tags: ['cart'], runs: ['RUN-A'], attempts: [], credits: 0 } as unknown as BugRecord;

  const kept = acceptFix(p, bug, attack, [], 'fixer');
  assert.equal(kept.id, 'regression/cart-rejects-a-negative-quantity');
  assert.deepEqual(Object.keys(readLock(p.paths).flows), [kept.id]);
  assert.equal(readLock(p.paths).flows[kept.id].status, 'active');
  assert.ok(!existsSync(lockPath(p.paths, attack.id)));
});

test("an older project's lock.json still guards its flows, and moves to per-flow files on the next lock change", () => {
  const p = shop();
  const a = flow(p, 'Coupon codes ignore case');
  const b = flow(p, 'Cart totals add up', 'happy');
  const c = flow(p, 'Search finds a mug', 'happy');
  const legacy = {
    flows: {
      [a.id]: { hash: a.hash, approvedAt: '2026-11-18T10:32:04.711Z', by: 'fixer' },
      [b.id]: { hash: b.hash, approvedAt: '2026-11-18T10:34:32.374Z', by: 'first pass' },
    },
  };
  mkdirSync(p.paths.dir, { recursive: true });
  writeFileSync(p.paths.legacyLock, JSON.stringify(legacy, null, 2) + '\n');

  // read as it is, before anything is written
  assert.deepEqual(readLock(p.paths), legacy);
  assert.deepEqual(tamperedFlows(p.paths, [weakened(a), b, c]).map((f) => f.id), [a.id]);
  // an empty locks/ folder (made by hand, or by an agent) doesn't hide it
  mkdirSync(join(p.paths.locks, 'happy'), { recursive: true });
  assert.deepEqual(tamperedFlows(p.paths, [weakened(a), b, c]).map((f) => f.id), [a.id]);

  lockFlow(p.paths, c, 'human');
  assert.ok(!existsSync(p.paths.legacyLock), 'the old file is removed once migrated');
  assert.deepEqual(JSON.parse(readFileSync(lockPath(p.paths, a.id), 'utf8')), legacy.flows[a.id], 'entries are copied as they were');
  assert.deepEqual(JSON.parse(readFileSync(lockPath(p.paths, b.id), 'utf8')), legacy.flows[b.id]);
  assert.deepEqual(Object.keys(readLock(p.paths).flows).sort(), [a.id, b.id, c.id].sort());
  assert.deepEqual(tamperedFlows(p.paths, [weakened(a), b, c]).map((f) => f.id), [a.id]);
  assert.ok(!existsSync(`${p.paths.locks}.${process.pid}.tmp`));

  // unlocking migrates too
  const q = shop();
  const d = flow(q, 'Checkout needs an email');
  const e = flow(q, 'Checkout needs an address');
  mkdirSync(q.paths.dir, { recursive: true });
  writeFileSync(q.paths.legacyLock, JSON.stringify({ flows: { [d.id]: { hash: d.hash, approvedAt: 'x', by: 'y' }, [e.id]: { hash: e.hash, approvedAt: 'x', by: 'y' } } }));
  unlockFlow(q.paths, d.id);
  assert.ok(!existsSync(q.paths.legacyLock));
  assert.deepEqual(Object.keys(readLock(q.paths).flows), [e.id]);
});

test('a lock.json left behind after migrating does not bring back a removed lock', () => {
  const p = shop();
  const a = flow(p, 'Coupon codes ignore case');
  const b = flow(p, 'Cart totals add up');
  const old = JSON.stringify({ flows: { [a.id]: { hash: a.hash, approvedAt: 'x', by: 'y' }, [b.id]: { hash: b.hash, approvedAt: 'x', by: 'y' } } });
  mkdirSync(p.paths.dir, { recursive: true });
  writeFileSync(p.paths.legacyLock, old);
  unlockFlow(p.paths, b.id); // migrates, then b is retired

  // checking out a branch that still has lock.json puts it back next to locks/
  writeFileSync(p.paths.legacyLock, old);
  assert.deepEqual(Object.keys(readLock(p.paths).flows), [a.id]);
  assert.deepEqual(tamperedFlows(p.paths, [weakened(b)]), [], "b's old lock stays removed");
  lockFlow(p.paths, a, 'human');
  assert.ok(!existsSync(p.paths.legacyLock), 'and the next lock change clears it away');
  assert.deepEqual(Object.keys(readLock(p.paths).flows), [a.id]);
});

test('two pull requests that lock different flows touch different files and merge cleanly', () => {
  for (const startsLegacy of [false, true]) {
    const p = shop();
    git(p.root, 'init', '-q', '-b', 'main');
    git(p.root, 'config', 'user.email', 'dev@example.com');
    git(p.root, 'config', 'user.name', 'Dev');
    const old = flow(p, 'Search finds a mug', 'happy');
    const a = flow(p, 'Coupon codes ignore case');
    const b = flow(p, 'Negative quantities are refused');
    if (startsLegacy) {
      mkdirSync(p.paths.dir, { recursive: true });
      writeFileSync(p.paths.legacyLock, JSON.stringify({ flows: { [old.id]: { hash: old.hash, approvedAt: '2026-11-18T10:32:04.711Z', by: 'first pass' } } }, null, 2) + '\n');
    } else {
      lockFlow(p.paths, old, 'first pass');
    }
    git(p.root, 'add', '-A');
    git(p.root, 'commit', '-q', '-m', 'shop');

    // each fix branch starts from the same commit and locks its own regression flow
    for (const [branch, f] of [['gremlin/bug-001', a], ['gremlin/bug-002', b]] as const) {
      git(p.root, 'checkout', '-q', '-b', branch, 'main');
      lockFlow(p.paths, f, 'fixer');
      git(p.root, 'add', '-A');
      git(p.root, 'commit', '-q', '-m', `Fix ${branch}`);
    }
    const touched = (branch: string) => git(p.root, 'diff', '--name-only', 'main', branch).split('\n');
    const shared = touched('gremlin/bug-001').filter((f) => touched('gremlin/bug-002').includes(f));
    if (startsLegacy) {
      // both migrate the same lock.json, and so make the very same change to it and its entries
      assert.deepEqual(shared.sort(), ['.gremlin/lock.json', '.gremlin/locks/happy/search-finds-a-mug.json']);
      for (const f of shared) assert.equal(git(p.root, 'diff', 'gremlin/bug-001', 'gremlin/bug-002', '--', f), '', f);
    } else {
      assert.deepEqual(shared, [], 'no file is changed by both');
    }

    git(p.root, 'checkout', '-q', 'main');
    git(p.root, 'merge', '-q', '--no-edit', 'gremlin/bug-001');
    git(p.root, 'merge', '-q', '--no-edit', 'gremlin/bug-002'); // throws on a conflict
    assert.deepEqual(Object.keys(readLock(p.paths).flows).sort(), [old.id, a.id, b.id].sort());
    assert.ok(!existsSync(p.paths.legacyLock));
  }
});

test('the per-flow locks are protected like the flows: path rules, snapshots and the Claude Code hook', () => {
  const p = shop();
  const a = flow(p, 'Coupon codes ignore case');
  lockFlow(p.paths, a, 'fixer');
  const isGuarded = protectedMatcher(p);
  for (const f of ['.gremlin/locks/regression/coupon-codes-ignore-case.json', '.gremlin/locks/happy/new.json', '.gremlin/lock.json']) assert.ok(isGuarded(f), f);

  // the Fixer's snapshot sees an agent deleting or forging a lock, and puts it back
  const file = relative(p.root, lockPath(p.paths, a.id));
  const original = readFileSync(lockPath(p.paths, a.id), 'utf8');
  const snap = takeSnapshot(p.root, isGuarded);
  rmSync(p.paths.locks, { recursive: true });
  mkdirSync(join(p.paths.locks, 'happy'), { recursive: true });
  writeFileSync(join(p.paths.locks, 'happy', 'forged.json'), '{"hash":"x"}');
  const changed = changedSince(snap);
  assert.deepEqual(changed.filter(isGuarded).sort(), ['.gremlin/locks/happy/forged.json', file].sort());
  restoreGuarded(snap, changed.filter(isGuarded));
  assert.equal(readFileSync(lockPath(p.paths, a.id), 'utf8'), original);
  assert.ok(!existsSync(join(p.paths.locks, 'happy', 'forged.json')));

  // the PreToolUse hook denies edits to a lock file and shell commands that would change locks/
  const hook = new URL('../src/hooks/claude.ts', import.meta.url).href;
  const decide = (input: object) => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `await (await import(${JSON.stringify(hook)})).runClaudeHook('pre-tool-use')`], {
      input: JSON.stringify({ cwd: p.root, ...input }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : 'allow';
  };
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: lockPath(p.paths, a.id) } }), 'deny');
  assert.equal(decide({ tool_name: 'Edit', tool_input: { file_path: '.gremlin/locks/happy/other.json' } }), 'deny');
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'rm -rf .gremlin/locks' } }), 'deny');
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'echo {} > .gremlin/lock.json' } }), 'deny');
  assert.equal(decide({ tool_name: 'Edit', tool_input: { file_path: 'server.js' } }), 'allow');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foreignListener, isReachable } from '../src/core/target.ts';

async function serveFrom(cwd: string, port: number) {
  const child = spawn(process.execPath, ['-e', `require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')`], { cwd, stdio: 'ignore' });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 50 && !(await isReachable(`http://127.0.0.1:${port}`, 300)); i++) await new Promise((r) => setTimeout(r, 100));
  return { url, stop: () => child.kill() };
}

test('an app on the port that was started from another project is recognised as foreign', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'gremlin-mine-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'gremlin-theirs-'));
  mkdirSync(join(project, 'web'));
  const port = 45000 + Math.floor(Math.random() * 2000);

  const theirs = await serveFrom(elsewhere, port);
  t.after(theirs.stop);
  const found = foreignListener(project, theirs.url);
  if (found === undefined) return t.skip('lsof is not available here');
  assert.match(found, /gremlin-theirs-/);
  theirs.stop();

  // the project's own server, even one run from a subfolder, is not foreign
  for (let i = 0; i < 50 && (await isReachable(`http://127.0.0.1:${port}`, 300)); i++) await new Promise((r) => setTimeout(r, 100));
  const mine = await serveFrom(join(project, 'web'), port);
  t.after(mine.stop);
  assert.equal(foreignListener(project, mine.url), undefined);
  assert.equal(foreignListener(project, 'https://shop.example.com'), undefined, 'only local apps are checked');
});

test('a second Gremlin waits for the Kane run in flight, and a lock left by a dead process is taken over', async () => {
  const { kaneTurn } = await import('../src/core/kane.ts');
  const { writeFileSync, existsSync } = await import('node:fs');
  const lock = join(mkdtempSync(join(tmpdir(), 'gremlin-lock-')), 'kane.lock');
  process.env.GREMLIN_KANE_LOCK = lock;

  // another Gremlin is mid-run, then finishes
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  writeFileSync(lock, String(other.pid));
  setTimeout(() => other.kill(), 500);
  const waitedFor: number[] = [];
  const started = Date.now();
  const release = await kaneTurn((pid) => waitedFor.push(pid));
  assert.deepEqual(waitedFor, [other.pid], 'it says whose run it is waiting for');
  assert.ok(Date.now() - started >= 400, 'it did not start until the other run was over');
  release();
  assert.ok(!existsSync(lock));

  // a crashed Gremlin's lock does not block anyone
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => dead.on('close', r));
  writeFileSync(lock, String(dead.pid));
  const told: number[] = [];
  const again = await kaneTurn((pid) => told.push(pid));
  assert.deepEqual(told, []);
  // and a second run inside the same process isn't blocked by its own lock
  (await kaneTurn(() => assert.fail('waited on itself')))();
  again();
  assert.ok(!existsSync(lock));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, redactText } from '../src/core/redact.ts';
import { compileFlow, lintFlow, parseFlow, semanticHash, serializeFlow } from '../src/core/flow.ts';
import { flowSafetyIssues, targetRisk, assertTargetSafe, GuardrailError } from '../src/core/guardrails.ts';
import { scoreConfidence, scoreSeverity } from '../src/core/severity.ts';
import { ConfigSchema, type Project } from '../src/core/config.ts';
import { projectPaths } from '../src/core/paths.ts';
import { tamperedFlows, lockFlow } from '../src/core/store.ts';
import type { RunRecord } from '../src/core/store.ts';

const FLOW = `---
title: A shopper can buy a mug
type: happy
platforms: [web]
start: /
account: shopper
source: gremlin init
status: active
tags: [checkout]
created: 2026-11-18T10:00:00.000Z
---

1. Sign in
2. Open the Ash Glaze Mug and click "Add to cart"
3. Click "Place order"

## Expect

- An order confirmation page says "Thank you"
- The cart is empty.
`;

function project(raw: Record<string, unknown>): Project {
  const root = mkdtempSync(join(tmpdir(), 'gremlin-test-'));
  const config = ConfigSchema.parse(raw);
  return { root, paths: projectPaths(root), config, raw } as Project;
}

test('redact strips personal details but keeps test data', () => {
  const r = redact('Hi, Priya here: priya@gmail.com, +1 415 555 0134, card 4111 1111 1111 1111. Order 1041 on 2026-11-18.');
  assert.equal(r.found.email, 1);
  assert.equal(r.found.phone, 1);
  assert.equal(r.found.card, 1);
  assert.match(r.text, /Order 1041 on 2026-11-18/);
  assert.doesNotMatch(r.text, /priya@gmail|4111|415 555/);

  assert.equal(redact('pay with 4242 4242 4242 4242').found.card, undefined, 'published test cards stay');
  assert.equal(redactText('write to sam@example.test'), 'write to sam@example.test');
  assert.match(redact('token: ghp_abcdefghijklmnopqrstuvwxyz0123').text, /\[redacted-token\]/);
});

test('flows round-trip through markdown with a stable semantic hash', () => {
  const flow = parseFlow(FLOW, '/x/happy/buy-a-mug.md', 'happy/buy-a-mug');
  assert.equal(flow.title, 'A shopper can buy a mug');
  assert.deepEqual(flow.steps, ['Sign in', 'Open the Ash Glaze Mug and click "Add to cart"', 'Click "Place order"']);
  assert.deepEqual(flow.expect, ['An order confirmation page says "Thank you"', 'The cart is empty.']);
  assert.equal(flow.status, 'active');

  const again = parseFlow(serializeFlow(flow), flow.path, flow.id);
  assert.equal(again.hash, flow.hash);

  // Changing only metadata keeps the hash; changing what the flow checks does not.
  assert.equal(semanticHash({ ...flow }), flow.hash);
  assert.notEqual(semanticHash({ ...flow, expect: ['The cart has one item'] }), flow.hash);
});

test('lint pushes flows toward plain English', () => {
  assert.ok(lintFlow({ title: 't', steps: ['Click #submit-btn'], expect: ['ok'] }).some((i) => i.message.includes('CSS selector')));
  assert.ok(lintFlow({ title: 't', steps: ['Click [data-testid=pay]'], expect: ['ok'] }).some((i) => i.message.includes('test id')));
  assert.ok(lintFlow({ title: 't', steps: ['Click "Pay"'], expect: [] }).some((i) => i.level === 'error'));
  assert.deepEqual(lintFlow({ title: 't', steps: ['Click "Pay"'], expect: ['A receipt appears'] }), []);
});

test('compileFlow writes a Kane test with persona logins as variables, not on disk', () => {
  const p = project({
    app: { name: 'Kiln', url: 'http://localhost:4000', production: false },
    personas: { shopper: { email: 'sam@example.test', password: 's3cret-pass' } },
  });
  mkdirSync(join(p.paths.flows, 'happy'), { recursive: true });
  const path = join(p.paths.flows, 'happy', 'buy-a-mug.md');
  writeFileSync(path, FLOW);
  const flow = parseFlow(FLOW, path, 'happy/buy-a-mug');
  const c = compileFlow(flow, p.config, p.paths);
  const onDisk = readFileSync(c.testMdPath, 'utf8');

  assert.match(onDisk, /^---\nmode: testing\nurl: http:\/\/localhost:4000\//);
  assert.match(onDisk, /## Step 1: Sign in\nStart on http:\/\/localhost:4000\/\. Sign in\. Use the login \{\{shopper_login\}\} and the password \{\{shopper_password\}\}\./);
  assert.match(onDisk, /## Check the expected outcome\nVerify that an order confirmation page says "Thank you"\.\nVerify that the cart is empty\./);
  assert.doesNotMatch(onDisk, /s3cret-pass|sam@example\.test/);
  assert.deepEqual(c.variables.shopper_password, { value: 's3cret-pass', secret: true });
});

test('guardrails refuse production and real-money flows', () => {
  assert.equal(targetRisk('http://localhost:4000'), 'local');
  assert.equal(targetRisk('https://shop-git-fix-coupon.vercel.app'), 'preview');
  assert.equal(targetRisk('https://shop.com'), 'unknown');

  assert.throws(() => assertTargetSafe(project({ app: { name: 'x', url: 'https://shop.com' } })), GuardrailError);
  assert.throws(() => assertTargetSafe(project({ app: { name: 'x', url: 'http://localhost:3000', production: true } })), GuardrailError);
  assert.doesNotThrow(() => assertTargetSafe(project({ app: { name: 'x', url: 'https://qa.shop.com' } })));
  assert.doesNotThrow(() => assertTargetSafe(project({ app: { name: 'x', url: 'https://shop.com', production: false } })));

  assert.deepEqual(flowSafetyIssues({ title: 'Pay', steps: ['Pay with real money'], expect: ['ok'] }), ['uses real money']);
  assert.ok(flowSafetyIssues({ title: 'Pay', steps: ['Pay with card 4111 1111 1111 1111'], expect: ['ok'] }).length);
  assert.deepEqual(flowSafetyIssues({ title: 'Pay', steps: ['Pay with card 4242 4242 4242 4242'], expect: ['ok'] }), []);
});

test('an edited flow is detected against the lock', () => {
  const p = project({ app: { name: 'Kiln', url: 'http://localhost:4000' } });
  const flow = parseFlow(FLOW, '/x/happy/buy-a-mug.md', 'happy/buy-a-mug');
  lockFlow(p.paths, flow, 'test');
  assert.deepEqual(tamperedFlows(p.paths, [flow]), []);
  const weakened = parseFlow(FLOW.replace('- The cart is empty.\n', ''), flow.path, flow.id);
  assert.deepEqual(
    tamperedFlows(p.paths, [weakened]).map((f) => f.id),
    ['happy/buy-a-mug'],
  );
});

function run(partial: Partial<RunRecord>): RunRecord {
  return {
    id: 'RUN-1',
    flowId: 'adversarial/x',
    flowTitle: 'x',
    flowType: 'adversarial',
    flowHash: 'h',
    purpose: 'breaker',
    target: 'http://localhost:4000',
    startedAt: new Date().toISOString(),
    status: 'failed',
    credits: 10,
    ...partial,
  };
}

test('severity and confidence combine Kane triage with what broke', () => {
  const serverError = run({
    evidence: { pack: '', consoleErrors: [], networkFailures: [{ method: 'POST', url: '/api/orders', status: 500 }], steps: [], screenshots: [] },
  });
  assert.equal(scoreSeverity(serverError, { tags: ['checkout'] }), 'critical');
  assert.equal(scoreSeverity(run({}), { attack: 'timing.double-submit' }), 'high');
  assert.equal(scoreSeverity(run({}), { attack: 'accessibility.labels' }), 'medium');

  const reproduced = run({ retry: { status: 'failed', credits: 0, logPath: '' } });
  const flaky = run({ retry: { status: 'passed', credits: 0, logPath: '' } });
  assert.ok(scoreConfidence(reproduced) > scoreConfidence(flaky));
  assert.ok(scoreConfidence({ ...reproduced, evidence: serverError.evidence }) > scoreConfidence(reproduced));
});

test('a second attack on the same defect is folded into the existing bug', async () => {
  const { findDuplicateBug } = await import('../src/core/dedupe.ts');
  const { saveBug, saveRun } = await import('../src/core/store.ts');
  const p = project({ app: { name: 'Kiln', url: 'http://localhost:4000' } });
  const failing = (id: string, category: string, title: string, page: string) =>
    run({
      id,
      kane: { status: 'failed', steps: [], durationS: 1, replayed: 0, authored: 1, errors: [], verdict: { confirmed: true, family: 'application_issue', category, title } } as any,
      evidence: { pack: '', consoleErrors: [], networkFailures: [], steps: [], screenshots: [], failure: { message: '', pageUrl: page } },
    });
  const first = failing('RUN-A', 'validation_defect', 'Cart accepts negative quantities and negative totals', 'http://localhost:4000/checkout');
  saveRun(p.paths, first);
  saveBug(p.paths, {
    id: 'BUG-001', title: 'Cart accepts negative quantities and negative totals', origin: 'breaker', status: 'candidate', severity: 'high',
    confidence: 0.9, flowId: 'adversarial/a', tags: [], runs: ['RUN-A'], attempts: [], createdAt: '', updatedAt: '', credits: 0,
  });

  const again = failing('RUN-B', 'validation_defect', 'Negative cart quantities produce negative totals', 'http://localhost:4000/cart');
  assert.equal(findDuplicateBug(p.paths, again, 'Negative cart quantities produce negative totals')?.id, 'BUG-001');

  const otherKind = failing('RUN-C', 'functional_defect', 'Negative cart quantities produce negative totals', 'http://localhost:4000/cart');
  assert.equal(findDuplicateBug(p.paths, otherKind, 'Negative cart quantities produce negative totals'), undefined);

  const unrelated = failing('RUN-D', 'validation_defect', 'Checkout accepts an email address without a domain', 'http://localhost:4000/checkout');
  assert.equal(findDuplicateBug(p.paths, unrelated, 'Checkout accepts an email address without a domain'), undefined);
});

test('after a change, an app Gremlin started is restarted, and a broken startup reports its stderr', async () => {
  const { ensureApp, isReachable, restartApp } = await import('../src/core/target.ts');
  const port = 41000 + Math.floor(Math.random() * 2000);
  const p = project({ app: { name: 'Tiny', url: `http://127.0.0.1:${port}`, start: 'node server.mjs' } });
  const serve = (body: string) =>
    writeFileSync(join(p.root, 'server.mjs'), `import http from 'node:http';\nhttp.createServer((q, s) => s.end(${JSON.stringify(body)})).listen(${port}, '127.0.0.1');\n`);
  serve('old');
  let app = await ensureApp(p);
  try {
    assert.equal(app.startedByGremlin, true);
    assert.equal(await (await fetch(p.config.app.url)).text(), 'old');

    serve('new');
    app = await restartApp(p, app);
    assert.equal(await (await fetch(p.config.app.url)).text(), 'new', 'Kane must see the changed code');

    writeFileSync(join(p.root, 'server.mjs'), "throw new Error('boom: missing semicolon');\n");
    await assert.rejects(restartApp(p, app), /exited with code 1[\s\S]*boom: missing semicolon/);
    assert.equal(await isReachable(p.config.app.url, 500), false);
  } finally {
    app.stop();
  }
});

test("when Kane's two triages of a failure disagree, the more confident one speaks for the run", async () => {
  const { stronger } = await import('../src/core/runner.ts');
  const attempt = (family?: string, confidence?: number, status: 'failed' | 'error' = 'failed') =>
    ({ status, errors: [], verdict: family ? { confirmed: false, family, confidence } : undefined }) as any;
  const blamesTest = attempt('automation_bug', 0.86);
  const blamesApp = attempt('application_issue', 0.97);
  assert.equal(stronger(blamesTest, blamesApp), blamesApp, 'the retry was surer it is a product bug');
  assert.equal(stronger(blamesApp, blamesTest), blamesApp, 'order does not matter');
  assert.equal(stronger(attempt(), blamesTest), blamesTest, 'a verdict beats none');
  assert.equal(stronger(blamesTest, attempt()), blamesTest);
  assert.equal(stronger(blamesTest, attempt('application_issue', 0.99, 'error')), blamesTest, "a run that couldn't execute has no say");
});

test('steps an agent numbered itself are stored without the extra number', async () => {
  const { saveFlow } = await import('../src/core/flow.ts');
  const p = project({});
  const f = saveFlow(p.paths, { title: 'A coupon applies', type: 'regression', source: 'capture:paste', steps: ['1. Click "Ember Vase"', '2) Click "Add to cart"', '- Go to checkout'], expect: ['- A discount is shown'] });
  assert.deepEqual(f.steps, ['Click "Ember Vase"', 'Click "Add to cart"', 'Go to checkout']);
  assert.deepEqual(f.expect, ['A discount is shown']);
  assert.match(readFileSync(f.path, 'utf8'), /\n1\. Click "Ember Vase"\n2\. Click "Add to cart"/);
});

test('behaviour contracts are checked in their own step at the end of every flow they apply to', async () => {
  const { brokenContract, contractsFor } = await import('../src/core/flow.ts');
  const p = project({
    app: { name: 'Kiln', url: 'http://localhost:4000' },
    contracts: [
      'Every price shows a dollar sign and two decimals, like $12.00',
      { rule: 'Nothing the shopper typed is shown as HTML formatting', tags: ['search'] },
    ],
  });
  mkdirSync(join(p.paths.flows, 'happy'), { recursive: true });
  const path = join(p.paths.flows, 'happy', 'buy-a-mug.md');
  writeFileSync(path, FLOW);
  const flow = parseFlow(FLOW, path, 'happy/buy-a-mug'); // tagged checkout
  const onDisk = readFileSync(compileFlow(flow, p.config, p.paths).testMdPath, 'utf8');

  assert.match(onDisk, /Verify that the cart is empty\.\n\n## Product rule 1: Every price shows a dollar sign and two decimals, like \$12\.00\nWithout leaving this page, verify that every price shows a dollar sign and two decimals, like \$12\.00\. If nothing on this page falls under this rule, it holds\.\n$/);
  assert.doesNotMatch(onDisk, /HTML formatting/, 'a rule tagged search stays out of a checkout flow');
  assert.deepEqual(contractsFor({ tags: ['search'] }, p.config).length, 2);

  // each rule is its own step, so the step that failed says which rule broke, whatever Kane's reason quotes
  const searchFlow = { tags: ['search'] };
  const searchSteps = readFileSync(compileFlow({ ...flow, id: 'happy/search', tags: ['search'] }, p.config, p.paths).testMdPath, 'utf8');
  assert.match(searchSteps, /## Product rule 1: Every price[^\n]*\n[^\n]*\n\n## Product rule 2: Nothing the shopper typed is shown as HTML formatting\n/);
  assert.equal(brokenContract(searchFlow, p.config, { heading: 'Product rule 2: Nothing the shopper typed is shown as HTML formatting', reason: 'Checkpoint assertion failed: "the footer shows $60"' }), 'Nothing the shopper typed is shown as HTML formatting');
  assert.equal(brokenContract(searchFlow, p.config, { heading: 'Product rule 1: Every price shows a dollar sign and two decimals, like $12.00' }), 'Every price shows a dollar sign and two decimals, like $12.00');
  assert.equal(brokenContract(searchFlow, p.config, { heading: 'Check the expected outcome', reason: 'x' }), undefined, "the flow's own expectations are not a contract");
});

test('doctor warns about contracts worded so broadly that Kane would apply them where they make no sense', async () => {
  const { lintContract } = await import('../src/core/flow.ts');
  const messages = (rule: string) => lintContract(rule).map((i) => i.message);

  // the two rules that failed in real runs: a footer's "Free shipping over $60", and a search page with no totals
  assert.deepEqual(messages('Every price on the page is in US dollars with two decimals'), ['"on the page" makes Kane check everything it can see, banners and footers included']);
  assert.match(lintContract('Every price on the page is in US dollars with two decimals')[0].hint, /name the part it covers/);
  assert.deepEqual(messages('The line total, subtotal, discount and order total always add up'), ['lists 4 things, and Kane may expect all of them on every page it checks']);
  assert.deepEqual(messages('Name, email, and phone fields have labels'), ['lists 3 things, and Kane may expect all of them on every page it checks']);
  assert.match(messages('No error shows anywhere')[0], /"anywhere"/);
  assert.deepEqual(messages('The checkout page looks good'), ['"looks good" doesn\'t say what Kane should look for']);
  assert.match(messages('Totals are calculated correctly')[0], /"correctly"/);

  // rules that name what they cover are left alone
  for (const fine of [
    'Every product price and cart line price shows a dollar sign and two decimals, like $12.00',
    'Every price shows a dollar sign and two decimals, like $12.00',
    'Nothing the shopper typed is shown as HTML formatting',
    'No error message appears anywhere in the checkout form',
    'Every price on the page inside the order summary shows two decimals',
    'When a coupon applies, the total drops and a message says so',
    'If the cart is empty, the checkout button is greyed out, and a message explains why',
  ]) assert.deepEqual(lintContract(fine), [], fine);
});

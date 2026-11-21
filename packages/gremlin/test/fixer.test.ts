import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentUnavailable } from '../src/core/fixer.ts';

test('an agent that could not start (a usage limit, a sign-in) is told apart from one that failed at the fix', () => {
  for (const error of [
    "You've hit your session limit · resets 6pm (Asia/Calcutta)",
    'Claude AI usage limit reached|1795400000',
    'Error: 429 Rate limit exceeded',
    'Invalid API key · Please run /login',
    'Your credit balance is too low to access the Anthropic API.',
    'API Error: 529 Overloaded',
  ])
    assert.equal(agentUnavailable(error), true, error);

  for (const error of [
    'The agent exited with code 1: TypeError: Cannot read properties of undefined in server.js',
    'I added a rate limiter to the checkout route, but the test still fails.',
    'Timed out after 600 s',
  ])
    assert.equal(agentUnavailable(error), false, error);
});

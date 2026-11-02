const test = require('node:test');
const assert = require('node:assert/strict');
const { createBreaker, breakerStatus } = require('../breaker');
const { HttpError } = require('../http');

test('breaker serves fallback on failure and opens after the error threshold', async () => {
  let calls = 0;
  const breaker = createBreaker(
    async () => {
      calls += 1;
      throw new Error('connection refused');
    },
    { name: 'test.failing', fallback: () => 'cached', volumeThreshold: 3, resetTimeout: 60_000 },
  );

  for (let i = 0; i < 5; i++) assert.equal(await breaker.fire(), 'cached');

  assert.equal(breaker.opened, true);
  // Once open, calls are short-circuited: the downstream is no longer hit.
  assert.equal(calls, 3);
  assert.equal(breakerStatus().find((b) => b.name === 'test.failing').state, 'OPEN');
  breaker.shutdown();
});

test('4xx responses do not trip the breaker', async () => {
  const breaker = createBreaker(
    async () => {
      throw new HttpError(404, 'not found');
    },
    { name: 'test.client-errors', volumeThreshold: 1 },
  );
  for (let i = 0; i < 5; i++) await assert.rejects(breaker.fire(), { status: 404 });
  assert.equal(breaker.opened, false);
  breaker.shutdown();
});

test('breaker times out slow calls', async () => {
  const breaker = createBreaker(() => new Promise((r) => setTimeout(() => r('late'), 200)), {
    name: 'test.slow',
    timeout: 50,
    fallback: () => 'fallback',
  });
  assert.equal(await breaker.fire(), 'fallback');
  assert.equal(breaker.stats.timeouts, 1);
  breaker.shutdown();
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { rankPosts, scorePost, DEFAULTS } = require('../src/ranking');

const NOW = Date.parse('2026-10-29T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

test('newer post outranks older post with equal engagement', () => {
  const ranked = rankPosts(
    [
      { id: 'old', createdAt: hoursAgo(10), likeCount: 0 },
      { id: 'new', createdAt: hoursAgo(1), likeCount: 0 },
    ],
    { now: NOW },
  );
  assert.deepEqual(ranked.map((p) => p.id), ['new', 'old']);
});

test('score halves every half-life', () => {
  const fresh = scorePost({ createdAt: hoursAgo(0), likeCount: 0 }, NOW, DEFAULTS);
  const aged = scorePost({ createdAt: hoursAgo(DEFAULTS.halfLifeHours), likeCount: 0 }, NOW, DEFAULTS);
  assert.equal(fresh, 1);
  assert.ok(Math.abs(aged - 0.5) < 1e-9);
});

test('engagement can lift a slightly older post above a newer one', () => {
  const ranked = rankPosts(
    [
      { id: 'new-quiet', createdAt: hoursAgo(1), likeCount: 0 },
      { id: 'older-viral', createdAt: hoursAgo(2), likeCount: 5000 },
    ],
    { now: NOW },
  );
  assert.equal(ranked[0].id, 'older-viral');
});

test('future timestamps are clamped (clock skew does not explode scores)', () => {
  const s = scorePost({ createdAt: new Date(NOW + 3_600_000).toISOString(), likeCount: 0 }, NOW, DEFAULTS);
  assert.equal(s, 1);
});

test('ranking does not mutate input and adds score', () => {
  const input = [{ id: 'a', createdAt: hoursAgo(1), likeCount: 3 }];
  const [out] = rankPosts(input, { now: NOW });
  assert.equal(input[0].score, undefined);
  assert.equal(typeof out.score, 'number');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeCursor, decodeCursor } = require('../src/cursor');
const { mergeEntries } = require('../src/content-aggregator');
const { handlePostCreated } = require('../src/fanout-worker');
const { CELEBRITY_THRESHOLD } = require('../src/clients');

test('cursor round-trips and rejects garbage', () => {
  const ts = 1761739200000;
  assert.equal(decodeCursor(encodeCursor(ts)), ts);
  assert.equal(decodeCursor(undefined), null);
  assert.throws(() => decodeCursor('not-a-cursor'), { status: 400 });
});

test('mergeEntries dedupes, sorts newest first and cuts to limit', () => {
  const pushed = [
    { postId: 'a', ts: 300 },
    { postId: 'b', ts: 100 },
  ];
  const pulled = [
    { postId: 'c', ts: 200 },
    { postId: 'a', ts: 300 },
  ];
  assert.deepEqual(mergeEntries([pushed, pulled], 2).map((e) => e.postId), ['a', 'c']);
});

function fakes({ followerCount, followers }) {
  const calls = { feedItems: [], pushed: [], authorPosts: [], cached: [] };
  const pool = {
    query: async (sql, params) => {
      if (sql.includes('feed_items')) calls.feedItems.push(...params[0]);
      if (sql.includes('author_posts')) calls.authorPosts.push(params[1]);
      return { rows: [], rowCount: 0 };
    },
  };
  const cache = {
    cachePosts: async (posts) => calls.cached.push(...posts.map((p) => p.id)),
    pushToWarmTimelines: async (ids) => calls.pushed.push(...ids),
    addAuthorPost: async () => {},
  };
  const clients = {
    async *followerPages() {
      yield { followerCount, items: followers, nextCursor: null };
    },
  };
  const logger = { info() {}, warn() {}, error() {} };
  return { deps: { pool, cache, clients, logger }, calls };
}

const event = {
  eventId: 'e1',
  post: { id: 'p1', authorId: 'author', content: 'hi', createdAt: new Date().toISOString(), likeCount: 0 },
};

test('fan-out pushes to author and every follower', async () => {
  const { deps, calls } = fakes({ followerCount: 2, followers: ['f1', 'f2'] });
  const result = await handlePostCreated(event, deps);
  assert.deepEqual(result, { mode: 'push', delivered: 3 });
  assert.deepEqual(calls.feedItems, ['author', 'f1', 'f2']);
  assert.deepEqual(calls.pushed, ['author', 'f1', 'f2']);
  assert.deepEqual(calls.cached, ['p1']);
});

test('celebrity posts are stored for pull instead of fanned out', async () => {
  const { deps, calls } = fakes({ followerCount: CELEBRITY_THRESHOLD + 1, followers: ['f1'] });
  const result = await handlePostCreated(event, deps);
  assert.equal(result.mode, 'pull');
  assert.deepEqual(calls.feedItems, []);
  assert.deepEqual(calls.authorPosts, ['p1']);
});

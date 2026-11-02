// Calls to other services, each wrapped in its own circuit breaker so a slow or
// failing dependency degrades the feed instead of taking it down.
const { createServiceClient, createBreaker } = require('@socialflow/common');

const CELEBRITY_THRESHOLD = Number(process.env.CELEBRITY_THRESHOLD || 10_000);
const FOLLOWERS_PAGE = 1000;
const FOLLOWING_TTL_S = 300;

function createClients({ discovery, cache, logger }) {
  const request = createServiceClient({ discovery });

  // post-service: batch hydrate. Fallback = last known bodies from Redis.
  const postsBreaker = createBreaker(
    (ids, requestId) => request('post-service', `/posts?ids=${ids.join(',')}`, { requestId }),
    { name: 'post-service.getPosts', logger, fallback: async (ids) => ({ items: await cache.getCachedPosts(ids), degraded: true }) },
  );

  // user-service: whom the reader follows (to pull celebrity posts). Fallback = last cached list.
  const followingBreaker = createBreaker(
    (userId, requestId) => request('user-service', `/users/${userId}/following`, { requestId }),
    {
      name: 'user-service.getFollowing',
      logger,
      fallback: async (userId) => ({ items: (await cache.getJson(`following:${userId}`)) || [], degraded: true }),
    },
  );

  // user-service: followers page for fan-out. No fallback - the Kafka message is
  // retried until user-service recovers, so no fan-out is lost.
  const followersBreaker = createBreaker(
    (userId, after) => request('user-service', `/users/${userId}/followers?limit=${FOLLOWERS_PAGE}${after ? `&after=${after}` : ''}`),
    { name: 'user-service.getFollowers', logger },
  );

  return {
    async getPosts(ids, requestId) {
      if (!ids.length) return { items: [], degraded: false };
      const result = await postsBreaker.fire(ids, requestId);
      // Refresh the fallback copies off the request path.
      if (!result.degraded) cache.cachePosts(result.items).catch(() => {});
      return { items: result.items, degraded: Boolean(result.degraded) };
    },

    // Follow lists change rarely: serve from Redis (5 min TTL), call user-service on a miss.
    async getCelebrityFollowees(userId, requestId) {
      const toIds = (items) => items.filter((u) => u.followerCount > CELEBRITY_THRESHOLD).map((u) => u.id);
      const cached = await cache.getJson(`following:${userId}`).catch(() => null);
      if (cached) return { ids: toIds(cached), degraded: false };

      const result = await followingBreaker.fire(userId, requestId);
      if (!result.degraded) cache.setJson(`following:${userId}`, result.items, FOLLOWING_TTL_S).catch(() => {});
      return { ids: toIds(result.items), degraded: Boolean(result.degraded) };
    },

    async *followerPages(userId) {
      let after = null;
      do {
        const page = await followersBreaker.fire(userId, after);
        yield page;
        after = page.nextCursor;
      } while (after);
    },
  };
}

module.exports = { createClients, CELEBRITY_THRESHOLD };

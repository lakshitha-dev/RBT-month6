// Content Aggregator: combines pushed timeline entries with pulled celebrity posts
// and hydrates post ids into full posts (via post-service, behind a circuit breaker).

// Merge pushed + pulled entries: dedupe by postId, newest first, cut to one page.
function mergeEntries(lists, limit) {
  const byId = new Map();
  for (const entry of lists.flat()) {
    if (!byId.has(entry.postId)) byId.set(entry.postId, entry);
  }
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

function createContentAggregator({ pool, cache, clients }) {
  async function loadCelebrityPosts(authorIds, { before, limit }) {
    if (!authorIds.length) return [];
    try {
      return await cache.readAuthorPosts(authorIds, { before, limit });
    } catch {
      const { rows } = await pool.query(
        `SELECT post_id, created_at FROM author_posts
          WHERE author_id = ANY($1::uuid[]) AND ($2::timestamptz IS NULL OR created_at < $2)
          ORDER BY created_at DESC LIMIT $3`,
        [authorIds, before ? new Date(before) : null, limit],
      );
      return rows.map((r) => ({ postId: r.post_id, ts: r.created_at.getTime() }));
    }
  }

  return {
    async aggregate({ userId, timelineEntries, before, limit, requestId }) {
      const celebs = await clients.getCelebrityFollowees(userId, requestId);
      const pulled = await loadCelebrityPosts(celebs.ids, { before, limit });
      const page = mergeEntries([timelineEntries, pulled], limit);
      const hydrated = await clients.getPosts(page.map((e) => e.postId), requestId);
      return { page, posts: hydrated.items, degraded: hydrated.degraded || celebs.degraded };
    },
  };
}

module.exports = { createContentAggregator, mergeEntries };

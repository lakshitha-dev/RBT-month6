// Feed Generator: builds a page of the home feed.
//   1. Timeline Cache (Redis)  -> miss: rebuild from Postgres feed_items and re-warm
//   2. Content Aggregator      -> merge in pulled celebrity posts, hydrate bodies
//   3. Ranking Engine          -> order the page
const { rankPosts } = require('./ranking');
const { encodeCursor } = require('./cursor');
const { TIMELINE_MAX } = require('./timeline-cache');
const { createContentAggregator } = require('./content-aggregator');

function createFeedGenerator({ pool, cache, clients, logger }) {
  const aggregator = createContentAggregator({ pool, cache, clients });

  async function loadTimeline(userId, { before, limit }) {
    try {
      const cached = await cache.read(userId, { before, limit });
      if (cached) return { entries: cached, source: 'cache' };
    } catch (err) {
      logger.warn({ err: err.message }, 'timeline cache unavailable, using database');
    }

    const { rows } = await pool.query(
      'SELECT post_id, created_at FROM feed_items WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, TIMELINE_MAX],
    );
    const all = rows.map((r) => ({ postId: r.post_id, ts: r.created_at.getTime() }));
    cache.warm(userId, all).catch((err) => logger.warn({ err: err.message }, 'timeline warm failed'));
    const entries = all.filter((e) => !before || e.ts < before).slice(0, limit);
    return { entries, source: 'db' };
  }

  return async function getFeed({ userId, limit, before, requestId }) {
    const started = process.hrtime.bigint();

    const timeline = await loadTimeline(userId, { before, limit });
    const { page, posts, degraded } = await aggregator.aggregate({
      userId,
      timelineEntries: timeline.entries,
      before,
      limit,
      requestId,
    });
    const items = rankPosts(posts);

    return {
      userId,
      source: timeline.source,
      degraded,
      count: items.length,
      items,
      nextCursor: page.length === limit ? encodeCursor(page[page.length - 1].ts) : null,
      tookMs: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)),
    };
  };
}

module.exports = { createFeedGenerator };

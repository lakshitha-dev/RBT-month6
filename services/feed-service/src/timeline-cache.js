// Timeline Cache: one Redis sorted set per user, member = postId, score = createdAt (ms).
//   timeline:{userId}      precomputed home timeline (capped, expires when idle)
//   author_posts:{authorId} recent posts of celebrity authors (pull model)
//   post:{postId}          last known post body, used when post-service is unavailable
const Redis = require('ioredis');

const TIMELINE_MAX = Number(process.env.TIMELINE_MAX || 500);
const TIMELINE_TTL_S = Number(process.env.TIMELINE_TTL_S || 3600);
const AUTHOR_POSTS_MAX = 200;
const POST_BODY_TTL_S = 86_400;

const timelineKey = (userId) => `timeline:${userId}`;
const authorPostsKey = (authorId) => `author_posts:${authorId}`;
const postKey = (postId) => `post:${postId}`;

function createRedis(logger) {
  const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));

  // Only touch timelines that are already warm: cold timelines are rebuilt from
  // Postgres on next read, so we don't spend memory on inactive users.
  redis.defineCommand('pushIfWarm', {
    numberOfKeys: 1,
    lua: `
      if redis.call('EXISTS', KEYS[1]) == 1 then
        redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
        redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -(tonumber(ARGV[3]) + 1))
        redis.call('EXPIRE', KEYS[1], ARGV[4])
        return 1
      end
      return 0`,
  });
  return redis;
}

function toEntries(flat) {
  const entries = [];
  for (let i = 0; i < flat.length; i += 2) entries.push({ postId: flat[i], ts: Number(flat[i + 1]) });
  return entries;
}

class TimelineCache {
  constructor(redis) {
    this.redis = redis;
  }

  // Returns null on a cache miss (timeline not warm).
  async read(userId, { before, limit }) {
    const key = timelineKey(userId);
    const [[, exists], [, flat]] = await this.redis
      .multi()
      .exists(key)
      .zrevrangebyscore(key, before ? `(${before}` : '+inf', '-inf', 'WITHSCORES', 'LIMIT', 0, limit)
      .exec();
    return exists ? toEntries(flat) : null;
  }

  async warm(userId, entries) {
    if (!entries.length) return;
    const key = timelineKey(userId);
    const args = entries.flatMap((e) => [e.ts, e.postId]);
    await this.redis.multi().del(key).zadd(key, ...args).expire(key, TIMELINE_TTL_S).exec();
  }

  async pushToWarmTimelines(userIds, postId, ts) {
    const pipeline = this.redis.pipeline();
    for (const userId of userIds) pipeline.pushIfWarm(timelineKey(userId), ts, postId, TIMELINE_MAX, TIMELINE_TTL_S);
    const results = await pipeline.exec();
    return results.filter(([, updated]) => updated === 1).length;
  }

  async addAuthorPost(authorId, postId, ts) {
    const key = authorPostsKey(authorId);
    await this.redis.multi().zadd(key, ts, postId).zremrangebyrank(key, 0, -(AUTHOR_POSTS_MAX + 1)).exec();
  }

  async readAuthorPosts(authorIds, { before, limit }) {
    if (!authorIds.length) return [];
    const pipeline = this.redis.pipeline();
    for (const id of authorIds) {
      pipeline.zrevrangebyscore(authorPostsKey(id), before ? `(${before}` : '+inf', '-inf', 'WITHSCORES', 'LIMIT', 0, limit);
    }
    const results = await pipeline.exec();
    return results.flatMap(([err, flat]) => (err ? [] : toEntries(flat)));
  }

  async cachePosts(posts) {
    if (!posts.length) return;
    const pipeline = this.redis.pipeline();
    for (const post of posts) pipeline.set(postKey(post.id), JSON.stringify(post), 'EX', POST_BODY_TTL_S);
    await pipeline.exec();
  }

  async getCachedPosts(postIds) {
    if (!postIds.length) return [];
    const values = await this.redis.mget(postIds.map(postKey));
    return values.filter(Boolean).map((v) => JSON.parse(v));
  }

  async getJson(key) {
    const v = await this.redis.get(key);
    return v ? JSON.parse(v) : null;
  }

  async setJson(key, value, ttlSeconds) {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }
}

module.exports = { TimelineCache, createRedis, TIMELINE_MAX };

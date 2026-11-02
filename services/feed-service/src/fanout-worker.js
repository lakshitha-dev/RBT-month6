// Fan-out Worker: consumes post.created and pushes the post into followers' timelines.
// Hybrid model - authors above CELEBRITY_THRESHOLD are not fanned out (that would be
// millions of writes per post); their posts are pulled at read time instead.
// Idempotent: feed_items has a (user_id, post_id) PK and ZADD is an upsert, so
// at-least-once redelivery from Kafka is safe.
const { Kafka, logLevel } = require('kafkajs');
const { CELEBRITY_THRESHOLD } = require('./clients');

const TOPIC = 'post.created';

async function handlePostCreated(event, { pool, cache, clients, logger }) {
  const { post } = event;
  const ts = new Date(post.createdAt).getTime();
  await cache.cachePosts([post]);

  let followerCount = 0;
  let delivered = 0;
  for await (const page of clients.followerPages(post.authorId)) {
    followerCount = page.followerCount;
    if (followerCount > CELEBRITY_THRESHOLD) break;
    // Author sees their own post too (first page only).
    const recipients = delivered === 0 ? [post.authorId, ...page.items] : page.items;
    await pool.query(
      `INSERT INTO feed_items (user_id, post_id, author_id, created_at)
       SELECT unnest($1::uuid[]), $2, $3, $4 ON CONFLICT DO NOTHING`,
      [recipients, post.id, post.authorId, post.createdAt],
    );
    await cache.pushToWarmTimelines(recipients, post.id, ts);
    delivered += recipients.length;
  }

  if (followerCount > CELEBRITY_THRESHOLD) {
    await pool.query(
      'INSERT INTO author_posts (author_id, post_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [post.authorId, post.id, post.createdAt],
    );
    await cache.addAuthorPost(post.authorId, post.id, ts);
    logger.info({ postId: post.id, followerCount }, 'celebrity post stored for pull-on-read');
    return { mode: 'pull', delivered: 0 };
  }

  logger.info({ postId: post.id, delivered, lagMs: Date.now() - ts }, 'post fanned out');
  return { mode: 'push', delivered };
}

function createFanoutWorker(deps) {
  const kafka = new Kafka({
    clientId: 'feed-service',
    brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
    logLevel: logLevel.WARN,
  });
  const consumer = kafka.consumer({
    groupId: 'feed-fanout',
    retry: { retries: 8, initialRetryTime: 1000, maxRetryTime: 30000 },
  });

  return {
    async start() {
      const admin = kafka.admin();
      await admin.connect();
      await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 6, replicationFactor: 1 }] });
      await admin.disconnect();

      await consumer.connect();
      await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
      await consumer.run({
        eachMessage: async ({ message, partition }) => {
          const event = JSON.parse(message.value.toString());
          try {
            await handlePostCreated(event, deps);
          } catch (err) {
            // Throwing leaves the offset uncommitted; kafkajs retries with backoff.
            deps.logger.error({ err: err.message, eventId: event.eventId, partition }, 'fan-out failed, will retry');
            throw err;
          }
        },
      });
      deps.logger.info({ topic: TOPIC }, 'fan-out worker consuming');
    },
    stop: () => consumer.disconnect(),
  };
}

module.exports = { createFanoutWorker, handlePostCreated };

const {
  createLogger,
  Discovery,
  createApp,
  finalize,
  start,
  HttpProblem,
  requireUserId,
  breakerStatus,
} = require('@socialflow/common');
const { pool, migrate } = require('./db');
const { TimelineCache, createRedis } = require('./timeline-cache');
const { createClients } = require('./clients');
const { createFeedGenerator } = require('./feed-generator');
const { createFanoutWorker } = require('./fanout-worker');
const { decodeCursor } = require('./cursor');

const SERVICE = 'feed-service';
const PORT = Number(process.env.PORT || 3003);
const logger = createLogger(SERVICE);
const discovery = new Discovery({ logger });
const redis = createRedis(logger);
const cache = new TimelineCache(redis);
const clients = createClients({ discovery, cache, logger });
const getFeed = createFeedGenerator({ pool, cache, clients, logger });
const fanout = createFanoutWorker({ pool, cache, clients, logger });
const app = createApp({ logger });

// Personalized home feed: cache first, database fallback, cursor-paginated.
app.get('/feed', async (req, res) => {
  const userId = requireUserId(req);
  const limit = Number(req.query.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpProblem(400, 'limit must be 1-50');
  const before = decodeCursor(req.query.cursor);

  const feed = await getFeed({ userId, limit, before, requestId: req.id });
  res.set('x-feed-source', feed.source).json(feed);
});

// Circuit breaker state, for the demo and dashboards.
app.get('/feed/breakers', (req, res) => res.json({ breakers: breakerStatus() }));

finalize(app, {
  logger,
  health: async () => {
    await pool.query('SELECT 1');
    // Redis being down degrades the feed (DB fallback) but doesn't make us unhealthy.
    const redisState = await redis.ping().then(() => 'up', () => 'down');
    return { db: 'up', redis: redisState };
  },
});

(async () => {
  await migrate();
  await redis.connect();
  await fanout.start();
  await start(app, {
    name: SERVICE,
    port: PORT,
    logger,
    discovery,
    onShutdown: [() => fanout.stop(), () => redis.quit(), () => pool.end()],
  });
})().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

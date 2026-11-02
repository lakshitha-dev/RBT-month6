const crypto = require('node:crypto');
const {
  createLogger,
  Discovery,
  createApp,
  finalize,
  start,
  HttpProblem,
  isUuid,
  requireUserId,
} = require('@socialflow/common');
const { pool, migrate } = require('./db');
const events = require('./events');

const SERVICE = 'post-service';
const PORT = Number(process.env.PORT || 3002);
const MAX_BATCH = 100;
const logger = createLogger(SERVICE);
const discovery = new Discovery({ logger });
const app = createApp({ logger });

const toPost = (row) => ({
  id: row.id,
  authorId: row.author_id,
  content: row.content,
  mediaUrls: row.media_urls,
  likeCount: row.like_count,
  createdAt: row.created_at,
});

// Create post: persist + enqueue post.created atomically, then publish for feed fan-out.
app.post('/posts', async (req, res) => {
  const authorId = requireUserId(req);
  const { content, mediaUrls = [] } = req.body || {};
  if (typeof content !== 'string' || !content.trim() || content.length > 2000) {
    throw new HttpProblem(400, 'content is required (max 2000 chars)');
  }
  if (!Array.isArray(mediaUrls) || mediaUrls.length > 4 || !mediaUrls.every((u) => /^https:\/\//.test(u))) {
    throw new HttpProblem(400, 'mediaUrls must be up to 4 https URLs');
  }

  const client = await pool.connect();
  let post;
  let outboxRow;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO posts (author_id, content, media_urls) VALUES ($1, $2, $3) RETURNING *',
      [authorId, content.trim(), mediaUrls],
    );
    post = toPost(rows[0]);
    const event = {
      eventId: crypto.randomUUID(),
      type: events.TOPIC_POST_CREATED,
      occurredAt: new Date().toISOString(),
      post,
    };
    ({ rows: [outboxRow] } = await client.query(
      'INSERT INTO outbox (topic, message_key, payload) VALUES ($1, $2, $3) RETURNING *',
      [events.TOPIC_POST_CREATED, authorId, event],
    ));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const published = await events.publishNow(outboxRow, req.log);
  res.status(201).location(`/posts/${post.id}`).json({ ...post, eventPublished: published });
});

// Batch hydrate: GET /posts?ids=a,b,c (used by feed-service)
app.get('/posts', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  if (!ids.length) throw new HttpProblem(400, 'ids query parameter is required');
  if (ids.length > MAX_BATCH) throw new HttpProblem(400, `at most ${MAX_BATCH} ids`);
  if (!ids.every(isUuid)) throw new HttpProblem(400, 'ids must be uuids');
  const { rows } = await pool.query('SELECT * FROM posts WHERE id = ANY($1::uuid[])', [ids]);
  res.json({ items: rows.map(toPost) });
});

// Get single post
app.get('/posts/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpProblem(400, 'id must be a uuid');
  const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw new HttpProblem(404, 'post not found');
  res.json(toPost(rows[0]));
});

// Like a post (idempotent per user)
app.post('/posts/:id/like', async (req, res) => {
  const userId = requireUserId(req);
  if (!isUuid(req.params.id)) throw new HttpProblem(400, 'id must be a uuid');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount: found } = await client.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!found) throw new HttpProblem(404, 'post not found');
    const { rowCount } = await client.query(
      'INSERT INTO likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, userId],
    );
    const { rows } = await client.query(
      'UPDATE posts SET like_count = like_count + $2 WHERE id = $1 RETURNING like_count',
      [req.params.id, rowCount],
    );
    await client.query('COMMIT');
    res.json({ postId: req.params.id, liked: true, likeCount: rows[0].like_count });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

finalize(app, {
  logger,
  health: async () => {
    await pool.query('SELECT 1');
    return { db: 'up' };
  },
});

(async () => {
  await migrate();
  await events.connect(logger);
  events.startRelay(logger);
  await start(app, {
    name: SERVICE,
    port: PORT,
    logger,
    discovery,
    onShutdown: [() => events.stop(), () => pool.end()],
  });
})().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

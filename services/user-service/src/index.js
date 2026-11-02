const {
  createLogger,
  Discovery,
  createApp,
  finalize,
  start,
  HttpProblem,
  isUuid,
  requireUserId,
  issueToken,
} = require('@socialflow/common');
const { pool, migrate } = require('./db');

const SERVICE = 'user-service';
const PORT = Number(process.env.PORT || 3001);
const logger = createLogger(SERVICE);
const discovery = new Discovery({ logger });
const app = createApp({ logger });

const toUser = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  bio: row.bio,
  followerCount: row.follower_count,
  followingCount: row.following_count,
  createdAt: row.created_at,
});

function uuidParam(req, name = 'id') {
  const value = req.params[name];
  if (!isUuid(value)) throw new HttpProblem(400, `${name} must be a uuid`);
  return value;
}

function pageLimit(raw, def = 100, max = 1000) {
  const n = Number(raw ?? def);
  if (!Number.isInteger(n) || n < 1) throw new HttpProblem(400, 'limit must be a positive integer');
  return Math.min(n, max);
}

// Create user
app.post('/users', async (req, res) => {
  const { username, email, displayName, bio = '' } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username || '')) throw new HttpProblem(400, 'username must be 3-30 chars [a-zA-Z0-9_]');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new HttpProblem(400, 'email is invalid');
  if (!displayName || displayName.length > 80) throw new HttpProblem(400, 'displayName is required (max 80)');
  if (bio.length > 280) throw new HttpProblem(400, 'bio max 280 chars');

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, display_name, bio) VALUES ($1, lower($2), $3, $4) RETURNING *`,
      [username, email, displayName, bio],
    );
    // POC sign-up returns an access token; production signs in via OIDC (Google/Facebook).
    res.status(201).location(`/users/${rows[0].id}`).json({ ...toUser(rows[0]), accessToken: issueToken(rows[0].id) });
  } catch (err) {
    if (err.code === '23505') throw new HttpProblem(409, 'username or email already taken');
    throw err;
  }
});

// Get user profile
app.get('/users/:id', async (req, res) => {
  const id = uuidParam(req);
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpProblem(404, 'user not found');
  res.json(toUser(rows[0]));
});

// Follow user :id (the caller is identified by the bearer token)
app.post('/users/:id/follow', async (req, res) => {
  const followerId = requireUserId(req);
  const followeeId = uuidParam(req);
  if (followerId === followeeId) throw new HttpProblem(400, 'cannot follow yourself');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount: exists } = await client.query('SELECT 1 FROM users WHERE id = ANY($1::uuid[])', [[followerId, followeeId]]);
    if (exists !== 2) throw new HttpProblem(404, 'user not found');
    const { rowCount } = await client.query(
      'INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [followerId, followeeId],
    );
    // Denormalised counters keep profile reads O(1); only bump on a real insert (idempotent follow).
    if (rowCount === 1) {
      await client.query('UPDATE users SET follower_count = follower_count + 1 WHERE id = $1', [followeeId]);
      await client.query('UPDATE users SET following_count = following_count + 1 WHERE id = $1', [followerId]);
    }
    await client.query('COMMIT');
    res.status(rowCount === 1 ? 201 : 200).json({ followerId, followeeId, following: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Unfollow user :id
app.delete('/users/:id/follow', async (req, res) => {
  const followerId = requireUserId(req);
  const followeeId = uuidParam(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [followerId, followeeId]);
    if (rowCount === 1) {
      await client.query('UPDATE users SET follower_count = follower_count - 1 WHERE id = $1', [followeeId]);
      await client.query('UPDATE users SET following_count = following_count - 1 WHERE id = $1', [followerId]);
    }
    await client.query('COMMIT');
    res.json({ followerId, followeeId, following: false });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Followers of :id, keyset-paginated - used by the feed fan-out worker.
app.get('/users/:id/followers', async (req, res) => {
  const id = uuidParam(req);
  const limit = pageLimit(req.query.limit);
  const after = req.query.after;
  if (after !== undefined && !isUuid(after)) throw new HttpProblem(400, 'after must be a uuid');

  const [{ rows: owner }, { rows }] = await Promise.all([
    pool.query('SELECT follower_count FROM users WHERE id = $1', [id]),
    pool.query(
      `SELECT follower_id FROM follows
        WHERE followee_id = $1 AND ($2::uuid IS NULL OR follower_id > $2::uuid)
        ORDER BY follower_id LIMIT $3`,
      [id, after ?? null, limit],
    ),
  ]);
  if (!owner[0]) throw new HttpProblem(404, 'user not found');
  const items = rows.map((r) => r.follower_id);
  res.json({
    userId: id,
    followerCount: owner[0].follower_count,
    items,
    nextCursor: items.length === limit ? items[items.length - 1] : null,
  });
});

// Accounts :id follows, with their follower counts (feed-service uses it to find celebrities to pull from).
app.get('/users/:id/following', async (req, res) => {
  const id = uuidParam(req);
  const limit = pageLimit(req.query.limit, 1000, 5000);
  const { rows } = await pool.query(
    `SELECT u.id, u.follower_count FROM follows f JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = $1 ORDER BY u.follower_count DESC LIMIT $2`,
    [id, limit],
  );
  res.json({ userId: id, items: rows.map((r) => ({ id: r.id, followerCount: r.follower_count })) });
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
  await start(app, { name: SERVICE, port: PORT, logger, discovery, onShutdown: [() => pool.end()] });
})().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

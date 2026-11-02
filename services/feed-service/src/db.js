const { Pool } = require('pg');
const { runMigration } = require('@socialflow/common');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://socialflow:socialflow@postgres:5432/feed_db',
  max: 10,
});

// Durable copy of every timeline (source of truth when Redis misses).
// At production scale this table moves to Cassandra/ScyllaDB partitioned by user_id.
async function migrate() {
  await runMigration(pool, `
    CREATE TABLE IF NOT EXISTS feed_items (
      user_id    UUID        NOT NULL,
      post_id    UUID        NOT NULL,
      author_id  UUID        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (user_id, post_id)
    );
    CREATE INDEX IF NOT EXISTS feed_items_user_created_idx ON feed_items (user_id, created_at DESC);

    -- Posts by high-follower authors are not fanned out; readers pull them from here.
    CREATE TABLE IF NOT EXISTS author_posts (
      author_id  UUID        NOT NULL,
      post_id    UUID        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (author_id, post_id)
    );
    CREATE INDEX IF NOT EXISTS author_posts_author_created_idx ON author_posts (author_id, created_at DESC);
  `);
}

module.exports = { pool, migrate };

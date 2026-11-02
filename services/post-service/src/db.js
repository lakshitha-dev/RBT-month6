const { Pool } = require('pg');
const { runMigration } = require('@socialflow/common');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://socialflow:socialflow@postgres:5432/posts_db',
  max: 10,
});

// Schema owned by post-service. `outbox` implements the transactional outbox:
// the post row and its event are committed atomically, a relay publishes to Kafka.
async function migrate() {
  await runMigration(pool, `
    CREATE TABLE IF NOT EXISTS posts (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      author_id   UUID          NOT NULL,
      content     VARCHAR(2000) NOT NULL,
      media_urls  TEXT[]        NOT NULL DEFAULT '{}',
      like_count  INTEGER       NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS posts_author_created_idx ON posts (author_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS likes (
      post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id    UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id           BIGSERIAL PRIMARY KEY,
      topic        VARCHAR(100) NOT NULL,
      message_key  VARCHAR(100) NOT NULL,
      payload      JSONB        NOT NULL,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
  `);
}

module.exports = { pool, migrate };

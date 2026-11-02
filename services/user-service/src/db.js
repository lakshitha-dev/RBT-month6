const { Pool } = require('pg');
const { runMigration } = require('@socialflow/common');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://socialflow:socialflow@postgres:5432/users_db',
  max: 10,
});

// Schema owned by user-service (database-per-service).
async function migrate() {
  await runMigration(pool, `
    CREATE TABLE IF NOT EXISTS users (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username        VARCHAR(30)  NOT NULL UNIQUE,
      email           VARCHAR(255) NOT NULL UNIQUE,
      display_name    VARCHAR(80)  NOT NULL,
      bio             VARCHAR(280) NOT NULL DEFAULT '',
      follower_count  INTEGER      NOT NULL DEFAULT 0,
      following_count INTEGER      NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS follows (
      follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (follower_id, followee_id),
      CHECK (follower_id <> followee_id)
    );
    CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows (followee_id, follower_id);
  `);
}

module.exports = { pool, migrate };

// Runs schema DDL under a Postgres advisory lock so scaled-out replicas
// starting at the same time don't race on CREATE TABLE.
const MIGRATION_LOCK_ID = 6060;

async function runMigration(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { runMigration };

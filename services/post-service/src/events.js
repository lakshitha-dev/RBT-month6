// Kafka producer + outbox relay.
// POST /posts writes the post and an outbox row in one transaction, then tries to
// publish immediately (fast path). The relay loop re-publishes anything left behind
// (Kafka down, process crash), so no post is ever lost - delivery is at-least-once.
const { Kafka, Partitioners, logLevel } = require('kafkajs');
const { pool } = require('./db');

const TOPIC_POST_CREATED = 'post.created';
const RELAY_INTERVAL_MS = Number(process.env.OUTBOX_RELAY_INTERVAL_MS || 2000);
const PUBLISH_WAIT_MS = Number(process.env.PUBLISH_WAIT_MS || 250);

const kafka = new Kafka({
  clientId: 'post-service',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
  logLevel: logLevel.WARN,
});
const producer = kafka.producer({
  createPartitioner: Partitioners.DefaultPartitioner,
  idempotent: true,
  maxInFlightRequests: 1,
  retry: { retries: 3 },
});

let connected = false;
let relayTimer = null;
let relaying = false;

async function connect(logger) {
  const admin = kafka.admin();
  await admin.connect();
  // Partitioned by author_id so one author's events stay ordered.
  await admin.createTopics({ topics: [{ topic: TOPIC_POST_CREATED, numPartitions: 6, replicationFactor: 1 }] });
  await admin.disconnect();
  await producer.connect();
  connected = true;
  logger.info('kafka producer connected');
}

async function send(rows) {
  await producer.send({
    topic: rows[0].topic,
    messages: rows.map((r) => ({ key: r.message_key, value: JSON.stringify(r.payload) })),
  });
}

// Fast path: publish a just-committed outbox row, but never hold the HTTP response
// longer than waitMs - the post is already durable, and the relay covers failures.
async function publishNow(row, logger, waitMs = PUBLISH_WAIT_MS) {
  if (!connected) return false;
  const attempt = send([row])
    .then(() => pool.query('UPDATE outbox SET published_at = now() WHERE id = $1', [row.id]))
    .then(
      () => true,
      (err) => {
        logger.warn({ err: err.message, outboxId: row.id }, 'publish failed, relay will retry');
        return false;
      },
    );
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, waitMs, false);
  });
  const published = await Promise.race([attempt, timeout]);
  clearTimeout(timer);
  return published;
}

// Picks up rows the fast path missed. SKIP LOCKED lets several replicas relay
// concurrently without publishing the same row twice; the 2s grace period avoids
// racing the fast path. Consumers are still idempotent (at-least-once delivery).
async function relayOnce(logger) {
  if (relaying || !connected) return;
  relaying = true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM outbox
        WHERE published_at IS NULL AND created_at < now() - interval '2 seconds'
        ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`,
    );
    if (rows.length) {
      await send(rows);
      await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
      logger.info({ count: rows.length }, 'outbox relay published pending events');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.warn({ err: err.message }, 'outbox relay failed');
  } finally {
    client.release();
    relaying = false;
  }
}

function startRelay(logger) {
  relayTimer = setInterval(() => relayOnce(logger), RELAY_INTERVAL_MS);
}

async function stop() {
  clearInterval(relayTimer);
  if (connected) await producer.disconnect();
}

module.exports = { TOPIC_POST_CREATED, connect, publishNow, startRelay, stop };

// Express bootstrap shared by every service: request logging with correlation id,
// /health, JSON errors, Consul registration and graceful shutdown.
const os = require('node:os');
const crypto = require('node:crypto');
const { signToken, verifyToken } = require('./jwt');
const express = require('express');

function createApp({ logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || crypto.randomUUID();
    req.log = logger.child({ reqId: req.id });
    res.set('x-request-id', req.id);
    res.set('x-served-by', os.hostname());
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/health') return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      req.log.info({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: +ms.toFixed(1) }, 'request');
    });
    next();
  });
  return app;
}

function finalize(app, { logger, health }) {
  app.get('/health', async (req, res) => {
    try {
      const details = health ? await health() : {};
      res.json({ status: 'ok', instance: os.hostname(), ...details });
    } catch (err) {
      res.status(503).json({ status: 'down', error: err.message });
    }
  });
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) (req.log || logger).error({ err }, 'unhandled error');
    res.status(status).json({ error: status >= 500 ? 'internal_error' : err.message });
  });
}

async function start(app, { name, port, logger, discovery, onShutdown = [] }) {
  const server = app.listen(port, () => logger.info({ port }, `${name} listening`));
  await discovery.register({ name, port });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await discovery.deregister();
    server.close();
    for (const fn of onShutdown) {
      try {
        await fn();
      } catch (err) {
        logger.warn({ err: err.message }, 'shutdown hook failed');
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

class HttpProblem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// The caller's identity comes from the bearer JWT (sub claim). Kong's jwt plugin rejects
// missing/invalid tokens at the edge; the service verifies again (defence in depth).
const JWT = { secret: process.env.JWT_SECRET, issuer: process.env.JWT_ISSUER || 'socialflow' };

function requireUserId(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match) throw new HttpProblem(401, 'Authorization: Bearer <token> is required');
  let claims;
  try {
    claims = verifyToken(match[1], JWT);
  } catch (err) {
    throw new HttpProblem(401, `invalid token: ${err.message}`);
  }
  if (!isUuid(claims.sub)) throw new HttpProblem(401, 'invalid token: sub must be a user id');
  return claims.sub;
}

const issueToken = (userId) => signToken({ sub: userId }, JWT);

module.exports = { createApp, finalize, start, HttpProblem, isUuid, requireUserId, issueToken };

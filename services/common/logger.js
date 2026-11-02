const os = require('node:os');
const pino = require('pino');

function createLogger(service) {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL || 'info',
    base: { service, instance: os.hostname() },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

module.exports = { createLogger };

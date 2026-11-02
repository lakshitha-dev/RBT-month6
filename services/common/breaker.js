// Circuit breaker factory (opossum) with the defaults from the design:
// 3s timeout, open at 50% errors, half-open after 30s.
const CircuitBreaker = require('opossum');

const DEFAULTS = {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: Number(process.env.BREAKER_RESET_TIMEOUT_MS || 30000),
  volumeThreshold: 5,
  rollingCountTimeout: 10000,
  // 4xx responses are caller errors, not downstream failures.
  errorFilter: (err) => err.status >= 400 && err.status < 500,
};

const registry = new Map();

function createBreaker(action, { name, fallback, logger, ...options } = {}) {
  const breaker = new CircuitBreaker(action, { ...DEFAULTS, ...options, name });
  if (fallback) breaker.fallback(fallback);

  if (logger) {
    breaker.on('open', () => logger.error({ breaker: name }, 'circuit OPEN - failing fast'));
    breaker.on('halfOpen', () => logger.warn({ breaker: name }, 'circuit HALF-OPEN - probing'));
    breaker.on('close', () => logger.info({ breaker: name }, 'circuit CLOSED - recovered'));
    breaker.on('fallback', () => logger.warn({ breaker: name }, 'circuit breaker fallback activated'));
  }

  registry.set(name, breaker);
  return breaker;
}

function breakerStatus() {
  return [...registry.entries()].map(([name, b]) => ({
    name,
    state: b.opened ? 'OPEN' : b.halfOpen ? 'HALF_OPEN' : 'CLOSED',
    stats: {
      fires: b.stats.fires,
      successes: b.stats.successes,
      failures: b.stats.failures,
      rejects: b.stats.rejects,
      timeouts: b.stats.timeouts,
      fallbacks: b.stats.fallbacks,
      latencyMean: b.stats.latencyMean,
    },
  }));
}

module.exports = { createBreaker, breakerStatus, DEFAULTS };

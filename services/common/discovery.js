// Service discovery backed by the Consul agent HTTP API.
// - register(): self-registration with an HTTP health check (deregistered on shutdown)
// - resolve(): returns a healthy instance, round-robin, with a short local cache
const os = require('node:os');

const CONSUL_URL = process.env.CONSUL_URL || 'http://consul:8500';
const CACHE_TTL_MS = Number(process.env.DISCOVERY_CACHE_TTL_MS || 5000);
const REREGISTER_CHECK_MS = Number(process.env.DISCOVERY_REREGISTER_CHECK_MS || 30000);

function containerAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

class Discovery {
  constructor({ logger, consulUrl = CONSUL_URL } = {}) {
    this.logger = logger;
    this.consulUrl = consulUrl;
    this.cache = new Map(); // name -> { instances, expires, rr }
    this.serviceId = null;
  }

  async register({ name, port, tags = [] }) {
    await this.registerOnce({ name, port, tags });
    // Self-healing: if the Consul agent loses its state (restart, failover),
    // re-register instead of silently disappearing from discovery.
    this.watchdog = setInterval(async () => {
      try {
        const res = await fetch(`${this.consulUrl}/v1/agent/service/${this.serviceId}`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 404) {
          this.logger.warn({ serviceId: this.serviceId }, 'registration missing in consul, re-registering');
          await this.registerOnce({ name, port, tags });
        }
      } catch {
        // Consul unreachable: keep serving, try again on the next tick.
      }
    }, REREGISTER_CHECK_MS);
    this.watchdog.unref();
  }

  async registerOnce({ name, port, tags }) {
    const address = containerAddress();
    this.serviceId = `${name}-${os.hostname()}`;
    const body = {
      ID: this.serviceId,
      Name: name,
      Address: address,
      Port: port,
      Tags: tags,
      Meta: { hostname: os.hostname() },
      Check: {
        HTTP: `http://${address}:${port}/health`,
        Interval: '5s',
        Timeout: '2s',
        DeregisterCriticalServiceAfter: '1m',
      },
    };
    // Consul may still be booting; retry with backoff before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${this.consulUrl}/v1/agent/service/register`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`consul register ${res.status}: ${await res.text()}`);
        this.logger.info({ serviceId: this.serviceId, address, port }, 'registered with consul');
        return;
      } catch (err) {
        if (attempt >= 10) throw err;
        this.logger.warn({ err: err.message, attempt }, 'consul registration failed, retrying');
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  async deregister() {
    clearInterval(this.watchdog);
    if (!this.serviceId) return;
    try {
      await fetch(`${this.consulUrl}/v1/agent/service/deregister/${this.serviceId}`, { method: 'PUT' });
      this.logger.info({ serviceId: this.serviceId }, 'deregistered from consul');
    } catch (err) {
      this.logger.warn({ err: err.message }, 'consul deregistration failed');
    }
  }

  async instances(name) {
    const cached = this.cache.get(name);
    if (cached && cached.expires > Date.now()) return cached;

    const res = await fetch(`${this.consulUrl}/v1/health/service/${name}?passing=true`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) throw new Error(`consul lookup ${name} failed: ${res.status}`);
    const entries = await res.json();
    const instances = entries.map((e) => ({
      id: e.Service.ID,
      address: e.Service.Address || e.Node.Address,
      port: e.Service.Port,
    }));
    const entry = { instances, expires: Date.now() + CACHE_TTL_MS, rr: cached ? cached.rr : 0 };
    this.cache.set(name, entry);
    return entry;
  }

  async resolve(name) {
    const entry = await this.instances(name);
    if (entry.instances.length === 0) {
      const err = new Error(`no healthy instances of ${name}`);
      err.code = 'NO_INSTANCES';
      throw err;
    }
    const instance = entry.instances[entry.rr % entry.instances.length];
    entry.rr += 1;
    return instance;
  }

  invalidate(name) {
    this.cache.delete(name);
  }
}

module.exports = { Discovery, containerAddress };

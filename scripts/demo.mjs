#!/usr/bin/env node
// End-to-end demo of the SocialFlow POC, all traffic through the Kong gateway.
//
//   node scripts/demo.mjs            # core flow: users, follows, posts, feed (cache/db), celebrity pull, latency
//   node scripts/demo.mjs --chaos    # + stop post-service and watch the circuit breaker open and recover
//
// Requires the stack to be running: docker compose up -d --build
import { execSync } from 'node:child_process';

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8000';
const CONSUL = process.env.CONSUL_URL || 'http://localhost:8500';
const CHAOS = process.argv.includes('--chaos');
const run = Date.now().toString(36);

const c = { dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m', reset: '\x1b[0m' };
const step = (n, title) => console.log(`\n${c.bold}${c.cyan}[${n}] ${title}${c.reset}`);
const info = (msg) => console.log(`    ${msg}`);
const ok = (msg) => console.log(`    ${c.green}✔${c.reset} ${msg}`);
const warn = (msg) => console.log(`    ${c.yellow}!${c.reset} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (args) => execSync(`docker compose ${args}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

async function api(method, path, { user, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${tokens.get(user)}`;
  const started = performance.now();
  const res = await fetch(`${GATEWAY}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const ms = performance.now() - started;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return { data, ms, headers: res.headers };
}

const tokens = new Map(); // user id -> access token issued at sign-up
const createUser = async (name) => {
  const { data } = await api('POST', '/api/users', { body: { username: `${name}_${run}`, email: `${name}.${run}@socialflow.dev`, displayName: name } });
  tokens.set(data.id, data.accessToken);
  return data;
};

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return { result, ms: Date.now() - start };
    await sleep(intervalMs);
  }
  throw new Error('timed out waiting for condition');
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function main() {
  step(1, 'Service discovery - healthy instances registered in Consul');
  for (const name of ['user-service', 'post-service', 'feed-service']) {
    const entries = await (await fetch(`${CONSUL}/v1/health/service/${name}?passing=true`)).json();
    ok(`${name}: ${entries.length} healthy instance(s) ${c.dim}${entries.map((e) => `${e.Service.Address}:${e.Service.Port}`).join(', ')}${c.reset}`);
  }

  step(2, 'User service - create users and follow graph (via Kong /api/users)');
  const alice = await createUser('alice');
  const bob = await createUser('bob');
  const carol = await createUser('carol');
  const celeb = await createUser('celeb');
  ok(`created alice, bob, carol, celeb ${c.dim}(bob = ${bob.id})${c.reset}`);
  // Sign-up is the only open route; everything else needs the JWT issued at sign-up.
  const anon = await fetch(`${GATEWAY}/api/users/${alice.id}/follow`, { method: 'POST', headers: { 'x-user-id': bob.id } });
  const forged = await fetch(`${GATEWAY}/api/feed`, { headers: { authorization: `Bearer ${tokens.get(bob.id).slice(0, -4)}AAAA` } });
  ok(`gateway auth: no token -> ${anon.status}, tampered token -> ${forged.status} (Kong jwt plugin)`);
  await api('POST', `/api/users/${alice.id}/follow`, { user: bob.id });
  await api('POST', `/api/users/${alice.id}/follow`, { user: carol.id });
  await api('POST', `/api/users/${celeb.id}/follow`, { user: bob.id });
  // Give celeb more followers than CELEBRITY_THRESHOLD (5 in the demo) so their posts use the pull path.
  const fans = await Promise.all(Array.from({ length: 6 }, (_, i) => createUser(`fan${i}`)));
  await Promise.all(fans.map((f) => api('POST', `/api/users/${celeb.id}/follow`, { user: f.id })));
  const celebProfile = (await api('GET', `/api/users/${celeb.id}`, { user: bob.id })).data;
  ok(`bob & carol follow alice; bob + 6 fans follow celeb (followerCount=${celebProfile.followerCount})`);

  step(3, 'Post service - publish posts (transactional outbox -> Kafka post.created)');
  const p1 = await api('POST', '/api/posts', { user: alice.id, body: { content: 'Hello SocialFlow! First post 🎉' } });
  ok(`alice posted in ${p1.ms.toFixed(0)} ms (target < 500 ms), eventPublished=${p1.data.eventPublished}`);
  const p2 = await api('POST', '/api/posts', { user: celeb.id, body: { content: 'Celebrity announcement 📣' } });
  ok(`celeb posted in ${p2.ms.toFixed(0)} ms`);

  step(4, 'Feed service - fan-out via Kafka, cache-aside read path');
  const { result: firstRead, ms: lag } = await waitFor(async () => {
    const r = await api('GET', '/api/feed?limit=20', { user: bob.id });
    return r.data.items.some((p) => p.id === p1.data.id) ? r : null;
  });
  ok(`alice's post reached bob's feed after ~${lag} ms (fan-out lag)`);
  info(`1st read: source=${c.bold}${firstRead.data.source}${c.reset} (cold timeline rebuilt from feed_items, Redis re-warmed)`);
  await sleep(200);
  const secondRead = await api('GET', '/api/feed?limit=20', { user: bob.id });
  info(`2nd read: source=${c.bold}${secondRead.data.source}${c.reset}, ${secondRead.data.tookMs} ms in feed-service`);
  await waitFor(async () => {
    const r = await api('GET', '/api/feed?limit=20', { user: bob.id });
    return r.data.items.some((p) => p.id === p2.data.id);
  });
  ok('celebrity post merged in at read time (pull model - not fanned out to followers)');

  step(5, 'Interactions - like, then re-read the feed (fresh hydration)');
  await api('POST', `/api/posts/${p1.data.id}/like`, { user: carol.id });
  const liked = await api('GET', '/api/feed?limit=20', { user: bob.id });
  const likedPost = liked.data.items.find((p) => p.id === p1.data.id);
  ok(`alice's post likeCount=${likedPost.likeCount}, ranked score=${likedPost.score}`);

  step(6, 'Cache failure path - delete the Redis timeline, feed falls back to the database');
  compose(`exec -T redis redis-cli DEL timeline:${bob.id}`);
  const fromDb = await api('GET', '/api/feed?limit=20', { user: bob.id });
  ok(`after DEL: source=${fromDb.data.source}, items=${fromDb.data.count} (no data lost)`);
  const rewarmed = await api('GET', '/api/feed?limit=20', { user: bob.id });
  ok(`next read: source=${rewarmed.data.source} (re-warmed)`);

  step(7, 'Latency - 50 feed requests through the gateway');
  const client = [];
  const server = [];
  for (let i = 0; i < 50; i++) {
    const r = await api('GET', '/api/feed?limit=20', { user: bob.id });
    client.push(r.ms);
    server.push(r.data.tookMs);
  }
  ok(`end-to-end p50=${percentile(client, 50).toFixed(1)} ms  p95=${percentile(client, 95).toFixed(1)} ms  (target p95 < 200 ms)`);
  info(`feed-service internal p50=${percentile(server, 50)} ms  p95=${percentile(server, 95)} ms`);

  step(8, 'Load balancing - which post-service instance served each request');
  const servedBy = {};
  for (let i = 0; i < 10; i++) {
    const r = await api('GET', `/api/posts/${p1.data.id}`, { user: bob.id });
    const host = r.headers.get('x-served-by');
    servedBy[host] = (servedBy[host] || 0) + 1;
  }
  ok(`x-served-by: ${JSON.stringify(servedBy)}`);
  if (Object.keys(servedBy).length === 1) info(`${c.dim}tip: docker compose up -d --scale post-service=2, then re-run to see both instances${c.reset}`);

  if (CHAOS) await chaos(bob);

  console.log(`\n${c.green}${c.bold}Demo complete.${c.reset}`);
}

async function breakerState() {
  const { data } = await api('GET', '/api/feed/breakers', { user: tokens.keys().next().value });
  return data.breakers.find((b) => b.name === 'post-service.getPosts');
}

async function chaos(bob) {
  step(9, 'Circuit breaker - stop post-service and keep reading the feed');
  // The breaker opens on the error rate over a 10 s rolling window; let the
  // successful requests from the steps above age out first.
  info(`${c.dim}waiting 11 s for the breaker's rolling window to clear...${c.reset}`);
  await sleep(11000);
  compose('stop post-service');
  warn('post-service stopped (all replicas)');
  let openedAt = null;
  for (let i = 1; i <= 12; i++) {
    const r = await api('GET', '/api/feed?limit=20', { user: bob.id });
    const b = await breakerState();
    const color = b.state === 'OPEN' ? c.red : c.green;
    info(`request ${String(i).padStart(2)}: 200 OK degraded=${r.data.degraded} items=${r.data.count} breaker=${color}${b.state}${c.reset} ${c.dim}(failures=${b.stats.failures} rejects=${b.stats.rejects} fallbacks=${b.stats.fallbacks})${c.reset}`);
    if (b.state === 'OPEN' && !openedAt) openedAt = i;
    if (openedAt && i >= openedAt + 2) break;
  }
  ok('feed stayed available from cached post bodies; once OPEN, calls are rejected instantly (no timeouts)');

  step(10, 'Recovery - start post-service, breaker half-opens and closes');
  compose('start post-service');
  await waitFor(async () => {
    const entries = await (await fetch(`${CONSUL}/v1/health/service/post-service?passing=true`)).json();
    return entries.length > 0;
  }, { timeoutMs: 60000, intervalMs: 1000 });
  ok('post-service healthy in Consul again');
  const { ms } = await waitFor(async () => {
    const r = await api('GET', '/api/feed?limit=20', { user: bob.id });
    return !r.data.degraded && (await breakerState()).state === 'CLOSED';
  }, { timeoutMs: 60000, intervalMs: 1000 });
  ok(`breaker CLOSED and feed no longer degraded after ~${(ms / 1000).toFixed(0)} s (resetTimeout = 10 s in demo)`);
}

main().catch((err) => {
  console.error(`\n${c.red}Demo failed:${c.reset} ${err.message}`);
  process.exit(1);
});

# SocialFlow — Month 6 Capstone (System Design & Microservices)

Design and proof-of-concept for **SocialFlow**, a social media platform for 1M+ MAU with a < 200 ms feed, < 500 ms post publish and 99.9% availability.

**Author:** Lakshitha Wijerathne · Engineer Track, Month 6

## Submission

| Required file | Contents | Download |
|---|---|---|
| [`lakshitha-wijerathne-month6-system-design.md`](submission/lakshitha-wijerathne-month6-system-design.md) | Design document | [download](https://github.com/lakshitha-dev/RBT-month6/raw/main/submission/lakshitha-wijerathne-month6-system-design.md) |
| [`lakshitha-wijerathne-month6-c4-diagrams.zip`](submission/lakshitha-wijerathne-month6-c4-diagrams.zip) | All C4 diagrams, L1–L3 (draw.io, PlantUML, PNG) | [download](https://github.com/lakshitha-dev/RBT-month6/raw/main/submission/lakshitha-wijerathne-month6-c4-diagrams.zip) |
| [`lakshitha-wijerathne-month6-microservices.zip`](submission/lakshitha-wijerathne-month6-microservices.zip) | POC code: 3 services, Kong gateway, Docker Compose, demo script | [download](https://github.com/lakshitha-dev/RBT-month6/raw/main/submission/lakshitha-wijerathne-month6-microservices.zip) |
| [`lakshitha-wijerathne-month6-presentation.pdf`](submission/lakshitha-wijerathne-month6-presentation.pdf) | Slides | [download](https://github.com/lakshitha-dev/RBT-month6/raw/main/submission/lakshitha-wijerathne-month6-presentation.pdf) |

The same content is browsable unzipped in this repository:

| Evaluation criterion | Where to look |
|---|---|
| System Design (30) | [Design document](docs/lakshitha-wijerathne-month6-system-design.md): requirements & capacity (§2–3), architecture (§4–7), feed deep dive (§8), scalability (§10), trade-offs (§16), 10× scale (§17); [ADRs](docs/adr/) |
| C4 Documentation (25) | [L1 context](docs/c4/png/L1-context.png) · [L2 containers](docs/c4/png/L2-container.png) · [L3 feed components](docs/c4/png/L3-feed-components.png); sources in [`docs/c4/`](docs/c4/) |
| Microservices POC (20) | [`services/`](services/), [`gateway/kong.yml`](gateway/kong.yml), [`docker-compose.yml`](docker-compose.yml); see [Run it](#run-it) |
| Presentation (15) | [Slides (PDF)](docs/presentation/slides.pdf), [talking points](docs/presentation/talking-points.md), [Q&A prep](docs/presentation/qa-prep.md) |

## Repository contents

| Deliverable | Location |
|---|---|
| System design document | [`docs/lakshitha-wijerathne-month6-system-design.md`](docs/lakshitha-wijerathne-month6-system-design.md) |
| C4 diagrams L1–L3 (draw.io + PlantUML + PNG) | [`docs/c4/`](docs/c4/) |
| Architecture Decision Records | [`docs/adr/`](docs/adr/) |
| Microservices POC | [`services/`](services/), [`gateway/`](gateway/), [`docker-compose.yml`](docker-compose.yml) |
| Presentation (slides, talking points, Q&A prep) | [`docs/presentation/`](docs/presentation/) |
| Session & challenge briefs | [`docs/00-session-overview.md`](docs/00-session-overview.md), [`docs/01-challenge-brief.md`](docs/01-challenge-brief.md) |
| Submission bundle | [`submission/`](submission/) |

## POC architecture

```
             :8000                     Consul DNS (SRV)
 client ──► Kong gateway ─────────────────────┐
             │ /api/users  /api/posts  /api/feed
             ▼            ▼            ▼
        user-service  post-service  feed-service ◄── Kafka post.created (fan-out worker)
             │            │  outbox ──► Kafka            │
             ▼            ▼                              ▼
          users_db     posts_db                    Redis timelines + feed_db
                       (PostgreSQL, one database per service)

 Every service self-registers in Consul (health-checked) and resolves its peers through it;
 feed-service wraps calls to user/post-service in opossum circuit breakers.
```

| Pattern | Where |
|---|---|
| **API gateway** | Kong 3.9 DB-less — [`gateway/kong.yml`](gateway/kong.yml): routing, rate limiting (600/min, 120/min for posts), CORS, `X-Request-ID` correlation |
| **Service discovery** | Consul — [`services/common/discovery.js`](services/common/discovery.js): self-registration + HTTP health check, deregistration on SIGTERM, re-registration watchdog, round-robin resolution; Kong resolves upstreams via Consul DNS SRV records |
| **Circuit breakers** | opossum — [`services/common/breaker.js`](services/common/breaker.js), used in [`feed-service/src/clients.js`](services/feed-service/src/clients.js) with fallbacks (cached post bodies / follow list) |
| **Event-driven fan-out** | Transactional outbox → Kafka `post.created` → [`fanout-worker.js`](services/feed-service/src/fanout-worker.js) (hybrid push/pull) |
| **Cache-aside** | Redis timeline → Postgres `feed_items` fallback + async re-warm ([`feed-generator.js`](services/feed-service/src/feed-generator.js)) |
| **Database per service** | `users_db`, `posts_db`, `feed_db`, each service migrates its own schema |

## Run it

Prerequisites: Docker Desktop (≈ 3 GB free RAM), Node.js ≥ 22 (only for the demo script and tests).

```bash
docker compose up -d --build                 # first run pulls images (~2–3 min)
docker compose ps                            # wait until all services are "healthy"
node scripts/demo.mjs                        # end-to-end demo through Kong
```

Useful URLs:
- API gateway: <http://localhost:8000/api/...>
- Consul UI (registered instances & health): <http://localhost:8500/ui>
- Breaker status: <http://localhost:8000/api/feed/breakers>

### Demo scenarios

```bash
# Service discovery + load balancing: add a replica, no gateway change needed
docker compose up -d --scale post-service=2
node scripts/demo.mjs                 # step 8 shows requests spread across both instances

# Circuit breaker: stops post-service mid-demo, shows degraded feed + breaker OPEN, then recovery
node scripts/demo.mjs --chaos
```

Sample output (Windows laptop, Docker Desktop, 2 post-service replicas):

```text
[1] Service discovery - healthy instances registered in Consul
    ✔ post-service: 2 healthy instance(s) 172.28.1.7:3002, 172.28.1.8:3002
[3] Post service - publish posts (transactional outbox -> Kafka post.created)
    ✔ alice posted in 140 ms (target < 500 ms), eventPublished=true
[4] Feed service - fan-out via Kafka, cache-aside read path
    ✔ alice's post reached bob's feed after ~338 ms (fan-out lag)
    1st read: source=db (cold timeline rebuilt from feed_items, Redis re-warmed)
    2nd read: source=cache, 28.5 ms in feed-service
    ✔ celebrity post merged in at read time (pull model - not fanned out to followers)
[6] Cache failure path - delete the Redis timeline, feed falls back to the database
    ✔ after DEL: source=db, items=2 (no data lost)
[7] Latency - 50 feed requests through the gateway
    ✔ end-to-end p50=23.0 ms  p95=40.6 ms  (target p95 < 200 ms)
    feed-service internal p50=13.3 ms  p95=24.7 ms
[8] Load balancing - which post-service instance served each request
    ✔ x-served-by: {"8099a953bb33":4,"e10a8bd834a8":6}
[9] Circuit breaker - stop post-service and keep reading the feed
    request  4: 200 OK degraded=true items=2 breaker=CLOSED (failures=4 rejects=0 fallbacks=4)
    request  5: 200 OK degraded=true items=2 breaker=OPEN (failures=5 rejects=0 fallbacks=5)
    request  6: 200 OK degraded=true items=2 breaker=OPEN (failures=5 rejects=1 fallbacks=6)
[10] Recovery - start post-service, breaker half-opens and closes
    ✔ breaker CLOSED and feed no longer degraded after ~2 s (resetTimeout = 10 s in demo)
```

Timings vary with host load (a loaded Docker Desktop VM showed feed p95 up to ~200 ms); the first write after start-up is slower while connection pools and Kafka metadata warm up.

### API (via Kong)

**Auth:** `POST /api/users` (sign-up) is the only open route and returns an `accessToken` (HS256 JWT, 24 h). Every other route needs `Authorization: Bearer <token>`: Kong's `jwt` plugin rejects a missing, tampered or expired token with 401 at the edge, and each service verifies it again and takes the caller from its `sub` claim.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/users` | `{ username, email, displayName, bio? }` → profile + `accessToken` (no auth) |
| `GET` | `/api/users/{id}` | Profile with follower/following counts |
| `POST` / `DELETE` | `/api/users/{id}/follow` | Caller follows/unfollows `{id}` (idempotent) |
| `GET` | `/api/users/{id}/followers?limit=&after=` | Keyset-paginated |
| `GET` | `/api/users/{id}/following` | With follower counts |
| `POST` | `/api/posts` | `{ content, mediaUrls? }` → 201, event via outbox |
| `GET` | `/api/posts/{id}` · `/api/posts?ids=a,b` | Single / batch |
| `POST` | `/api/posts/{id}/like` | Idempotent per user |
| `GET` | `/api/feed?limit=20&cursor=` | `{ items, nextCursor, source: cache\|db, degraded, tookMs }` |
| `GET` | `/api/feed/breakers` | Circuit breaker states and stats |

```bash
curl -s -X POST localhost:8000/api/users -H 'content-type: application/json' \
  -d '{"username":"ada","email":"ada@example.com","displayName":"Ada"}'
# use the accessToken from the sign-up response
curl -s localhost:8000/api/feed -H 'authorization: Bearer <accessToken>'
```

## Tests

```bash
cd services && npm install && npm test     # 14 unit tests, no Docker needed
```

Covers the ranking engine, cursor encoding, push/pull merge, fan-out push vs. celebrity pull, breaker behaviour (fallback, opening, timeouts, 4xx not counted) and JWT verification (tampered, foreign-key, wrong-issuer and expired tokens rejected).

## Repository layout

```
docs/                     design doc, ADRs, C4 diagrams, presentation, briefs
services/
  common/                 shared: logger, Consul discovery, HTTP client, breaker factory, server bootstrap
  user-service/           profiles + follow graph            (:3001, users_db)
  post-service/           posts, likes, outbox -> Kafka      (:3002, posts_db)
  feed-service/           fan-out worker, cached feed, ranking (:3003, Redis + feed_db)
  Dockerfile              one image recipe, --build-arg SERVICE=<name>
gateway/kong.yml          declarative Kong config
infra/postgres/init.sql   database-per-service bootstrap
scripts/demo.mjs          end-to-end demo (add --chaos for the breaker scenario)
scripts/generate-drawio.mjs  regenerates the .drawio C4 diagrams
docker-compose.yml
```

Regenerate diagrams:

```bash
node scripts/generate-drawio.mjs
docker run --rm -v "$PWD/docs/c4:/data" -w /data plantuml/plantuml:1.2024.7 -tpng -o /data/png *.puml
```

## Known limitations (deliberate POC scope)

- Auth is simplified: tokens are issued at sign-up with a shared HS256 dev secret (in `kong.yml` and `docker-compose.yml`); no passwords, refresh tokens or OIDC login. Production uses RS256 with the private key in a secrets manager.
- Postgres `feed_items` stands in for Cassandra; Kafka, Consul and Redis are single nodes.
- The reader's follow list is cached for 5 minutes, so a newly followed celebrity's posts can take up to 5 minutes to appear (production invalidates it on a `user.followed` event).
- Unfollow doesn't remove already-delivered posts from timelines; comments, notifications, messaging, media and search services are design-only.
- No dead-letter topic yet: a poison message is retried with backoff.
- `CELEBRITY_THRESHOLD=5` and `BREAKER_RESET_TIMEOUT_MS=10000` are lowered in `docker-compose.yml` so the demo can show the pull path and breaker recovery (production values: 10000 and 30000).
- kafkajs logs a harmless `TimeoutNegativeWarning` on Node 24.

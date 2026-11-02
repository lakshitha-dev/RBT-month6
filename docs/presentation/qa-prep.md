# Anticipated Questions & Answers

## Architecture choices

**Q: Why microservices and not a monolith for 1M users?**
A monolith could serve 1M MAU. I chose services because the workloads differ sharply: feed reads run at 100× the write rate, WebSockets are long-lived, and media is CPU-bound. They also need separate failure domains to reach 99.9%. If the team were small I would start with a modular monolith built on these same boundaries and split it later. See ADR-0001.

**Q: Why Kafka over RabbitMQ or SQS?**
Several independent consumers need the same events: feed, search, moderation, notifications and analytics. Search and analytics must be able to **replay** history to rebuild their state, and per-author ordering matters. Kafka gives a durable, replayable log with ordering per key. SNS+SQS would be simpler to run but has no replay. ADR-0003.

**Q: Why Kong and not Traefik / AWS API Gateway?**
Kong has a declarative single-file config (reviewed like code), mature plugins (JWT, rate limiting, correlation id) and resolves upstreams through Consul DNS. Traefik is great for label-based auto-discovery but has a thinner plugin story. AWS API Gateway adds per-request cost and latency at our volume. ADR-0005.

**Q: Why Consul if you'll run on Kubernetes?**
On EKS, Kubernetes DNS covers basic discovery. I'd keep Consul only for health-aware routing and service mesh (mTLS via Connect), or drop it. In the POC, Consul keeps discovery explicit and platform-agnostic, which is what the exercise asks to demonstrate.

## Feed

**Q: Why not pure fan-out on write?**
A post from an account with 1M followers would mean 1M Redis writes and would delay everyone else's fan-out. The hybrid model caps write amplification at the threshold. The read side merges posts from a handful of celebrities, which costs a few milliseconds.

**Q: How did you pick the celebrity threshold?**
10K is a starting point: an average reader follows few accounts above it, so the pull merge stays small. It's a config value; tune it from data (p95 fan-out lag vs. read-side merge cost).

**Q: What happens on unfollow?**
`user.unfollowed` → feed-service removes that author's posts from the follower's timeline (in Redis, plus a delete in the durable store). Until that finishes, the read path filters by the current follow list. The POC does not implement this yet; it is listed as a known limitation.

**Q: What about new follows: does the old content appear?**
`user.followed` triggers a backfill of the followee's last N posts into the follower's timeline.

**Q: Is the feed really ranked if you paginate by time?**
Ranking happens **within a page** of the newest candidates. That keeps cursors stable (no duplicates or gaps while paging) and is cheap. Global ML ranking would need a candidate-generation + scoring service and is a later, isolated change behind the same interface.

**Q: How do you guarantee < 200 ms?**
The cache-hit path is one Redis range query, one batch hydration call and an in-memory ranking step: about 40 ms server-side by budget. Misses add an indexed DB read. Every dependency has a timeout and a breaker, so a slow service can't push us past the SLO. We'd alert on p95 burn rate.

**Q: What if Redis goes down?**
Reads fall back to the durable `feed_items` store. That's slower but correct, and the demo shows it. Fan-out keeps writing the durable rows. When Redis is back, timelines re-warm on first read. We'd add request coalescing and jittered TTLs to prevent a stampede.

## Data & consistency

**Q: How do you avoid losing a post if Kafka is down?**
The post and its `post.created` event are written to Postgres in **one transaction** (transactional outbox). A relay publishes unpublished rows; this happened for real during POC testing, when Kafka was still electing partition leaders. Consumers are idempotent, so the at-least-once delivery is safe.

**Q: Where do you sit on CAP?**
It depends on the domain. Accounts, usernames and posts are **CP**: correctness over availability. Feeds, counters and notifications are **AP**: a slightly stale feed beats an error. Messages use Cassandra `LOCAL_QUORUM` with timeuuid ordering per conversation.

**Q: How would you shard?**
By `user_id` for users/follows and by `author_id` for posts, with 64 logical shards mapped to fewer physical nodes so we can rebalance later. Follows need a reverse index sharded by `followee_id`. IDs move to 64-bit Snowflake (time-sortable, shard-aware).

**Q: Why UUIDs in the POC?**
They need no coordination. Production would use Snowflake ids: half the memory in Redis timelines and sortable by time.

## Reliability & ops

**Q: Explain your circuit-breaker settings.**
3 s timeout. The breaker opens at ≥ 50% errors with at least 5 calls in a 10 s window, half-opens after 30 s, and 4xx responses don't count. Each dependency gets its own breaker (bulkhead). Fallbacks are specific to each call: cached post bodies, the cached follow list, or none for fan-out, where Kafka retries instead.

**Q: In the demo the breaker opened only after 5 failures. Why not immediately?**
The `volumeThreshold` of 5 prevents flapping on one or two unlucky errors. Before the breaker opens, each failed call still returns the fallback, so users never see an error.

**Q: How do you deploy without downtime?**
Rolling or canary releases. Instances deregister from Consul on SIGTERM before shutting down, and new ones only receive traffic after their health check passes.

**Q: How do you know fan-out is healthy?**
Kafka consumer lag for the `feed-fanout` group is the key metric, with a p95 publish-to-visible SLO of 5 s. We autoscale workers on lag up to the partition count.

## Security & GDPR

**Q: How is the API secured? Can a client pretend to be another user?**
No. Sign-up is the only open route and returns a signed JWT. Kong's `jwt` plugin rejects a missing, tampered or expired token with 401 before it reaches a service (the demo shows both cases), and each service verifies the token again and takes the caller from its `sub` claim, so a header can't impersonate anyone. The POC uses a shared HS256 dev key; production uses short-lived RS256 tokens from OIDC sign-in with refresh tokens, and mTLS between services via a mesh.

**Q: How do you implement the right to erasure across microservices and backups?**
`DELETE /api/me` emits `user.deleted`; every service deletes or anonymises its data within 30 days. For backups and immutable logs we use **crypto-shredding**: PII is encrypted with a per-user key that is destroyed.

## Scale

**Q: What breaks first at 10×?**
Fan-out volume and the durable timeline store, followed by Postgres write capacity for posts and likes. Answers: more Redis shards and Kafka partitions, a lower celebrity threshold, Cassandra for timelines, and sharding Postgres by id. The service boundaries don't change.

**Q: What would you do differently with more time?**
OIDC sign-in with refresh tokens and RS256 keys, unfollow cleanup, a DLQ for poison messages, OpenTelemetry tracing, a load test (k6) to validate the latency budget, and Cassandra for `feed_items`.

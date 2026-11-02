# ADR-0002: Hybrid push/pull fan-out for the home feed

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

The feed must load in < 200 ms (p95) and reads outnumber writes ~100:1. Average users have ~200 followers, but follower counts are power-law distributed: a few accounts have 100K+ followers.

## Decision

- **Push (fan-out on write)** for authors with ≤ `CELEBRITY_THRESHOLD` followers (10,000 in production): the Fan-out Worker writes the post id into each follower's timeline.
- **Pull (fan-out on read)** for authors above the threshold: their posts are stored per author and merged into the reader's feed at read time.
- Redis timelines are only updated when **warm** (the user was recently active); every follower still gets a durable `feed_items` row, and cold timelines are rebuilt from it on the next read.

## Consequences

**Positive**
- Feed read is one sorted-set range query plus a handful of small celebrity pulls → well within budget.
- A celebrity post costs one write instead of millions.
- Redis memory is spent only on active users.

**Negative**
- More complex read path (merge, dedupe).
- Fan-out is eventually consistent (target p95 < 5 s lag).
- The durable timeline store grows quickly (100M rows/day) → TTL of 30 days and a wide-column store at scale.

## Alternatives considered

- **Pure pull** — no write amplification, but read latency grows with following count and every refresh queries many partitions.
- **Pure push** — fastest reads, but celebrity posts cause write storms and fan-out lag for everyone.

# ADR-0004: PostgreSQL + Redis as the core stores (Cassandra for append-heavy data)

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

Users, follows and posts need uniqueness constraints and transactions (e.g. follow + counter update, post + outbox). Timelines, messages and notifications are append-heavy time series read by a single key. Feed reads need single-digit-millisecond access.

## Decision

- **PostgreSQL** per service domain (users, posts, moderation, media metadata). Multi-AZ primary + read replicas; sharded by user/author id when needed.
- **Redis** (cluster mode) for hot timelines (sorted sets), post body cache, follow lists, counters, rate limits and WebSocket routing.
- **Cassandra** (or Amazon Keyspaces) for durable timelines, messages and notifications — partitioned by user/conversation with TTLs. The POC uses an equivalent Postgres table.

## Consequences

**Positive**
- Strong consistency where correctness matters; linear write scaling where volume matters.
- Redis sorted sets map directly to "newest N post ids for a user".

**Negative**
- Three storage technologies to operate.
- Data in Redis is a cache: the system must work (slower) without it — the POC demonstrates the DB fallback.

## Alternatives considered

- **DynamoDB for everything** — operationally simple and scales, but transactions/constraints are limited and ad-hoc queries (moderation, admin) are awkward.
- **MongoDB** — flexible documents, but the core data (users, follows, likes) is relational.

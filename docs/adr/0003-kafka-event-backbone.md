# ADR-0003: Kafka as the event backbone, with a transactional outbox

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

Post creation must return in < 500 ms and never lose data, but triggers a lot of follow-up work: feed fan-out, search indexing, moderation, notifications and analytics. Several independent consumers need the same events, and some (search, analytics) must be able to rebuild state by replaying history.

## Decision

- Use **Kafka** (Amazon MSK in production) for domain events. Topics are keyed by the aggregate owner (e.g. `author_id`) to keep per-entity ordering. RF=3, `acks=all`, idempotent producers.
- Producers use a **transactional outbox**: the business row and the event row are committed in the same Postgres transaction; the event is published immediately and a relay re-publishes anything left unpublished (`FOR UPDATE SKIP LOCKED`, safe with multiple replicas).
- Consumers are **idempotent** and commit offsets only after processing (at-least-once). Poison messages go to a `*.dlq` topic after bounded retries.

## Consequences

**Positive**
- Post publish latency is decoupled from fan-out and indexing.
- No dual-write gap: an event exists if and only if the post exists.
- New consumers (e.g. analytics) can be added without touching producers; projections can be rebuilt by replay.

**Negative**
- Operating Kafka (mitigated by MSK).
- At-least-once delivery means duplicates must be tolerated (PK upserts, ZSET upserts).

## Alternatives considered

- **RabbitMQ** — good for task queues, but no long-term retention/replay and weaker per-key ordering at scale.
- **SNS + SQS** — fully managed and simpler, but no replay and fan-out to many consumers multiplies queues; a reasonable choice for a smaller deployment.
- **Redis Streams** — light-weight, but durability and retention are bounded by memory.

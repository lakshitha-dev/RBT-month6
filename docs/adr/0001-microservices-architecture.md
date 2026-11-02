# ADR-0001: Domain-oriented microservices over a monolith

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

SocialFlow has workloads with very different profiles: feed reads (~100× writes, latency-critical), post writes (durability-critical), long-lived WebSocket connections (notifications, DMs), CPU-heavy media processing, and search indexing. The target is 99.9% availability at 1M MAU growing 50% per year.

## Decision

Split the system into services along domain boundaries — User, Post, Feed, Notification, Message, Media, Search, Moderation — each owning its data (database-per-service), communicating synchronously via REST through an API gateway and asynchronously via Kafka events.

## Consequences

**Positive**
- Independent scaling: feed replicas scale with read traffic, media workers with uploads, WebSocket nodes with connections.
- Failure isolation: messaging or search outages do not affect posting or reading the feed.
- Right storage per domain (Postgres, Redis, Cassandra, Elasticsearch, S3).
- Teams can deploy independently.

**Negative**
- Operational complexity: discovery, gateway, distributed tracing, more deployables.
- Cross-service consistency is eventual and must be designed (outbox, idempotent consumers).
- Local development needs Docker Compose with several infrastructure containers.

**Mitigations:** a shared service template (`services/common`: logging, discovery, breakers, health, shutdown), managed cloud services, platform-level observability.

## Alternatives considered

- **Modular monolith** — simpler to run and a reasonable starting point for a small team; rejected because feed, real-time and media workloads would scale and fail together, and the capstone explicitly targets microservices patterns. The service boundaries above would be the module boundaries if we started there.

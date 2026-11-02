# ADR-0006: Client-side circuit breakers with explicit fallbacks

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

The Feed Service depends synchronously on the Post Service (hydration) and User Service (follow lists, followers for fan-out). A slow or failed dependency must not exhaust feed-service resources or turn into a full outage — the feed is the product's most important page.

## Decision

Wrap every cross-service call in an **opossum** circuit breaker (one per dependency/operation — bulkheading):

| Setting | Value | Reason |
|---|---|---|
| `timeout` | 3000 ms | Upper bound on any dependency call |
| `errorThresholdPercentage` | 50% | Open when half the recent calls fail |
| `volumeThreshold` | 5 | Avoid opening on one or two unlucky calls |
| `resetTimeout` | 30 s (10 s in the demo) | Probe recovery in half-open state |
| `errorFilter` | 4xx ignored | Caller errors are not dependency failures |

Fallbacks:

| Call | Fallback | User impact |
|---|---|---|
| `post-service.getPosts` | Last known post bodies from Redis | Feed still renders; `degraded: true` (like counts may be stale) |
| `user-service.getFollowing` | Last cached follow list | Celebrity posts may be slightly stale |
| `user-service.getFollowers` (fan-out) | None — the Kafka message is retried | Fan-out is delayed, never lost |

Breaker state is exposed at `GET /api/feed/breakers` and logged on every transition.

## Consequences

**Positive:** fast failure instead of piled-up requests; feed stays available during partial outages; behaviour is explicit and unit-tested.

**Negative:** degraded responses must be designed per call; breaker settings need tuning with real traffic.

## Alternatives considered

- **Service-mesh outlier detection (Istio/Linkerd)** — language-agnostic and adds mTLS, but cannot express business fallbacks (serve cached post bodies). Complementary; can be added later.
- **Retries only** — make overload worse during an outage (retry storms).

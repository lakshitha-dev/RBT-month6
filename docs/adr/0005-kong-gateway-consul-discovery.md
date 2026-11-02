# ADR-0005: Kong API gateway with Consul service discovery

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

Clients need a single entry point with authentication, rate limiting, CORS and request correlation. Service instances come and go (autoscaling, rolling deploys) and must be discovered without manual configuration.

## Decision

- **Kong** in DB-less mode with a declarative, version-controlled `kong.yml` (routes, JWT auth, rate limiting, CORS, correlation id). The POC runs Kong's `jwt` plugin on every route except sign-up.
- **Consul** as the service registry: each instance self-registers with an HTTP health check on startup and deregisters on SIGTERM.
  - Service-to-service calls resolve healthy instances through the Consul HTTP API (cached 5 s, round-robin).
  - Kong resolves upstream hosts like `post-service.service.consul` through **Consul DNS (SRV records)**, so scaling a service changes routing automatically.

## Consequences

**Positive**
- Gateway config is code-reviewed and reproducible; no gateway database to run.
- Zero-config scale-out: `docker compose up --scale post-service=2` is picked up by Kong and by other services.
- Unhealthy instances are removed within one health-check interval (5 s).

**Negative**
- Consul is another critical component (3–5 server nodes in production).
- On Kubernetes, native Services/CoreDNS overlap with Consul; there Consul is kept mainly for health-aware discovery and service-mesh (mTLS) features, or replaced by the platform's DNS.

## Alternatives considered

- **Traefik** — auto-discovers Docker/K8s services from labels with less config; Kong was preferred for its plugin ecosystem (JWT, rate limiting, request transformation) and declarative single-file config.
- **AWS API Gateway** — fully managed, but adds latency/cost per request at our volume and ties the POC to AWS.
- **Static Docker DNS** — simplest, but no health checks and does not demonstrate discovery.

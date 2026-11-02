# Talking Points — SocialFlow (15 minutes)

Timing target per section in brackets. Total ≈ 15 min (13 min talk + 2 min Q&A); the in-session slot is 8–10 min, so the **short-version** notes say what to cut.

---

## Slide 1 — Title (0:15)
- "I designed SocialFlow, a social network for 1M monthly users, and built a working POC of the core feed path."

## Slide 2 — Problem statement (0:45) · *Section 1: 1 min*
- Features: posts, follows, feed, interactions, notifications, DMs, search, moderation.
- Hard numbers: **feed p95 < 200 ms, publish p95 < 500 ms, 99.9%**, no data loss, GDPR.
- Name the core problem: **read-heavy feed with power-law followers.** Everything else is designed around that.

## Slide 3 — Capacity (0:45)
- 6 writes/s vs 580 reads/s average; ~3,000 rps peak.
- Mention the brief inconsistency (1,000 rps peak vs 50M reads/day) and that I sized for the larger number. Evaluators like seeing the numbers checked.
- Fan-out = 100M timeline inserts/day → not a Redis problem, **a celebrity problem**.
- Media dominates storage → S3 + CDN, never through our services.

## Slide 4 — C4 L1 (0:45) · *Section 2: 3 min*
- Two actors: users and moderators.
- External systems: OAuth (Google/Facebook), SES, Twilio, APNs/FCM, CDN, analytics, Stripe for premium.
- "Everything inside the blue box is ours; the next slide opens it."

## Slide 5 — C4 L2, full view (0:45)
- "This is every container: 20 inside the platform, 5 external systems." Don't read the boxes.
- Point at the rows top to bottom: clients → edge (Kong, WebSocket gateway, Consul) → services → data & events.
- Point at: **database per service**, **Kafka** feeding search, moderation, notifications and analytics, **Billing ↔ Stripe** for premium.

## Slide 6 — C4 L2, core path (0:30)
- "Zooming into the part I built": publish → Kafka → fan-out → cache-first read, numbered 1-2-3 on the diagram.
- Media flow (from the full view): presigned S3 upload, so large files never touch our services.

## Slide 7 — Architecture in one slide (1:00)
- Sync REST vs async events: "if the user doesn't need to wait for it, it's an event."
- The three biggest decisions, each with the alternative I rejected and why.

## Slide 8 — Hybrid fan-out (1:30) · *Section 3: 4 min*
- Push vs pull table, then hybrid.
- Threshold 10K followers (5 in the demo so I can show it).
- **Warm-only pushes**: Redis memory only for the ~10% of users active today.
- Trade-offs: complexity and eventual consistency (fan-out lag SLO < 5 s).

## Slide 9 — C4 L3 (1:15)
- Each box maps 1:1 to a file in `feed-service/src/`. Show that the diagram is the code.
- Two entry points: the API (read path) and the Kafka consumer (write path).
- Service Clients: every outbound call goes through a circuit breaker resolved via Consul.

## Slide 10 — Read path & latency (1:15)
- Walk the 6 steps; stress **one batch hydration call**, not 20.
- Budget ≈ 40 ms server-side; measured p95 ≈ 41 ms end-to-end through Kong on a laptop running 9 containers (internal p95 ≈ 25 ms).
- Story worth telling: the first measurements were ~190 ms p95. Profiling showed the follow list was fetched from user-service on every read, though the design says to cache it. Serving it from Redis removed a network hop and cut p95 by about 4×.
- Ranking is personalised in two stages: candidates come from *your* follow graph, then score = recency × engagement × **affinity to the author** × your **content-type preference**, from a Redis feature store. A new user falls back to recency × engagement. The POC implements recency × engagement; the personal factors are design (§8.5).

## Slide 11 — Scalability (1:30) · *Section 4: 3 min*
- Stateless + Consul DNS, so scaling is `--scale post-service=2` with no gateway change (shown in the demo).
- Caching tiers: CDN → Redis → DB replicas.
- DB path: replicas → partitioning/Cassandra → sharding by user id.
- 10×: same shape, more capacity.

## Slide 12 — Reliability (1:30)
- Go row by row: "what happens when X dies?" Shows designing for failure.
- CAP per domain: CP for accounts/posts, AP for feeds/counters.
- One sentence on GDPR: erasure is an event that every service handles.

## Slide 13 — Demo (2:00) · *Section 5: 2 min*
- Pre-run `docker compose up -d --build` and `--scale post-service=2` **before** the session; keep a terminal ready.
- Run `node scripts/demo.mjs --chaos`. While it runs, narrate:
  1. Consul shows the services → discovery.
  2. Everything goes through Kong on :8000 → gateway; no token or a tampered token → 401 (JWT).
  3. `source: db` then `cache` → cache-aside.
  4. Celebrity post merged → pull path.
  5. `x-served-by` alternating → load balancing.
  6. Chaos: degraded but 200 OK; breaker opens after 5 failures, then rejects instantly; recovers on restart.
- Backup: if the live demo fails, show the recorded output in the README / this deck's slide.
- Optional: Consul UI at http://localhost:8500.

## Slide 14 — Summary (0:30)
- Five bullets, one sentence each. End on "scales 10× without changing shape".

## Slide 15 — Q&A (2:00) · *Section 6*
- See [qa-prep.md](qa-prep.md).

---

### Short version (8–10 min slot)
Skip slide 3 (mention capacity in one sentence), merge 5+6 (talk over the L2 diagram), keep 7–9 (the deep dive is where the points are), compress 10+11 to 90 s, demo 2 min.

### Delivery reminders
- Lead with **why** before **what**; every decision gets "instead of X because Y".
- Point at the diagram while talking; don't read the slide.
- Rehearse with a timer twice; the demo script takes ~45 s (≈ 60 s with `--chaos`).

# Month 6 Challenge — SocialFlow Social Media Platform

## Challenge Brief

- **Role:** You are designing a scalable social media platform
- **Time:** 4 hours (in-session) + final portfolio submission
- **Deliverables:** 4 artifacts + presentation

## Context

### Project Profile

```
Platform: SocialFlow - Social Media Platform
Scale: 1M+ monthly active users
Growth: 50% year-over-year
Availability: 99.9% uptime target
```

### Functional Requirements

1. User registration and authentication
2. Profile management
3. Post creation (text, images, videos)
4. News feed with personalized content
5. Follow/unfollow system
6. Like, comment, share functionality
7. Real-time notifications
8. Direct messaging
9. Search functionality
10. Content moderation

### Non-Functional Requirements

- Feed load time < 200ms
- Post publish time < 500ms
- Support 100K concurrent users
- Data durability (no loss)
- GDPR compliance
- Mobile-first design

## Challenge Tasks

### Part 1: System Design (45 min)

**Requirements Analysis — Capacity Estimation**

```
Users: 1M MAU, 100K DAU
Posts per day: 500K
Reads per day: 50M (100x write)
Feed refreshes: 5/user/day = 500K/day

Storage:
- Posts: 500K/day × 1KB avg = 500MB/day
- Images: 100K/day × 500KB = 50GB/day
- Total: ~20TB/year

Bandwidth:
- Peak: 1000 requests/second
- Average: 200 requests/second
```

**High-Level Architecture**

```
                    ┌─────────────┐
                    │   CDN       │
                    │ (CloudFront)│
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    │Load Balancer│
                    │   (ALB)     │
                    └──────┬──────┘
                           │
         ┌────────────────┼────────────────┐
         │                │                │
    ┌────┴────┐     ┌────┴────┐     ┌────┴────┐
    │ Web     │     │ API     │     │ Media   │
    │ Servers │     │ Gateway │     │ Service │
    └────┬────┘     └────┬────┘     └────┬────┘
         │               │                │
         └───────────────┼────────────────┘
                         │
    ┌──────────┬─────────┼─────────┬──────────┐
    │          │         │         │          │
┌───┴───┐ ┌───┴───┐ ┌───┴───┐ ┌───┴───┐ ┌───┴───┐
│ User  │ │ Post  │ │ Feed  │ │ Notif │ │Message│
│Service│ │Service│ │Service│ │Service│ │Service│
└───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘
    │         │         │         │          │
    └─────────┴────┬────┴─────────┴──────────┘
                   │
         ┌─────────┼─────────┐
         │         │         │
    ┌────┴────┐ ┌──┴──┐ ┌───┴────┐
    │ Primary │ │Cache│ │ Search │
    │   DB    │ │Redis│ │Elastic │
    └─────────┘ └─────┘ └────────┘
```

### Part 2: Architecture Documentation (35 min)

**C4 Level 1 — System Context**

```
Show SocialFlow platform with:
- Users (mobile, web)
- External systems (email, SMS, CDN)
- Third-party auth (Google, Facebook)
- Analytics services
- Payment gateway (premium features)
```

**C4 Level 2 — Container Diagram**

```
Show containers:
- Web Application (React SPA)
- Mobile Apps (iOS, Android)
- API Gateway (Kong/Traefik)
- User Service (Node.js)
- Post Service (Node.js)
- Feed Service (Node.js)
- Notification Service (Node.js)
- Message Service (Node.js)
- Media Service (Go/Node.js)
- PostgreSQL Database
- Redis Cache
- Elasticsearch
- Kafka (message queue)
- S3 (media storage)
```

**C4 Level 3 — Feed Service Components**

```
Components:
- Feed Generator
- Timeline Cache
- Ranking Engine
- Content Aggregator
- Fan-out Worker
```

### Part 3: Microservices POC (25 min)

**Implement 3 Core Services**

```javascript
// user-service/index.js
const express = require('express');
const app = express();

app.get('/users/:id', async (req, res) => {
  // Get user profile
});

app.post('/users', async (req, res) => {
  // Create user
});

app.post('/users/:id/follow', async (req, res) => {
  // Follow user
});

// post-service/index.js
app.post('/posts', async (req, res) => {
  // Create post
  // Publish to Kafka for feed generation
});

app.get('/posts/:id', async (req, res) => {
  // Get single post
});

// feed-service/index.js
app.get('/feed', async (req, res) => {
  // Get personalized feed
  // Check cache first
  // Fall back to database
});
```

**API Gateway Configuration**

```yaml
# kong.yml or traefik.toml
services:
  - name: user-service
    url: http://user-service:3001
    routes:
      - paths: ["/api/users"]

  - name: post-service
    url: http://post-service:3002
    routes:
      - paths: ["/api/posts"]

  - name: feed-service
    url: http://feed-service:3003
    routes:
      - paths: ["/api/feed"]
```

**Circuit Breaker Pattern**

```javascript
const CircuitBreaker = require('opossum');

const options = {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000
};

const breaker = new CircuitBreaker(callExternalService, options);

breaker.fallback(() => getCachedData());
breaker.on('fallback', (result) => {
  logger.warn('Circuit breaker fallback activated');
});
```

### Part 4: Presentation (15 min)

**Presentation Structure**

```
1. Problem Statement (1 min)
   - What are we building?
   - Scale and requirements

2. Architecture Overview (3 min)
   - High-level design
   - Key components

3. Deep Dive: Feed Service (4 min)
   - Why this design?
   - Trade-offs made

4. Scalability Strategy (3 min)
   - Horizontal scaling
   - Caching strategy
   - Database sharding

5. Demo (2 min)
   - Working microservices
   - API gateway routing

6. Q&A (2 min)
```

## Submission Requirements

### Required Files

- `[name]-month6-system-design.md` — Design document
- `[name]-month6-c4-diagrams.zip` — All C4 diagrams
- `[name]-month6-microservices.zip` — POC code
- `[name]-month6-presentation.pdf` — Slides

## Evaluation Preview

| Criteria          | Points | What Evaluators Look For            |
|-------------------|--------|-------------------------------------|
| System Design     | 30     | Scalable, addresses requirements    |
| C4 Documentation  | 25     | Complete L1–L3, clear notation      |
| Microservices POC | 20     | Working services, gateway, patterns |
| Presentation      | 15     | Clear communication, handles Q&A    |
| Overall Quality   | 10     | Code quality, documentation         |

## Tips for Success

- **Start with requirements** — Don't jump to solutions
- **Show trade-offs** — Every decision has pros/cons
- **Think about scale** — What happens at 10x users?
- **Keep POC simple** — Focus on demonstrating patterns
- **Practice presentation** — Time yourself
- **Anticipate questions** — Why did you choose X over Y?

## Program Completion

Congratulations on completing the Engineer Track!

**Next Steps:**
1. Complete offline portfolio requirements
2. Schedule senior engineer assessment
3. Begin mentoring junior developers
4. Apply learnings to production projects

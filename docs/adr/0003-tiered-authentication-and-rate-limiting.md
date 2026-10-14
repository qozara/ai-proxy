# ADR 0003: Tiered Authentication and Rate Limiting

## Status
Accepted

## Context
The proxy serves both authenticated users (e.g., Quozen users logged in via Google Identity) and unauthenticated local-first users (e.g., Quomida users running local food logs with no login). Unauthenticated requests cannot simply be blocked without breaking local-first usability. At the same time, Qozara must protect its upstream API billing quotas against abuse.

## Decision
We establish a 3-tier authentication and rate-limiting gate backed by Upstash Redis sliding windows:

1. **Tier 1: BYOK Requests (`ciphertext` supplied)**
   - **Authentication:** 100% Unauthenticated (no Google login required).
   - **Quota Cost:** 0 financial cost to Qozara (user pays upstream provider).
   - **Abuse Defense:** IP burst rate limiter (default: 60 requests/minute) to prevent compute and encryption oracle abuse.

2. **Tier 2: Authenticated Qozara Intelligence (`ciphertext` absent + Google Bearer Token)**
   - **Authentication:** Verified directly via Google `userinfo` endpoint.
   - **Quota:** 20 requests per 24-hour sliding window keyed by `user.id`.

3. **Tier 3: Anonymous Qozara Intelligence (`ciphertext` absent + no Bearer Token)**
   - **Authentication:** None.
   - **Quota:** 5 requests per 24-hour sliding window keyed by client IP (`cf-connecting-ip` / `x-forwarded-for`).

In addition, browser clients are subject to dynamic CORS origin validation matching `^https:\/\/([a-z0-9-]+\.)*qozara\.org$` and local development hosts.

## Consequences
### Positive
- Fully unauthenticated local-first usability preserved.
- Hard isolation between user-paid BYOK and team-funded Qozara Intelligence.
- Upstash Redis failure fails open safely with console warnings so temporary Redis outages do not bring down edge AI.

### Negative
- Client IP-based rate limiting for anonymous users can share quotas across users on the same NAT / CGNAT.

# ADR 0003: Mode 1A Registered-User Authentication, Allowlist, and Rate Limiting

## Status
Accepted (Updated for Mode 1A Registered-User Gate)

## Context
Qozara applications (such as Quozen and Quomida) run as privacy-first, stateless browser clients that invoke LLMs through `ai-proxy` when users do not run local on-device models or supply their own API key. Previously, unauthenticated requests could fall back to an IP-limited anonymous Qozara Intelligence tier (5 req/day). Leaving a team-funded API endpoint open without authentication exposed Qozara's shared Gemini quota to automated abuse and bot exhaustion.

At the same time, non-expert users still need frictionless access to Qozara Intelligence free quota once signed in and explicitly approved, while BYOK (`ciphertext`) and Local AI (`window.ai` / Ollama) users must remain able to run completely without Qozara registration or team quota consumption. Knowing an allowed email address alone must never grant access—authentication must cryptographically prove control of that Google account via verified Google OAuth tokens.

## Decision
We establish **Mode 1A (Registered-User Gate)**, eliminating anonymous access to Qozara Intelligence and enforcing fail-closed allowlist and quota controls backed by Upstash Redis:

1. **Tier 1: BYOK Requests (`ciphertext` supplied)**
   - **Authentication:** Unauthenticated (no Google login or allowlist entry required).
   - **Quota Cost:** 0 financial cost to Qozara (decrypted statelessly via `KMS_SECRET`; user pays upstream provider).
   - **Abuse Defense:** IP burst rate limiter (60 requests/minute default, fail-open on Redis outage) to protect against compute and KMS abuse.

2. **Tier 2: Registered Qozara Intelligence (`ciphertext` absent)**
   - **Strict Google Authentication Gate:** Requests without a valid `Authorization: Bearer <google_access_token>` header receive `401 UNAUTHORIZED_401` (anonymous cloud tier removed).
   - **Verified Identity & Optional OAuth Audience Binding:** Tokens are verified directly against Google's `userinfo` endpoint, rejecting accounts where `email_verified === false`. When `ALLOWED_GOOGLE_CLIENT_IDS` is set, the proxy also checks token `aud`/`azp` via `https://oauth2.googleapis.com/tokeninfo`. Verified identities are cached in Redis for 5 minutes keyed by `auth-cache:<sha256(qozara-token-cache-v1:<audienceScope>:<token>)>`, while rejected tokens (HTTP 4xx) are negative-cached in isolate memory for 60 seconds and repeated failures from the same IP are shielded (`AUTH_FAILURE_LIMIT_REQUESTS`, default `15/min`) before touching Redis or Google.
   - **Zero-PII Deterministic Allowlist (`qozara:allowed_users`):** Authenticated users are checked against a static env var (`ALLOWED_USER_EMAILS`) and Upstash Redis Set `qozara:allowed_users` using domain-separated hashes `SHA-256("qozara-allowlist-v1:" + email.trim().toLowerCase())` (or HMAC-SHA256 when `ALLOWLIST_PEPPER` is configured). Unregistered accounts receive `403 FORBIDDEN_403`. Hash derivation is independent of `ADMIN_SECRET` and `KMS_SECRET` so secret rotation never invalidates registered users.
   - **Fail-Closed Quotas, Flood Shields & Payload Guardrails:** Enforces per-user sliding window (`20 req/1 d` default, keyed by `ai-limit:user:<user.id>`) and a global daily circuit breaker (`500 req/1 d` default, keyed by `ai-limit:global`). In production, missing Redis configuration or Redis unavailability returns `503 SERVICE_UNAVAILABLE_503` (strictly fail-closed), while rate-limited keys are blocked in isolate memory for up to 60 seconds to shield Redis from command-exhaustion floods. Client IPs resist `X-Forwarded-For` prepending by prioritizing platform headers (`x-vercel-forwarded-for`, `x-real-ip`, `cf-connecting-ip` with `cf-ray`) and rightmost `x-forwarded-for` hops. All `/api/*` endpoints enforce a `64 KB` (`65536` bytes) `bodyLimit` (`413 PAYLOAD_TOO_LARGE_413`), `/health` & `/` return `Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=300` so CDN absorbs health floods, and chat requests are capped at 30 messages, 32,768 total characters, and `maxOutputTokens: 1024`.

3. **Browser & CLI Admin Management (`ADMIN_SECRET`)**
   - `GET /admin` serves a self-contained web console (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`).
   - `GET` and `POST /api/v1/admin/users` expose `register`, `revoke`, `check`, and `list` operations authenticated by a rotatable `ADMIN_SECRET` (>= 16 chars, constant-time verified) and rate-limited by IP (`15 req/1 m`). `optionalAuthMiddleware` is scoped strictly to `/api/v1/agent/*` so Bearer `ADMIN_SECRET` headers are never forwarded to Google.
   - A companion CLI command (`npm run users -- <register|revoke|check|list> ...`) invokes the admin API using `ADMIN_SECRET` and `AI_PROXY_URL`.

In addition, browser clients remain subject to dynamic CORS origin validation matching `^https:\/\/([a-z0-9-]+\.)*qozara\.org$` and local development hosts.

## Consequences
### Positive
- Eliminates anonymous/bot exhaustion of Qozara's Gemini API key.
- Guarantees that knowing a registered email address is insufficient; attackers would need a valid Google-issued access token with `email_verified` for that exact email (and matching OAuth Client ID when configured).
- Stores zero raw user emails (PII) in Upstash Redis (`qozara:allowed_users`).
- Supports instant `ADMIN_SECRET` rotation in Vercel/GitHub/Cloudflare without invalidating the existing user allowlist.
- Preserves unauthenticated BYOK (`ciphertext`) and client-side Local AI usability.

### Negative
- New Qozara Intelligence users without their own API key must be registered by an administrator before first use.
- Upstash Redis downtime blocks Qozara Intelligence requests (`503 SERVICE_UNAVAILABLE_503`, fail-closed) while BYOK continues working.

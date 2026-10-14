# ADR 0002: Stateless BYOK Envelope Encryption

## Status
Accepted

## Context
Qozara applications operate under a strict **Privacy-First & Local-First** paradigm. Storing user API keys in a central database introduces severe security, privacy, and compliance risks (GDPR, data breach blast radius). However, transmitting raw personal API keys directly over client requests exposes them in browser memory and network inspection tools.

## Decision
We implement a **Stateless Bring-Your-Own-Key (BYOK) Envelope Encryption** model:
1. The edge proxy holds a cryptographically random 32-byte secret (`KMS_SECRET`).
2. When the user inputs their personal Gemini API key, the client calls `POST /api/v1/agent/encrypt`.
3. The proxy encrypts the key using AES-256-GCM with a fresh 12-byte initialization vector (IV) per invocation and returns the base64-encoded `ciphertext`.
4. The proxy stores **nothing**. The `ciphertext` is persisted exclusively in the user's personal Bring-Your-Own-Storage (Google Drive `settings.json` or local IndexedDB / RxDB).
5. On subsequent chat requests, the client sends `ciphertext`. The proxy decrypts it in-memory at the edge for the duration of the request and immediately discards the plaintext.

## Consequences
### Positive
- Zero server-side persistence: No central database to compromise or maintain.
- User data sovereignty: The key ciphertext remains in the user's personal storage boundary.
- Edge performance: Web Crypto AES-256-GCM executes in sub-millisecond edge time.

### Negative
- If `KMS_SECRET` is rotated on the proxy without a migration strategy, existing user ciphertexts become invalid and users must re-enter their API keys.

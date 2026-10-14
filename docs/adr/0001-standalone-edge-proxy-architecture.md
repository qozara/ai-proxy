# ADR 0001: Standalone Edge AI Proxy Architecture

## Status
Accepted

## Context
Individual apps across the Qozara ecosystem ([`quozen`](https://github.com/qozara/Quozen), [`quomida`](https://github.com/qozara/quomida)) require intelligent natural language parsing and agentic tool-calling capabilities. Previously, Quozen embedded an internal AI proxy (`apps/ai-proxy`), creating tight coupling to Quozen-specific models, Google auth utilities, and expense schemas. Quomida, a local-first nutrition tracker with zero mandatory login, could not reuse this infrastructure without taking on unnecessary dependencies.

## Decision
We extract the AI proxy into a dedicated, standalone monorepo repository at `qozara/ai-proxy` deployed to `ai.qozara.org` on Cloudflare Workers. 
1. The repository contains two packages: `apps/worker` (the edge proxy) and `packages/client` (`@qozara/ai-client`, the isomorphic client SDK).
2. The proxy exposes a normalized, client-agnostic API accepting standard JSON-Schema tool definitions.
3. Domain-specific logic (expense management, meal logging, local storage) remains isolated in client applications.

## Consequences
### Positive
- Single point of maintenance for upstream AI providers (Gemini, Ollama, future Workers AI / vLLM).
- Full code sharing across Qozara apps via `@qozara/ai-client`.
- Independent scaling, rate-limiting, and deployment lifecycle.

### Negative
- Sibling repository overhead and separate CI/CD pipelines.

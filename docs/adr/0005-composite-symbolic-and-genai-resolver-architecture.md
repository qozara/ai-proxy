# ADR 0005: Composite Symbolic + GenAI Resolvers and Unified Settings

## Status
Accepted

## Context
Both Quozen and Quomida combine **Symbolic / Deterministic AI** (fast, offline rule-based natural language parsers) with optional **Generative AI (GenAI / LLM)** tool-calling escalation when inputs are unmatched or ambiguous. Previously, each client application duplicated:
- O(1) in-memory LRU caching (`LruMemoryCache`),
- ReDoS-safe provider error classification (`classifyAiError`),
- Edge BYOK encryption helpers (`AiKeyEncryptionService`),
- Multi-format LLM tool argument extraction (`extractToolCallData`),
- Draft-validate-persist settings helpers and provider preference normalization, and
- Custom wrappers around `AiProviderFactory` to prevent eager `localhost:11434` probing unless explicitly opted in.

Additionally, framing user settings as "Disable AI" was ambiguous because deterministic NLP remains active and transparent to end users even when GenAI is turned off.

## Decision
We consolidate all generic Neuro-Symbolic / Composite AI orchestration primitives into `@qozara/ai-client@1.1.0`:
1. **Strict Opt-In Local Network Probing (`enableLocalAi`)**: `AiProviderFactory.createProvider` requires `Boolean(config.enableLocalAi)` before probing or instantiating `LocalOllamaProvider` in both `'local'` and `'auto'` modes, preventing unexpected browser Local Network Access permission dialogs.
2. **Unified `UserAiSettings` & GenAI Terminology**: Canonicalizes `GenAiProviderPreference` (`'auto' | 'cloud' | 'byok' | 'local-browser' | 'local' | 'disabled'`), `normalizeProviderPreference`, `isGenAiEnabled`, `AiKeyEncryptionService`, and `validateAndPrepareAiSettings`. Legacy aliases (`'qozara-intelligence'`, `'ollama'`, `'window.ai'`) normalize transparently.
3. **Shared Primitives**: Centralizes `LruMemoryCache` and `AiError` / `classifyAiError` (with `AiCommandError` and `AiMealError` aliases).
4. **Composable Resolvers**:
   - `GenAiToolResolver` (`createGenAiToolResolver`) encapsulates provider resolution, prompt dispatch, multi-format JSON/tool-call extraction (`extractToolCallData`), LRU caching of successful responses, and error classification.
   - `CompositeAiResolver` (`createCompositeAiResolver`) implements the `IAiResolver` contract to chain a symbolic fast-path with an escalation predicate, optional GenAI resolution, and graceful fallback on GenAI failure or opt-out.

## Consequences
### Positive
- Eliminates duplicated cache, error, encryption, settings, and tool-parsing boilerplate across `@quozen/ai-services` and `@quomida/ai-services`.
- Enables Quomida (and any new Qozara app) to unlock `'auto'` waterfall routing and opt-in `enableLocalAi` protection seamlessly.
- Clarifies that disabling GenAI leaves built-in offline symbolic AI operational with zero UI fragmentation.

### Negative
- Client repositories must upgrade `@qozara/ai-client` to `^1.1.0`.

# ADR 0004: Polymorphic Provider Architecture and Fallback Waterfall

## Status
Accepted

## Context
Client applications require flexibility in how AI inference is executed. Users may run completely offline (using a local Ollama daemon or Chrome's on-device Gemini Nano via `window.ai`), use their personal BYOK keys, or fall back to managed cloud intelligence. Client applications should not have to manually implement complex fallbacks or tool schema transformations.

## Decision
We implement a polymorphic AI provider architecture in `@qozara/ai-client`:
1. **Unified Interface (`AiProvider`):** Standardizes `chat`, `checkAvailability`, and `getSetupMessage`.
2. **Dynamic Tool Calling:** Providers inspect client tools dynamically at runtime, avoiding any hardcoded application-specific function names.
3. **Polymorphic Fallback Waterfall in `auto` Mode:**
   $$\text{BYOK (Personal Cloud Key)} \longrightarrow \text{Window.AI (Gemini Nano)} \longrightarrow \text{Local Ollama} \longrightarrow \text{Qozara Intelligence (Edge Proxy)}$$
4. **Edge Provider Factory (`apps/worker`):** Implements `AiSdkAdapter` abstraction allowing future addition of open-weights models (Cloudflare Workers AI, vLLM) with zero client SDK refactoring.

## Consequences
### Positive
- Client code writes tool calls once and runs seamlessly across all local and cloud backends.
- True offline capability when Ollama or Gemini Nano is present.
- Seamless upgrade path to self-hosted models.

### Negative
- Local models (e.g., small quantization Ollama or Nano) may exhibit variance in JSON tool compliance compared to cloud models, requiring fallback parsing heuristics.

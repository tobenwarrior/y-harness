---
kind: upgrade-guide
description: "The Bot memory removal request has a distinct Remote API type name in the published types entry point."
---

# Bot memory request type names

## Change

The `@yharness/bots/types` entry point now names the Remote API request `BotMemoryForgetRemoteRequest` so it cannot be confused with the provider-scoped `BotMemoryForgetRequest`. The `@yharness/bots/client` entry point retains `BotMemoryForgetRequest` as a compatibility alias.

## Migration

1. If code imports `BotMemoryForgetRequest` from `@yharness/bots/types`, change that import to `BotMemoryForgetRemoteRequest`.
2. Code importing from `@yharness/bots/client` may keep `BotMemoryForgetRequest`; use `BotMemoryForgetRemoteRequest` for new code.
3. Rebuild the TypeScript consumer and confirm its `forgetMemory` request still contains `botId` and `memoryId`.

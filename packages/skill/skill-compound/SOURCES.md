# Sources

Record only sources whose ideas or material affect the toolkit. Keep raw downloads and evaluation transcripts outside the published repository.

## pstack

- Source: [cursor/plugins, pstack](https://github.com/cursor/plugins/tree/e5136d82418d2db3165ea1050d17577cd618cc05/pstack).
- Revision: `e5136d82418d2db3165ea1050d17577cd618cc05`, inspected 2026-10-15; manifest version `0.15.25`.
- License: MIT, copyright 2026 Lauren Tan. Full notice: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Inspected: `skills/poteto-mode/SKILL.md`, its investigation/feature/bug-fix/refactoring playbooks, `skills/architect/SKILL.md`, `skills/interrogate/SKILL.md`, the reader-load and behavior-testing principles, manifests and license.
- Retained: conditional task routing; caller-first interfaces; explicit data and ownership; reproduce and verify on the relevant surface; behavior-preserving refactoring; evidence-backed review; reader effort as a design criterion.
- Adapted into: [compound](skills/compound/SKILL.md) and its linked references. Wording and routing were rewritten for a shared Codex/Cursor/Claude Code package.
- Excluded: fixed model names, Cursor tool calls, mandatory parallel panels, automatic PR opening, external communication authority, aggressive comment removal, automations and the large playbook catalog.

## Earlier lucas-skills

The repository hygiene checker, stdlib code-map indexer, symbol/LSP lookup helpers, and local viewer originated in lucas-skills and are maintained here under [LICENSE](LICENSE). Private memory integration and platform-specific graph orchestration are outside this package.

The earlier guidelines credited [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills), derived from Andrej Karpathy's observations about coding agents. That repository declares MIT in its README, but no standalone license notice was available when inspected. Its guideline and example files are not bundled; the new engineering entrypoint is rewritten. Preserve this lineage rather than presenting those earlier ideas as original.

## Claude-Mem local service concept

- Source: [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem/tree/b8fc2ef9bab0dd1438d6cc8699c6884445ad409b), revision `b8fc2ef9bab0dd1438d6cc8699c6884445ad409b`, inspected 2026-10-16.
- License: Apache-2.0; `NOTICE` attributes Alex Newman and the Claude-Mem project. No source code, prompts, styles, or assets were copied.
- Inspected: `README.md`, `LICENSE`, `NOTICE`, `package.json`, `docs/public/architecture/overview.mdx`, `docs/public/architecture/worker-service.mdx`, `docs/public/platform-integration.mdx`, `docs/public/hooks-architecture.mdx`, and `src/services/worker/README.md`.
- Retained: a shared local worker, health check, stable loopback viewer, and incremental updates. Adapted into the original stdlib map service and bundled viewer, with polling instead of an event-stream dependency.
- Excluded: lifecycle hooks, session capture, memory/search databases, embeddings, provider SDKs, Node/Bun runtime requirements, and the Express/React build stack.
- Evidence: ignored HTTP fixtures cover process reuse, updates, lifecycle and request boundaries; browser and native host checks exercise the actual viewer and command.

## Future integrations

Follow the [maintainer integration guide](CONTRIBUTING.md). Add a short entry recording source, immutable revision or content hash, license/notice, inspected material, accepted and rejected ideas, destination, and the behavioral/context evidence supporting the decision. Current packaging guidance comes from the official [OpenAI](https://developers.openai.com/plugins/build/plugins), [Cursor](https://cursor.com/docs/reference/plugins), and [Claude Code](https://code.claude.com/docs/en/plugins-reference) documentation.

Session, project, and global activation use the hosts' native persistent instructions: [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Cursor user-scoped plugins](https://cursor.com/docs/plugins) and [persistent plugin rules](https://cursor.com/docs/reference/plugins#rules-format), and [Claude Code project instructions](https://code.claude.com/docs/en/memory). The setup helper and managed routing section are maintained here under the project license.

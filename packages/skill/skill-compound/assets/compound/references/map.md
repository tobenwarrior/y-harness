# Code maps

Use focused files and import neighbors to choose source reads; confirm behavior and callers in source/tests. Missing entries prove nothing: coverage is bounded and import links are not a complete call graph. Use native search for reported limits. Skip mapping for activation-only requests, non-code work, and questions answerable from a supplied snippet.

`code_map.py --no-cache` scans in memory without cache, repository writes, or a service. For write-authorized tasks, omit it to start or reuse the shared local service. Its index reuses unchanged file metadata and checks additions, edits, and deletions. If service startup fails, the helper reports it and falls back to a bounded local scan.

## Live viewer

Use the [map utility](../../map/SKILL.md) for a visual request. It starts or reuses one loopback service at `http://127.0.0.1:43127/` and opens the registered project. `COMPOUND_MAP_PORT` can select another port. Opening again reuses the index; saved project links restore on demand after restart. It creates no HTML snapshot. Cold indexing runs in the background; the page stays responsive and retains its last map during incremental updates. It does not restructure source code.

Map viewing authorizes local cache and service startup only, without repository edits or onboarding cleanup. The helper's `status` and `stop` subcommands inspect or stop this shared service. It runs until stopped or the machine session ends; the next coding or map request starts it again. It scans only repositories registered by those requests, not every project at login.

Python 3.11+ and Git are required; no added dependency, provider, database, or watcher. Python receives AST outlines; JS/TS receives bounded outlines and local imports, including supported project aliases. Other recognized files have metadata only. Git-listed `build/` and `dist/` source is included. Each pass reads at most 64 MiB and 1 MiB per file; beyond those limits, metadata remains visible with partial-outline coverage. The viewer indexes up to 5,000 files and draws up to 20,000 links; counts retain indexed totals. Use search, neighborhoods, changed files, impact, and directed import traces. Import traversal indicates structural relationships, not runtime calls. Normal exclusions appear under coverage; failures and limits remain warnings.

Metadata includes line counts, export hints, unresolved imports, Git changes, and bounded recent co-change history. Rank by the task, dependency importance, and current work; confirm those hints in source. Outlines retain up to 512 symbols per file and disclose truncation. Agent text remains capped at 2,500 characters.

Metadata and service state stay in Compound's user cache, outside the repository. Normal APIs contain no source bodies. Explicit **Source** or symbol selection reads a bounded 64 KiB preview of an indexed file without caching its body. The loopback service validates indexed paths and rejects private files, traversal, symlinks, and foreign origins. Keep generated maps out of commits; chat summaries enter normal context.

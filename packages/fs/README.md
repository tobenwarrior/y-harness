---
description: "The filesystem package group: the ctx.fs provider contract, patch parser, local and sandbox-enforcing backends, the read-before-mutation policy plugin, and the model-facing file and search tools."
kind: "package-group"
---

# packages/fs

## Summary

The `fs/` group gives agents policy-governed access to files through stable identities, bounded reads, Codex-style patch parsing, host and sandbox backends, read-before-mutation policy, and model-facing read, write, edit, and search tools. A deployment mounts one backend, loads the policy for freshness-guarded mutations, and registers the tools the model should see; backends swap without touching tools or policy. File I/O has no timeout; cancellation is best-effort at syscall boundaries.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Eight packages play the filesystem roles; the subsystem reference owns the exhaustive contracts and the error taxonomy.

| Package | Role | ctx key |
|---|---|---|
| [`fs/`](fs/README.md) | `ctx.fs` service contract: execution-world paths, bounded text I/O, and atomic mutations with an optional version guard | `ctx.fs` |
| [`fs-patch/`](fs-patch/README.md) | Pure Codex-style patch parser and text-hunk matcher used by providers and `apply_patch` | — |
| [`fs-local/`](fs-local/README.md) | Host-filesystem backend: reads, writes, and edits real files on the local machine | registers on `ctx.fs` |
| [`fs-sandbox/`](fs-sandbox/README.md) | Sandbox-enforcing backend: fences writes and edits by the per-call sandbox mode while reads pass through | registers on `ctx.fs` |
| [`fs-observation-policy/`](fs-observation-policy/README.md) | Read-before-edit policy: records observed presence or absence and guards write/edit through the `fs/*` events | `fs/*` listeners |
| [`tool-fs/`](tool-fs/README.md) | Model-facing `read`, `read_image`, `write`, `edit`, and optional `apply_patch` tools plus their executor | registers on `ctx.tools` |
| [`tool-fs-search/`](tool-fs-search/README.md) | Model-facing `glob` and `grep` discovery tools backed by the packaged ripgrep binary | registers on `ctx.tools` |
| [`tool-str-replace-editor/`](tool-str-replace-editor/README.md) | Standalone `str_replace_editor` tool: `view`, `create`, `str_replace`, and `insert` over `ctx.fs` | registers on `ctx.tools` |

The policy is a plugin, not a service the tools inject: removing it leaves the bare provider's unconditional mutation behavior instead of breaking the tools. The mode fence in `fs-sandbox` and the read-before-edit gate compose. `tool-fs-search` deliberately does not extend the provider contract — search is a process-backed ripgrep workflow, so filesystem backends stay free of a universal search API.

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary and error taxonomy, then the decisions that shaped the family.

- [Filesystem subsystem](../../docs/subsystems/filesystem.md) — targets, outcomes, guards, policy events, and the error taxonomy.
- [Cross-family fs sandbox reference](../sandbox/sandbox-policy/README.md) — the shared sandbox mode fence over the filesystem seam.
- [Portable execution world consumers decision](../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md) — why filesystem and subprocess providers share one execution world.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

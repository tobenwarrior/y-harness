---
description: "Bundled Compound engineering workflows, code maps, and repository audits for Y Harness sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-compound

## Summary

Agents can load the Compound engineering skills — investigate, design, debug, refactor, performance, review, verify, repository hygiene, and Git conventions — together with the code-map and repository-audit tooling that backs them. The package ships a known-good snapshot from [compound-skills](https://github.com/tobenwarrior/compound-skills) and registers it as bundled skills, so a session needs no installation step and no other host. The Y Harness host also checks the upstream commit and can publish a verified newer snapshot automatically without modifying the managed application checkout.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider beside the skill registry and `dsh-tool-skill` to expose `compound`, `map`, `setup`, `setup-global`, and `status-global` in the session catalog.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-skill-compound'
```

| Field | Default | Meaning |
|---|---|---|
| `assetRoot` | Packaged `assets/` | Absolute directory holding the vendored skill folders; packaged carriers can place it outside the application archive. |
| `python` | Newest Python 3.11+ on `PATH` | Absolute interpreter the skill commands must call. The provider probes `python3.13`, `python3.12`, `python3.11`, then `python3`, and reports the resolved interpreter to the model. |
| `mapStateDir` | `~/.cache/compound-skills`, or the system temporary directory when the home directory sits inside the mapped repository | Absolute cache directory for the code-map service. The service refuses a cache inside the repository it maps, so a deployment whose `HOME` is inside the checkout needs the fallback. |
| `overlayRoot` | `~/.local/share/deepseek-harness/compound-skills` | Private directory for verified upstream snapshots. The active revision is selected atomically through `current.json`; the managed Y Harness checkout is never rewritten. |

Each loaded skill body ends with a `Compound runtime` section naming the absolute `skillDir` and `python` the vendored commands must use, because the upstream instructions address `<installed-skill-dir>` and a bare `python3`.

### What the skills do

`compound` routes an engineering request to one of its reference workflows and expects the work to be verified against observable behavior. `map` opens the interactive repository graph. `setup`, `setup-global`, and `status-global` manage the upstream activation model. The bundled `repo_audit.py` reports repository clutter, source-size thresholds, `.gitignore` gaps, and unreferenced scripts without writing to the repository.

## Understand the implementation

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider registration, frontmatter parsing, interpreter resolution, and the appended runtime sections. |
| [`assets/`](assets/) | Byte-identical copy of upstream `skills/`; see [UPSTREAM.md](UPSTREAM.md). |
| [`UPSTREAM.md`](UPSTREAM.md) | Vendored version, upstream commit, and the re-sync procedure. |
| [`LICENSE`](LICENSE), [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), [`SOURCES.md`](SOURCES.md) | The vendored content's MIT license, the pstack notice its workflows were adapted from, and its source attribution record. |

The provider reads `SKILL.md` frontmatter from the active revision at load and serves bodies on request; nothing is copied into `lib/`, so the bundled `assets/` must ship in the package `files` list. When an upstream revision is published, the updater downloads the commit-pinned tree, checks every file's hash and size, validates the skill frontmatter, and atomically publishes the complete revision. A failed or interrupted download leaves the previous active revision in place.

## Further Exploration

- [compound-skills](https://github.com/tobenwarrior/compound-skills) — upstream plugin, its README, and per-workflow references.
- [`packages/skill/skill-office`](../skill-office/README.md) — the packaged-assets provider this package follows.
- [`references/map.md`](assets/compound/references/map.md) — code-map coverage, limits, and the local service.

## Model Experience

Indirectly, through `dsh-tool-skill`, which renders the catalog entries and the selected instruction body.

#### KV Cache effect

Mounting the provider adds five catalog entries; loading a skill appends its body and the runtime section at the existing skill-tool insertion point. The provider adds no separate prompt section.

## Known Limitations and Deferred Work

- The vendored `setup-global` and `status-global` instructions manage Codex, Claude Code, and Cursor configuration files. Y Harness registers these skills unconditionally instead, so those two skills describe a host the session does not run on until the upstream activation model grows a Y Harness host.
- The `map` skill starts a loopback HTTP service outside the Harness request routes. The in-app code map panel proxies it; the browser viewer opens it directly only when the deployment allows loopback access.
- The bundled scripts require Python 3.11 or newer; `repo_audit.py` refuses older interpreters outright. A deployment without one gets a runtime section that names the shortfall and the `python` config field.
- `assets/` is a faithful copy, not a fork. Behaviour changes belong upstream or in this package's provider, never in the vendored tree; see [UPSTREAM.md](UPSTREAM.md).
- Automatic updates are commit-aware: upstream may change its content while keeping the same semantic version. The status route compares both version and commit, and update failures remain visible in the status response while the last verified revision continues serving.

### Dev Note

The update indicator reports a newer upstream revision by comparing both the upstream `plugin.json` version and commit with the active revision. Applying an update writes only to the private `overlayRoot`; the managed checkout stays immutable and does not need a branch, merge, or rebuild.

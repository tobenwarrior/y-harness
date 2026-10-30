---
description: "Shared resolution of the Y Harness home and user-data paths for packages that need one consistent root, tilde expansion, migration, and stable watch paths."
kind: "package-library"
---

# @yharness/home-paths

## Summary

`@yharness/home-paths` lets package authors resolve one Y Harness data root and derive child paths from it. New callers use `$YH_HOME` and `~/.yharness`; existing `$DSH_HOME` values and `~/.dsh` homes remain readable. An explicit migration copies a legacy home without deleting or overwriting data. Use it as a direct library dependency, not through `cordis.yml`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use these helpers wherever a package must agree with the rest of the harness about where user data lives: resolve the home once, then derive every child path from it.

### Resolving the home

```ts
import { resolveYhHome, yhHomePath, yhCachePath } from '@yharness/home-paths'

const home = resolveYhHome()                // configured path, else $YH_HOME, then legacy values, then ~/.yharness
const settings = yhHomePath('settings')     // join one child onto the resolved home
const cache = yhCachePath('models')         // $YH_HOME/cache/models, default ~/.yharness/cache/models
```

For the canonical resolver, an explicit configured path has the highest precedence, followed by a non-empty `$YH_HOME`, a non-empty `$DSH_HOME`, and safe default selection. A populated `~/.dsh` wins over a missing, empty, or partially-created `~/.yharness`, so a failed first launch cannot hide existing data. A populated `~/.yharness` wins when the legacy default is absent or empty. If both roots contain data, the resolver keeps using the legacy root until the caller explicitly selects or migrates the canonical root. Blank environment values are ignored.

`resolveDshHome`, `dshHomePath`, and `dshCachePath` remain available to old package consumers. They now delegate the shared canonical default selection, so existing callers follow `$YH_HOME` and `~/.yharness` without creating a second root; an explicit `dshHome` option and `$DSH_HOME` still work.

`yhCachePath(...segments)` derives paths from the resolved home's `cache` directory. With no segments it returns the cache directory itself. Pass an initial options object, `yhCachePath({ yhHome: home }, ...segments)`, to use an explicit configured home with the same precedence and tilde expansion. The compatibility `dshCachePath` accepts its existing `{ dshHome }` option. Both helpers return an absolute path without creating directories.

### Migrating an existing home

```ts
import { migrateLegacyHome } from '@yharness/home-paths'

const result = await migrateLegacyHome()
if (result.status === 'conflicts') {
  // Resolve each result.conflicts path before using the canonical home.
}
```

`migrateLegacyHome` copies `~/.dsh` to `~/.yharness` by default. It never removes the source or overwrites an existing destination file. Existing directories are traversed, identical files are counted as unchanged, and differing files are returned as conflicts. Pass `{ source, target }` for an explicit migration; the helper rejects identical or nested source and target paths and reports a missing source without creating a destination. The helper does not lock either home, so the caller must fully stop old and new writers before copying. A failed copy may leave a partial destination; rerun it after resolving conflicts.

### Displaying a home

For user-facing paths, render the root symbolically rather than as a machine path. `yhHomeDisplay` returns `~/.yharness` for the canonical default, `~/.dsh` for the legacy default, and `$YH_HOME` for a configured home. The display form never leaks an absolute machine path. `dshHomeDisplay` retains its legacy labels.

### Expanding user paths

`expandHomePath` expands a leading `~`, `~/`, or `~\` against the operating-system home and leaves everything else untouched — non-tilde paths and named-user forms such as `~alice/...` pass through unchanged.

### Canonicalizing watch paths

`canonicalizeWatchPath` gives a native filesystem watcher one canonical spelling of its target: the deepest existing ancestor is resolved through `realpath` and any missing suffix is restored, so a file or directory can be watched before it is created. This prevents Windows from treating a regular-file ancestor as ordinary absence, and prevents 8.3 short-name aliases from mixing with the long paths the native watcher backend emits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is built on one principle: all harness user data lives under one root, and every other helper derives from that decision.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Home resolution, path joining, display, tilde expansion, and watch-path canonicalization |

### Resolution rules

`resolveYhHome` reads the explicit override, then canonical and legacy environment overrides, then inspects both default roots. It selects the populated legacy root whenever the canonical root might be partial, and otherwise selects the canonical root. The chosen value is tilde-expanded and normalized to an absolute path; `yhHomePath` joins child segments with Node's platform path rules. `migrateLegacyHome` is deliberately separate from resolution, so merely starting a new build cannot delete or rewrite existing user data. The `dsh`-named helpers call this same resolver for source compatibility.

### Canonicalization mechanics

`canonicalizeWatchPath` walks up from the target until it finds an existing ancestor, resolves it with `realpath`, proves it is an enumerable directory, and restores the missing suffix. Errors other than absence propagate, and a missing-suffix ancestor that is not a directory is rejected.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the launcher or the consumers that depend on a single home root.

- [Boot package](../../boot/app-boot/README.md) — the launcher that resolves the home before any plugin mounts.
- [Shell environment](../../shell/shell-env/README.md) — how `DSH_HOME` reaches model shell calls.
- [Anonymous user id](../../identity/anonymous-user-id/README.md) — a stored identity file under the resolved home.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the helpers are not the right tool. They are current package constraints, not a task backlog.

- **Expansion is deliberately narrow** — only bare `~`, `~/...`, and `~\...` use the current operating-system home; named-user forms such as `~alice/...`, environment variables, and shell expressions remain unchanged.
- **Canonicalization reads but never mutates** — `canonicalizeWatchPath` performs `realpath` probes and propagates errors other than absence; callers still own directory creation, permissions, and trust policy for the resulting path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

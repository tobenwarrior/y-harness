---
description: "Atomic file replacement and cross-process writer locking for packages that must never leave partial, symlink-hijacked, or wider-permission content on disk."
kind: "package-library"
---

# @yharness/atomic-write

## Summary

Use `dsh-atomic-write` to replace a file without exposing partial content or following a symlinked temporary path. Its writer lock serializes read-modify-write cycles across processes so concurrent writers cannot overwrite one another with stale state. Each replacement uses caller-selected permission bits on a fresh inode, which safely narrows an existing file's permissions. This host-only library accepts strings; it does not provide a `cordis.yml` plugin or crash durability because it does not call `fsync`.

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

Use `writeFileAtomic` when a file-backed store must replace one already-rendered string without ever exposing a partial, symlink-hijacked, or wider-permission state, and `withFileLock` when several processes read-modify-write the same file. The smallest path is one call with the final content and the replacement's permission bits.

### Writing a file atomically

```ts
import { writeFileAtomic } from '@yharness/atomic-write'

declare const text: string
await writeFileAtomic('/home/u/.dsh/cordis.patch.yml', text, { mode: 0o600 })
```

Parent directories are created as needed, and readers observe either the old or the new complete content. On Windows, transient replacement interference reported as `EACCES`, `EBUSY`, or `EPERM` is retried for a bounded interval; any remaining failure removes the temporary file and leaves the target untouched.

### Coordinating writers

For a read-render-commit cycle that a bare atomic commit cannot make safe on its own, hold the writer lock around the operation:

```text
import { withFileLock, writeFileAtomic } from '@yharness/atomic-write'

declare const render: (previous: string) => string
declare const readCurrent: () => Promise<string>

await withFileLock('/home/u/.dsh/cordis.patch.yml', async () => {
  const previous = await readCurrent()
  await writeFileAtomic('/home/u/.dsh/cordis.patch.yml', render(previous), { mode: 0o600 })
})
```

Only writers contend — readers never take the lock — and a contender backs off exponentially and fails with a timed-out error rather than blocking forever. How long a contender waits is stated per call through `waitMs`: the default is sized for file work alone, so a holder whose cycle includes a network round trip — a credential mutation that refreshes an expired token — states a longer one, because leaving the default would fail every other writer of that file for the duration. The retry cadence stays fixed. POSIX uses a nonblocking kernel `flock(2)` on the stable `<filename>.lock` inode; Windows opens that same sidecar with `CreateFileW` and uses an exclusive `LockFileEx` byte range, so path aliases share one kernel lock and deletion is denied while held. The lock path is never removed or renamed, so a holder releases exclusion by closing its descriptor or native handle, including after process death.

### Failures to plan for

The first creator writes a protocol marker while holding the kernel lock. An empty lock file is accepted as an interrupted initialization and is claimed only after the kernel lock is acquired; any other non-marker content is a legacy or unknown protocol and fails closed. `writeFileAtomic` rejects `.lock` sidecar paths with `ERR_ATOMIC_WRITE_LOCK_PATH`, and `withFileLock` rejects symlink, directory, or other non-file sidecars, so public package calls cannot replace a live lock or follow a victim symlink. Direct filesystem replacement remains unsupported because POSIX locks belong to the opened inode; the old holder never removes a replacement pathname.

The lock's parent directory must already exist, so `withFileLock` rejects an invalid parent hierarchy before running the operation. A process that exits while holding a kernel lock releases it automatically; its stable lock file remains for the next writer. A lock file from the pre-kernel protocol is not coordinated automatically; an operator removes it only after verifying that no writer still owns it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is built on one separation: the atomic commit owns the swap, and the writer lock owns cross-process ordering.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `writeFileAtomic` and `withFileLock`, the package's whole surface |

### Write path

`writeFileAtomic` writes a random-suffix sibling opened with exclusive create (`wx`), then renames it over the target. The exclusive open refuses to follow a symlink planted at a guessable temp path; the same-directory sibling keeps the rename on one filesystem; and the rename replaces a symlinked target itself instead of writing through to its referent. A Windows retry keeps the same complete sibling and uses bounded exponential backoff, so temporary use of the target by software outside the cooperative writer lock cannot turn a safe replacement into an immediate failure; the archived [retry decision record](../../../.agents/notes/archived/bug-fix/2026-08-29-windows-atomic-replace-retry.md) documents the original rationale and rejected alternatives.

`withFileLock` creates `<filename>.lock` with exclusive create, acquires a nonblocking POSIX `flock(2)` or a Windows `LockFileEx` byte-range lock on that file handle, writes a protocol marker, and keeps the open handle until the operation settles. A second writer retries on kernel contention and eventually times out. The path is deliberately never unlinked or renamed: POSIX locks belong to an inode, and a pathname replacement would create a different inode that the old descriptor cannot protect; Windows also denies deletion through the held handle. An empty lock file from an interrupted initialization is claimed after the kernel lock is acquired; any other non-marker content fails closed rather than mixing protocols. Missing native lock support also rejects acquisition rather than granting an unprotected write.

### Why the swap stays safe

- **Fresh inode, caller-stated mode** — the temp carries `mode` through the rename, so narrowing a wider-permission file has no chmod race. `mode` is required so the permission decision stays visible at every call site.
- **Readers never contend** — the rename commit is atomic, so a reader needs no lock.
- **Kernel support required** — a missing POSIX flock binding, unavailable Windows file-lock API, or unknown lock-file protocol rejects coordinated writes instead of falling back to pathname cleanup.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the consuming stores or the family this primitive belongs to.

- [Profile configuration editor](../../boot/config-editor/README.md) — the profile patch every edit replaces through this package.
- [Credentials store](../../credentials/credentials-local/README.md) — the credentials file this package locks and replaces.
- [util group map](../README.md) — the utility family this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

None, as this is a pure filesystem write primitive that registers nothing model-facing.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the package is not the right tool. They are current package constraints, not a task backlog.

- **Atomic, not durable** — no `fsync` of the file or its directory, so after a crash the rename may be observed unwound. The file-backed stores here re-read and republish on boot, keeping durability the caller's policy.
- **String content only** — no `Buffer` or stream form until a consumer needs one.
- **Some legacy locks require operator recovery** — a lock file from the pre-kernel protocol stays in place; later writers fail closed without deleting it. Remove it only after verifying that no writer still owns the lock.
- **One host and one filesystem lock domain** — POSIX `flock` and Windows byte-range locks coordinate callers that can observe the same lock path and filesystem lock namespace. Network filesystems with incomplete `flock` support are unsupported; coordinated writes fail rather than silently falling back when the native lock is unavailable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

A durability-replacement that `fsync`s the file and parent directory and preserves owner-only permissions on Windows remains open (tracked as `settings-atomic-durability` in source).

</details>

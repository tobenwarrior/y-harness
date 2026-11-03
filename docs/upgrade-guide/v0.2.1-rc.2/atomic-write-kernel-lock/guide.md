---
kind: upgrade-guide
description: "Atomic-write sidecar locks now use a kernel-owned file protocol and no longer remove lock paths."
---

# Atomic-write kernel locks

## Change

`@yharness/atomic-write` now coordinates writers with POSIX `flock(2)` or a Windows named semaphore held on a stable `<filename>.lock` file. The previous directory/PID sidecars are not taken over or removed automatically, and unknown lock contents fail closed. This affects file-backed stores that upgrade while an older process left a lock sidecar behind.

## Migration

1. Stop all older Y Harness processes before upgrading.
2. Inspect each `<filename>.lock` sidecar used by a file-backed store. Remove a pre-kernel directory/PID lock only after confirming that no writer still owns it.
3. Start the upgraded process and let it create the stable lock file. Do not replace or rename the `.lock` pathname; the kernel lock belongs to its opened inode.
4. If acquisition reports `ERR_ATOMIC_WRITE_LOCK_PROTOCOL`, stop the writers, remove the incompatible sidecar after inspection, and retry the operation.

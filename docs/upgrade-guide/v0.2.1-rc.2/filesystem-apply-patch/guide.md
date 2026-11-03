---
kind: upgrade-guide
description: "The FileSystem service adds abstract guarded patch, delete, and move methods for the apply_patch tool."
---

# Filesystem patch capability

## Change

`@yharness/fs` now requires FileSystem providers to implement `patchText`, `deleteFile`, and `moveFile`, including their version guards and sandbox policy arguments. The new `@yharness/tool-fs` `apply_patch` tool remains opt-in at the package level (`applyPatch: false` by default), while the shipped base, standard, PTC, and Cordis profiles enable it. Providers that extend `FileSystem` outside this repository will fail to compile until they implement the new methods.

## Migration

1. Add guarded implementations of `patchText`, `deleteFile`, and `moveFile` to every external `FileSystem` subclass. Preserve `FsError` codes, `FsDeleteOutcome`, and `FsMoveOutcome` semantics; use `@yharness/fs-local` as the reference provider.
2. Custom profiles can expose the Codex-style tool by setting `applyPatch: true` on their `@yharness/tool-fs` plugin after the provider supports the new methods. Leave the setting omitted to retain the existing tool set. The shipped profiles already set this field; `minimal` remains unchanged because it does not mount `tool-fs`.
3. Rebuild the provider and run the filesystem mutation tests, then confirm that an update, deletion, and move preserve their expected-version guards and sandbox policy.

---
description: "Prebuilt system.node for macOS x64 POSIX locks."
kind: "package-library"
---
# @yharness/node-addon-system-darwin-x64

This platform package supplies `bin/system.node`, a stable Node-API v8 addon used by `@yharness/node-addon-system/flock`. It contains no Landlock executable, JavaScript loader, or installation build script. The native workflow builds it on macOS x64 and owns its installed-artifact validation.

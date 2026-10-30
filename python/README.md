# Y Harness Python SDK

Python packages for driving Y Harness as a subprocess. The client SDK communicates with the bundled runtime over newline-delimited JSON-RPC on stdio.

The canonical distributions are `yharness-sdk` and `yharness-runtime-bin`, the Python modules are `yharness` and `yharness_runtime`, the high-level class is `YHarness`, and the launcher is `yharness`. Legacy distribution, module, class, command, and `DSH_HOME` names remain available as compatibility aliases.

## Packages

| Directory | Dist / module | Role |
|---|---|---|
| [sdk](sdk/README.md) | `yharness-sdk` / `yharness` | High-level turns API and lower-level JSON-RPC client |
| [sdk-runtime](sdk-runtime/README.md) | `yharness-runtime-bin` / `yharness_runtime` | Bundled `yharness` CLI executable and native sidecars |

## Behavior

The SDK starts the matching bundled `yharness --profile sdk` runtime unless the caller selects another `yharness` executable or profile. The runnable minimal example selects the shipped standalone `sdk-minimal` profile; the same runtime also packages `yharness web` and its frontend assets for separate CLI use. Every launch requires an explicitly selected Harness home; Python never silently selects a default. The [SDK reference](sdk/README.md) and [runtime carrier reference](sdk-runtime/README.md) own runtime selection, profiles, patches, and external plugin management.

## Contributor workflows

The [Python contributor workflows](development.md) cover building runtime artifacts, validating the packages, source-mode development, and distribution.

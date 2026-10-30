---
kind: upgrade-guide
description: "Y Harness changes the first-party package, CLI, Python SDK, and home names while retaining compatibility aliases for existing installations."
---

# Y Harness names and user-data compatibility

## Change

First-party Node packages now use the `@yharness/*` namespace. The CLI package is `@yharness/cli` and installs both `yharness` (canonical) and `dsh` (legacy) commands. Profiles created with `@deepseek-ai/dsh-*`, `@deepseek-ai/dsh`, or the supported pre-rebrand Cordis package names continue to resolve through exact aliases, including subpaths. The resolver does not rewrite profile manifests or lockfiles. Provider identities such as `@yharness/llm-deepseek*` remain provider names; unrelated `@deepseek-ai/*` packages are not aliased.

The Python SDK's canonical distributions are `yharness-sdk` and `yharness-runtime-bin`; their modules are `yharness` and `yharness_runtime`, with `YHarness` and `YHarnessConfig` as the primary classes. The old `deepseek_harness` and `deepseek_harness_runtime` modules, `DeepSeekHarness` names, `dsh` command, legacy option names, and legacy environment variables remain compatibility aliases.

`YH_HOME` and `~/.yharness` are the canonical home names. `DSH_HOME` and `~/.dsh` remain readable. Resolution checks an explicit path, `YH_HOME`, `DSH_HOME`, and then the default roots; a populated `~/.dsh` remains selected when the canonical root is missing, empty, or partial. Starting the new build never copies, deletes, or renames a home. The optional source-managed Desktop launcher stages and activates fast-forward updates from `https://github.com/tobenwarrior/y-harness.git`. Signed packaged Desktop releases use the `latest` GitHub Releases channel from `tobenwarrior/y-harness`; test packages retain their private generic Nightly feed.

The first signed package requires protected self-hosted `yharness-signing` runners, macOS Developer ID and notarization credentials, Windows EV signing settings, a matching `v<version>` tag, verified metadata and SHA-512 entries, and GitHub Actions `contents: write`; missing prerequisites stop publication.

## Migration

1. Change new Node dependencies and profile bundle entries to their `@yharness/*` names when you are ready. Existing `@deepseek-ai/dsh-*` entries continue to load, but the resolver leaves `package.json` and `pnpm-lock.yaml` untouched; migrate those files with your package manager if you need the canonical registry names.
2. Change scripts and integrations from `dsh` to `yharness` and verify with `yharness --help`. Keep `dsh` where an older integration requires it.
3. Install `yharness-sdk` and `yharness-runtime-bin` for new Python environments, then import from `yharness` and use `YHarness(yh_home=...)`. Existing Python callers can keep the legacy imports and options while they migrate.
4. To move existing data, stop all Harness processes and call `migrateLegacyHome()` from `@yharness/home-paths` (or pass `{ source: '~/.dsh', target: '~/.yharness' }`). Review any reported conflicts, set `YH_HOME` to the destination, and verify sessions, settings, credentials, and plugins before retiring the source; the helper never overwrites or deletes it.
5. Existing packaged Desktop builds that embed the former generic feed cannot switch feeds from remote metadata. Install the first signed Y Harness package from the `tobenwarrior/y-harness` GitHub Releases page once; the retained application data and Harness home remain available after the installation. Future packaged updates use the GitHub `latest` release automatically.

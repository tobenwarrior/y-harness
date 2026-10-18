# Activation

These modes choose when Compound guides engineering work. Explicit project `setup` also requests a fresh assessment and verified cleanup.

## Current chat

A bare invocation or `session` enables Compound for subsequent engineering tasks in this chat until the user opts out. Treat that choice as a standing preference; users can give normal requests afterward. Apply the core skill and load only the references each task needs. Acknowledge activation briefly and continue any supplied task.

The activation step writes no files; later tasks retain their normal authorization. New chats need activation unless project or global defaults apply. A request to stop using Compound in this chat overrides the preference without changing saved defaults.

## Saved defaults

Use the bundled [helper](../scripts/project_setup.py) through Python 3.11+, using the skill's actual install directory.

`setup global` configures personal defaults for Codex, Cursor, and Claude Code across all projects on this machine. Preflight local state access first: resolve `COMPOUND_SKILLS_STATE_DIR`, defaulting to `~/.cache/compound-skills`, and create that directory. For the selected hosts, merge only its absolute path into the native write-path lists:

- Codex: `sandbox_workspace_write.writable_roots` in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`); if a named permission profile is active, use its existing filesystem rules. See [official configuration](https://developers.openai.com/codex/config-reference).
- Cursor: `additionalReadwritePaths` in `~/.cursor/sandbox.json`. See [native sandbox configuration](https://cursor.com/docs/reference/sandbox).
- Claude Code: use its normal tool permissions; report any required native approval.

Preserve existing entries, modes, approvals, networking, and unrelated settings. Back up locally and validate config before writing; reject symlinked or malformed config paths. A managed policy may prevent access. Report state-access results separately from routing; blocked access leaves first-use cleanup unavailable. Use a fresh session to test the saved configuration, then enable routing:

```bash
python3 <installed-skill-dir>/scripts/project_setup.py enable --global
```

It manages a small routing section in the Codex home's `AGENTS.md` and existing nonempty `AGENTS.override.md`, and a Claude user rule at `~/.claude/rules/compound-skills.md`. It respects `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. For one app, add `--host codex`, `--host cursor`, or `--host claude`.

Cursor carries the routing rule in the native plugin. Install at user scope and leave its `compound-default` rule set to Always in Customize → Rules. Global setup reports Cursor as host-managed; it cannot verify or change that UI setting. If available, inspect it through the host UI; otherwise explain this one-time installation requirement. Do not edit Cursor's private database or claim Cursor is configured from a file written by the helper.

`setup` alone enables guidance and assesses the intended project, including previously completed projects. Establish its root from the task and repository; ask only if ambiguous. Read project instructions and record existing changed and untracked paths before writes:

```bash
python3 <installed-skill-dir>/scripts/project_setup.py enable --project-root <project-root>
```

Project setup manages `AGENTS.md`, an existing nonempty root `AGENTS.override.md`, and a project Claude rule when legacy Claude instructions shadow `AGENTS.md`. It changes no global defaults.

Read the JSON result. After successful project enable, even when routing was already enabled, run the core code-map startup and follow [repository assessment](onboarding.md) in explicit setup mode (`claim --refresh`). Global setup, session activation, status, and disable do not run this pass. Preserve unrelated instructions; stop cleanup on routing errors or partial results. Report routing, assessment, changes, checks, and deferred findings separately; a busy lease means assessment is deferred. Enable the current chat preference too.

The plugin must be installed and enabled at user scope in each app for global use. Setup does not install plugins or verify native runtime loading. New chats load defaults under normal host settings; project guidance and explicit user choices take priority. Saved Codex and Claude rules are machine-local; Cursor follows the plugin installation scope. These are model instructions, not guaranteed enforcement or background refactoring.

## Inspect or remove defaults

For `status` or `disable`, replace `enable` in the corresponding command; preserve `--global` when requested and any host selection. Status is read-only. For project status, also run `onboarding.py status --repo <project-root>` from the installed scripts directory to report first-use completion; global status checks routing; inspect the native cache-path entries separately for state access. Disable removes only the helper's managed sections in that scope and ends the current chat preference. Global disable leaves independent project defaults intact. To stop the Cursor default, change its rule to Manual or disable it in Customize; report that host-managed step separately. Report the actual helper result; existing chats may need a new session to rebuild their instruction context.

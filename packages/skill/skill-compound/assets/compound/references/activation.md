# Activation

These modes choose when Compound guides engineering work.

## Current chat

For a bare invocation or `session`, read the default rule and apply it for the rest of the chat. Acknowledge activation briefly and apply it to any supplied task. [Default routing](default-routing.md)

Review findings alone do not authorize fixes. For other tasks, select checks for the changed surface.

The activation step writes no files; later tasks retain their normal authorization. New chats need activation unless project or global defaults apply. A request to stop using Compound in this chat overrides the preference without changing saved defaults.

## Saved defaults

Use the bundled [helper](../scripts/project_setup.py) through Python 3.11+, using the skill's actual install directory.

`setup global` enables personal defaults across projects. Save routing first:

```bash
python3 <installed-skill-dir>/scripts/project_setup.py enable --global
```

It manages a small routing section in the Codex home's `AGENTS.md` and existing nonempty `AGENTS.override.md`, and a Claude user rule at `~/.claude/rules/compound-skills.md`. It respects `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Without `--host`, it selects apps whose configuration folder exists and names any it skipped. Use `--host codex`, `--host cursor`, or `--host claude` for one app, or `--host all` for every app.

After routing succeeds, configure optional map access for the selected hosts. Resolve `COMPOUND_SKILLS_STATE_DIR` (default `~/.cache/compound-skills`) and create it when permitted. Merge only its absolute path into the native write-path lists:

- Codex: `sandbox_workspace_write.writable_roots` in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`); if a named permission profile is active, use its existing filesystem rules. See [official configuration](https://developers.openai.com/codex/config-reference).
- Cursor: `additionalReadwritePaths` in `~/.cursor/sandbox.json`. See [native sandbox configuration](https://cursor.com/docs/reference/sandbox).
- Claude Code: from Claude's installed copy on macOS or Linux, run `python3 -IB <installed-skill-dir>/scripts/claude_map_launcher.py install`. After it succeeds, merge its `permission_rules` into `permissions.allow` in `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`). Remove old Compound-generated rules for versioned map commands and guide directories under its own Claude plugin cache. Preserve other rules. The launcher follows Claude's enabled user installation across updates. For unsupported installs or a denied bootstrap, use the bundled commands with normal host permissions.

Preserve existing entries, modes, approvals, networking, and unrelated settings. Back up and validate config before writing. Skip symlinked, malformed or inaccessible config paths and report the affected host. If state access is denied, skip its write-path setup and report that the live map and project assessment state may be unavailable. Routing stays enabled where the helper succeeded.

Cursor carries the routing rule in the native plugin. Install at user scope and leave its `compound-default` rule set to Always in Customize → Rules. Global setup reports Cursor as host-managed; it cannot verify or change that UI setting. If available, inspect it through the host UI; otherwise explain this one-time installation requirement. Do not edit Cursor's private database or claim Cursor is configured from a file written by the helper.

For global setup, finish with the saved routing result per selected host, then the optional map access result. Use the helper's status and label Cursor as host-managed. Distinguish a saved rule from verified loading in a model chat. Ask the user to open a fresh chat in a repository with a diff and send “Review my current diff for regressions. Cite the callers or tests that support each finding. Leave files unchanged.” Expect a source-backed review and a report of checks and limits. For a clean checkout, ask the user to replace [feature] with a behavior they recognize and send “Trace [feature] from its entry point to its implementation and tests. Cite file paths and lines. Leave files unchanged.” Expect source locations and a note about any missing tests.

For recovery, give the exact status command for the host in use. Use `/compound-skills:status-global` in Claude Code, `$status-global` in Codex, or `/status-global` in Cursor. For missing or outdated defaults, give that host's setup command. Use `/compound-skills:setup-global`, `$setup-global`, or `/setup-global`. For Cursor, also point to the Always setting above when the rule status is unknown.

## Project setup

`setup` enables guidance for the intended project. Establish the root from the task and repository, and ask only if ambiguous. Read project instructions before running:

```bash
python3 <installed-skill-dir>/scripts/project_setup.py enable --project-root <project-root>
```

Project setup manages `AGENTS.md`, an existing nonempty root `AGENTS.override.md`, and a project Claude rule when legacy Claude instructions shadow `AGENTS.md`. It changes no global defaults. Both project and global setup stop when the helper detects that an instruction file changed before its update. Report any already-applied paths and rerun against the latest text.

Read the JSON result. After a successful enable, prepare the local map once. Use the Claude command prefix in the core guide when its launcher is configured:

```bash
python3 -B <installed-skill-dir>/scripts/code_map.py --repo <project-root> --max-chars 500
```

Limit repository writes to the managed guidance files. Enable the current chat preference and report saved guidance and map availability separately. If map access is unavailable, report it and finish setup. Repository assessment and cleanup require an explicit `compound tidy` request.

The plugin must be installed and enabled at user scope in each app for global use. Setup does not install plugins or verify native runtime loading. New chats load defaults under normal host settings; project guidance and explicit user choices take priority. Saved Codex and Claude rules are machine-local; Cursor follows the plugin installation scope. These are model instructions, not guaranteed enforcement or background refactoring.

## Refresh saved guidance

Codex and Claude Code refresh their existing marked global blocks on session startup after an update. Codex requires the user's approval for the startup hook. A fresh chat after the refresh reads the updated rule. Use the explicit global refresh when the user needs the change immediately or has disabled hooks.

For an explicit `compound refresh`, resolve the project root and update its existing managed sections.

```bash
python3 <installed-skill-dir>/scripts/project_setup.py refresh --project-root <project-root>
```

For `compound refresh global`, use `refresh --global` and preserve any requested host selection. Refresh updates only existing marked blocks. Skip map startup, assessment and permission setup. Report changed paths, status, and warnings. Open a fresh chat to load the refreshed instructions. Use `setup-global` from Claude Code once to migrate old version-specific map permissions.

## Inspect or remove defaults

For `status` or `disable`, replace `enable` in the corresponding command; preserve `--global` when requested and any host selection. Status is read-only. For project status, also run `onboarding.py status --repo <project-root>` from the installed scripts directory to report the last recorded assessment; global status checks saved routing for the same installed apps as global setup and directs users with outdated rules to refresh. Use `--host all` to inspect every supported host. Inspect native cache-path entries and Claude Code permission rules only when the user also asks about map access. Disable removes only the helper's managed sections in that scope, deletes files left empty, and ends the current chat preference. Global disable leaves independent project defaults intact; also remove the Claude Code permission rules that global setup added. To stop the Cursor default, change its rule to Manual or disable it in Customize; report that host-managed step separately. Report the actual helper result; existing chats may need a new session to rebuild their instruction context.

For a Claude Code map permission check, run this from Claude Code's installed copy:

```bash
python3 -B <installed-skill-dir>/scripts/project_setup.py status --global --host claude --check-claude-permissions
```

Report `hosts.claude.permission_check` separately from saved routing. It checks the stable launcher and expected entries in user `settings.json`. Effective access also depends on Claude Code's other permission settings. If entries are missing, run `setup-global` in Claude Code when the user asks to repair them. Unavailable settings leave routing status intact.

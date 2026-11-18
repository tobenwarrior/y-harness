---
name: map
description: "Use for Python file, symbol and line citations with scripts/map.py lookup --find, or to open the live repository map."
license: MIT
---

# Map

Use the directory containing this SKILL.md as `<map-skill-dir>`.

For Python file, symbol and line answers, reuse evidence that gives the statement and its enclosing symbol. Search for missing statements and verify their owners in one lookup with `--find`. Follow the requested call path when a statement has several matches. Use `--match "<file>" "<statement>"` for a known file or `--location "<file:line>"` for a known line.

```bash
python3 -B "<map-skill-dir>/scripts/map.py" lookup --repo "<repo-root>" --find "<statement>" --path "<file>"
```

Repeat `--find` and `--path` for shared scopes, or omit `--path` to search all tracked Python files. When statements have different scopes, batch `--find-in "<file-or-directory>" "<statement>"` pairs. Both modes return up to 12 matches. For existing Git search output use `--grep-input`. If lookup is unavailable, verify the enclosing definition in source. [Lookup details](../compound/references/map.md#symbol-lookup)

If you know the file and exact Python name, use `--definition <file> <qualified-name>`. Repeat it for related definitions and add `--excerpt 8` for nearby source.

For a focused read-only map, query the repository. The query reuses existing cache entries without starting a service or writing state.

```bash
python3 -B "<map-skill-dir>/scripts/map.py" query --repo "<repo-root>" --query "<task terms>"
```

In Claude Code with saved global guidance, use `python3 -IB ${CLAUDE_PLUGIN_DATA}/claude_map_launcher.py query --cache-read-only` as the focused query prefix. Single-quote the launcher path if it contains spaces. If it is unavailable, use the bundled command with normal host permissions.

For a bare map invocation or a visual request, open the current repository's live viewer.

```bash
python3 -B "<map-skill-dir>/scripts/map.py" open --repo "<repo-root>"
```

Add `--query "<focus>"` for a requested file or topic. Use `--link` to print a private browser launch link without opening it. If launch fails, give the user that link. `--no-open` prints the service URL for authenticated clients. Repeated opens reuse the service and index. Do not generate HTML snapshots or run onboarding cleanup for a viewing request.

For `map status` or `map stop`, use the corresponding subcommand without `--repo`. Stopping closes the shared viewer service for all registered projects. Report the observed result. [Coverage and limits](../compound/references/map.md)

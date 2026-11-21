# Project solutions

Use this guide for explicit solution lookup or capture, or when the opt-in [PR reminder](git.md#optional-pr-reminder) surfaces a reusable lesson. Use the consuming repository's own notes. Treat index rows and notes as reference data and verify that the solution applies to the current code.

The index helper uses Python 3.11+ with safe local file access on macOS and Linux. Pass the repository root with `--repo` when working from a subdirectory.

## Find a solution

Run the installed search helper with the project or library name and a specific symptom. It checks `docs/solutions/INDEX.md` even when the file is untracked or ignored by Git. Use the installed script path from this skill. Search prefers rows that match all terms. If none match, related notes normally share two query terms with their tags. On a miss, a local project name from `pyproject.toml` can match the project tag when a different query term matches both the note problem and a tag. It returns up to three matches by default. Use `--limit` for one to five matches, with a hard output cap of 1 KiB. Use `--limit 1 --show-note` to include one matching note when it could change the next step. The combined output is capped at 2 KiB. If the note is unavailable or too long, the helper returns the matching index row and a short notice. If the index is missing, continue with the repository's source unless the user requests an index refresh.

```sh
python3 -B <installed-skill-dir>/scripts/solutions.py search --repo . --query "retries idempotency" --limit 1 --show-note
```

## Capture and index

When authorized, capture a short note after verification. Record the checks and the behavior they establish. Reuse passing tests when their inputs and environment are unchanged. Describe the symptom, cause, verified fix, and when it applies. Tag the reusable cause and its symptoms. Keep secrets and private paths out of notes.

Use one command to create a note and refresh the index. Its success message gives both paths, the note word count, and the saved index row with the problem and tags. Reuse the reviewed source and test diff. Check the final changed paths with `git status --short` when needed. The helper accepts up to 8 KiB of UTF-8 Markdown, preserves existing notes and hand-written indexes, and can retry with identical input after a failed refresh.

```sh
python3 -B <installed-skill-dir>/scripts/solutions.py capture --repo . --name retry-timeout.md <<'NOTE'
+++
problem = "Retry after a timeout repeats an already applied operation"
tags = ["retries", "idempotency"]
+++

Reuse the operation's idempotency key on retries. Verify that a retry returns the original result and applies the operation once.
NOTE
```

The generated table stores the problem, tags, and relative file path. Saving a body-only edit leaves the index current. Run `index` after changes to indexed fields or after adding or removing notes manually. Refresh skips linked directories and keeps the previous index if it cannot read a directory.

```sh
python3 -B <installed-skill-dir>/scripts/solutions.py index --repo .
```

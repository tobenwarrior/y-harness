# AGENTS.md — Archived Agent Notes

Archived Agent Notes under the kind directories are frozen historical snapshots, not current authority. The archive is English-only after the one-time translation-artifact retirement recorded in `manifest.json`. Never edit, reformat, translate, repair, delete, or move a sealed artifact; use an active Agent Note or current documentation for new decisions and facts.

Before that migration, an archival change could only relocate a complete language triplet, insert the identical `Archived: YYYY-MM-DD` line below both `Status: implemented` lines, re-record the sidecar, and repair or delete inbound links. New archive entries now remain English-only and are sealed as one file. Do not inspect, verify, or repair links out of archived notes.

Run the [`dsh-archive-agent-notes`](../../skills/dsh-archive-agent-notes/SKILL.md) workflow and append new artifact hashes with `pnpm run verify-archived-agent-notes --write`. The normal verifier rejects changed or missing sealed artifacts, unexpected translation artifacts after migration, unknown kind folders, and invalid archive metadata. `manifest.json` retains the original hashes for the retired translation artifacts as provenance; those seals are immutable.

The authorized Figma-link removal from `feature/2026-08-10-durable-workflow-runs-in-chat` has exact old-to-new seal exceptions in `scripts/archived-agent-notes.ts` for the pre-migration English, translated, and pairing artifacts. Only the retained English artifact remains in the archive; the other two hashes are provenance for the one-time retirement. These exceptions permit no other content change, reversal, or deletion.

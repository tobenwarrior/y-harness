# Managed Markdown skill load

English | [中文](README.zh.md)

This authored, keyless recorded session starts the shipped headless profile, adopts an oversized directory skill through the public Skill Library service, applies its reviewed split, and loads the selected generated entry through the ordinary `skill` tool. It then reads only the linked Setup topic with the ordinary `read` tool. The committed session checks the exact model-visible entry and selected topic; `workspace.expected/world.json` independently retains the exact bytes and hashes of all eight source fragments, topics, entry receipt and manifest files. This scenario materializes that fixed record in an owned temporary tree for the unchanged complete-world comparator; missing, extra or changed runtime files still fail. JSON escapes preserve generated blank lines without relaxing the repository whitespace check. The fixture plugin asserts that retained fragments reproduce every original byte, the root-only requests omit all source details, the final request contains every selected topic line, and the unselected Review details remain absent throughout.

Replay uses the repository snapshot runner with `-t managed-markdown-skill-load`. Source mode requires the Markdown split wiring in Skill Library; artifact mode additionally requires the normal repository build. No live model is used by the authored replay.

---
name: map
description: "Open the live local code map when the user asks to view a repository."
license: MIT
---

# Map

Resolve `<map-skill-dir>` to the directory containing this file. Open the current repository's live viewer:

```bash
python3 -B <map-skill-dir>/../compound/scripts/map_server.py open --repo <repo-root>
```

Add `--query "<focus>"` for a requested file or topic. Use `--no-open` when opening is unwanted or unavailable; return the actual localhost URL. Repeated opens reuse the service and index. Do not generate HTML snapshots or run onboarding cleanup for a viewing request.

For `map status` or `map stop`, run the helper's corresponding subcommand without `--repo`. Stopping closes the shared viewer service for all registered projects. Report the observed result. Details and coverage limits: [code maps](../compound/references/map.md).

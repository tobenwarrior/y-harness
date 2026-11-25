---
kind: upgrade-guide
description: "Y Harness removes automatic reporting and keeps feedback in the local Session."
---

# Private Session reporting

## Change

DeepSeek requests omit extra Session logs, the installed plugin inventory, and persistent Harness identifiers. The Session upload switch is removed. Shipped profiles also stop exporting feedback transcripts and Desktop analytics. Existing Session records and feedback stay available locally.

## Migration

1. Update and restart Y Harness. **Settings → General** no longer shows **Upload Session Log when using the official model API**.
2. Remove unused telemetry collector environment settings and the legacy Session-log or plugin-inventory overrides from your profile if you set them. The retired fields stay excluded even when old overrides are present.
3. Use the [manual Session export](../../../../packages/session-query/session-log-export/README.md) when you need a local copy of a conversation.

---
kind: upgrade-guide
description: "Browser credential onboarding no longer opens automatically by default."
---

# Optional model credential prompt

## Change

The `ui-settings-models` option `credentialOnboarding` now defaults to `false` instead of `true`. Browser users can configure providers in Settings → Models without an automatic DeepSeek API-key prompt. Desktop opens the workspace without requiring a DeepSeek account or API key.

## Migration

1. If a browser deployment still needs the automatic DeepSeek API-key prompt, set the existing `ui-settings-models` entry in its profile's `cordis.patch.yml`:

   ```yaml
   - id: ui-settings-models
     config:
       credentialOnboarding: true
   ```

2. Restart the profile and confirm the prompt appears when no usable provider is configured. Desktop continues to use Models settings for explicit sign-in and credential setup.

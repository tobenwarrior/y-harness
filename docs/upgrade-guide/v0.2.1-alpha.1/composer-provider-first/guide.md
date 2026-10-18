---
kind: upgrade-guide
description: The composer model menu now requires a provider choice before browsing another provider's models.
---

# Choose the provider before its model

## Change

The composer replaces its informational Provider row and grouped Model list with an interactive Provider row followed by a Model list for that route. An unset selection opens the provider list first. Model search appears only when the selected provider has more than four models. The `/model` command retains its searchable catalog grouped by provider.

Provider browsing remains temporary until a model is explicitly accepted. Closing the menu restores the saved route. Compatible explicitly selected effort and speed values carry to the accepted model; unsupported values use the target model's defaults. Existing saved provider/model selections continue to load.

## Migration

1. Open the composer's model control, choose Provider, then choose the route you want. The menu opens only that provider's models.
2. Choose a model to save the complete provider/model selection. Check the displayed effort and speed for the accepted model. Escape leaves the model list; a second Escape closes without accepting a draft.
3. Use `/model` when you want to search across every provider. Confirm the composer shows the accepted model and its Provider row identifies the intended route. No profile-file or credential migration is required.

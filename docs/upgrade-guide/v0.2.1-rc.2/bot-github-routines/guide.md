---
kind: upgrade-guide
description: "GitHub-triggered routines add a selector and signed delivery fields to the Bot store."
---

# GitHub-triggered Bot routines

## Change

Bot records can store a GitHub trigger, an activation time, and retained GitHub delivery references. The updated Host reads previous message routine records. It writes the new fields when a GitHub routine is configured or a matching event arrives.

## Migration

1. Stop the Hosts sharing the Bot store before updating, then start the updated Hosts.
2. Keep a backup of the Bot store and matching `agent-bots/profile-revisions-v4` records if you might return to an older version.
3. Enable a signed GitHub route using the [GitHub guide](../../../user/guide/github-review.md#run-a-github-routine-in-an-existing-bot).
4. Restore the matched backup before returning to a version that predates GitHub routines.

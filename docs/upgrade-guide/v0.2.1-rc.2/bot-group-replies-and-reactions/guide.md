---
kind: upgrade-guide
description: "Hosts need the updated group message reader after a reply or reaction is stored."
---

# Group replies and reactions extend saved messages

## Change

Local and shared group records can carry a parent message ID and emoji reactions. The updated Host reads existing group records directly. Older Hosts reject records containing the new fields. Browser retry storage uses a separate namespace for shared group replies and retains pending messages in earlier namespaces.

## Migration

1. Upgrade every Host that shares the same Bot storage or shared authority before sending a group reply or adding a reaction. Reload open Y Harness browser tabs.
2. Open an existing group and confirm its message history appears. Reply to a message, add a reaction, and reload the group to confirm both appear.

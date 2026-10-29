---
description: "The agents group map: durable user-owned Bot roster services and Host-side avatar generation for the Bot workspace."
kind: "package-group"
---

# agents/ — user-owned agent capabilities

## Summary

The agents group owns capabilities that present a durable roster of user-owned Bots and the Host services that support that roster. A Bot has one stable identity and one ordinary Session; the Client renders the roster separately from the normal workspace conversation list. The [agents subsystem reference](../../docs/subsystems/agents.md) contains the generated Host service and event API.

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`bots/`](bots/README.md) | Durable Bot roster with one persistent Session per Bot | `ctx.bots` |
| [`avatar-generation/`](avatar-generation/README.md) | Host-side OpenAI avatar generation backed by durable attachments | `ctx.avatarGeneration` |

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>

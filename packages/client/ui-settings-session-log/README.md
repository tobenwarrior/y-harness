---
description: "Control Session-log upload with DeepSeek API requests from General settings."
kind: "package-reference"
---

# @yharness/client-ui-settings-session-log

## Summary

Compatibility settings companion for the former Session-log contribution. Shipped Web and Desktop profiles hide the upload switch. See the [privacy migration guide](../../../docs/upgrade-guide/v0.2.1-rc.2/private-session-reporting/guide.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The compatibility companion remains available to custom compositions. Its switch edits the Host plugin's `enabled` field through the shared configuration form. A save failure keeps the accepted value and shows a toast that survives closing Settings. See [Session-log upload](../../session/session-log-deepseek/README.md#configuration) for request timing, resumed uploads, and the separate OpenTelemetry setting.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The companion contributes a `settings.general.item` row while `session-log-deepseek` is served and a `shell.overlay` toast for mutation outcomes. The shared form owns persistence and reconnect synchronization; the companion owns only pending-write state and localized notices.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Settings forms](../ui-settings/README.md) — accepted Host values and ordered writes.
- [Session-log upload](../../session/session-log-deepseek/README.md) — request contribution and acceptance tracking.
- [Web Client](../../../docs/subsystems/web-client.md) — plugin composition and settings placement.

<a id="model-experience"></a>
## Model Experience

None, as this browser preference contributes no model-visible content.

#### KV Cache effect

None; the setting controls request metadata outside model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The row is unavailable when the Host does not expose the `session-log-deepseek` namespace.

<a id="dev-note"></a>
### Dev Note

None.

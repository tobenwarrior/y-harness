---
description: "Generate validated OpenAI avatar previews for the Bot workspace and persist them only after the owner chooses to use one."
kind: "package-reference"
---

# @deepseek-ai/dsh-avatar-generation

## Summary

Generate a centered PNG avatar preview from a short description when an OpenAI credential is available. The Host validates provider bytes before returning them to the Client, then stores an image attachment only after the owner chooses Use this avatar. Use this package with the Bot roster and attachment service; it does not add model-visible prompt content or Session events.

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

Mount the Host service when the Bot workspace should offer generated avatar previews without storing abandoned previews.

### When to choose it

Choose this package when the deployment already exposes OpenAI credentials and durable image attachments. Keep the semantic Bot identity marks as the fallback when the provider or attachment store is unavailable.

### Minimal configuration

The package is mounted by the Host composition and reads the existing credential and attachment services:

```yaml
- name: '@deepseek-ai/dsh-avatar-generation'
```

| Field | Default | Meaning |
|---|---|---|
| `credentialRef` | discovered from the OpenAI settings route | Optional explicit credential-reference name. |
| `baseURL` | `https://api.openai.com/v1` | OpenAI-compatible Images API base URL. |
| `model` | `gpt-image-2.5-flare` | Image model sent to the provider. |
| `timeoutMs` | `120000` | Provider request timeout in milliseconds. |
| `maxDescriptionChars` | `800` | Maximum description length accepted from the Client. |
| `maxImageBytes` | `8388608` | Maximum decoded avatar size. |
| `maxResponseBytes` | `16777216` | Maximum encoded provider response size read by the Host. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host discovers credentials per operation, sends a bounded transparent-background image request, and validates the returned PNG without persisting it. The Client keeps those bytes for its preview; the explicit commit operation admits the canonical bytes through the attachment store and returns an image reference for Bot assignment. Provider response streams are bounded and cancelled on failure.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Credential discovery, provider request, bounded response handling, preview validation, and explicit commit. |
| [`src/types.ts`](src/types.ts) | Browser-safe request, preview, status, commit, and Remote error types. |
| [`tests/service.spec.ts`](tests/service.spec.ts) | Credential, provider, stream cleanup, preview, commit, and size-limit coverage. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agents package map](../README.md) — adjacent Host agent capabilities.
- [Bot roster](../bots/README.md) — assigns committed image references to durable Bots.
- [Attachment service](../../attachment/attachment/README.md) — validates and stores image bytes.
- [Client Bot workspace](../../client/ui-bots/README.md) — previews and commits generated avatars.

<a id="model-experience"></a>
## Model Experience

### Avatar generation provider request

#### What the model sees

The package sends the owner description to the provider's `images/generations` route; it does not add that description, the provider response, or the attachment reference to an agent Session.

#### Token effect

No direct token effect. Avatar generation is an owner-facing provider request separate from the agent model request.

#### KV Cache effect

No effect. The provider request does not alter model request prefixes or invalidate a Session's reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **OpenAI Images API dependency** — generated previews require a configured OpenAI-compatible credential and endpoint; the Bot's semantic identity remains the fallback.
- **Commit and Bot assignment are separate operations** — a storage success followed by a Bot update failure can leave a content-addressed image unreachable until a future retention policy collects it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

---
description: "Compound code-map panel and sidebar entry for the Y Harness Web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compound-map

## Summary

A **Code map** entry sits directly below Skills in the sidebar and opens the Compound code-map viewer: the repository graph with folder clustering, search, import tracing, impact views, and read-only source previews. The viewer is the vendored application itself, framed from this origin and served by `@deepseek-ai/dsh-skill-compound`, which also owns the loopback service behind it. Nothing leaves the machine: the graph, the index cache, and the source previews stay local.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount beside `@deepseek-ai/dsh-skill-compound`, which serves the viewer document, its assets, and the proxied service calls the frame uses.

```yaml
- name: '@deepseek-ai/dsh-client-ui-compound-map'
```

| Surface | Registration | Effect |
|---|---|---|
| Sidebar | `sidebar.panellist`, id `code-map`, order 11 | Navigation entry below Skills (order 10). |
| Main | `main`, key `code-map` | The panel: a toolbar, the viewer frame, and the local-processing note. |

## Understand the implementation

| File | Responsibility |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Panel and sidebar registrations, dictionary, panel id. |
| [`src/client/MapPanel.tsx`](src/client/MapPanel.tsx) | Toolbar, viewer frame, and the reload generation. |
| [`src/client/MapPanelIcon.tsx`](src/client/MapPanelIcon.tsx) | The dependency-graph glyph the sidebar renders. |

The panel frames `/api/skill-compound.map/viewer` rather than reimplementing the graph. The vendored service refuses framing and foreign origins, so the Host serves the same assets from this origin; the frame therefore needs no sandbox attribute, and its own `connect-src 'self'` calls resolve to the Host's proxy.

## Further Exploration

- [`packages/skill/skill-compound`](../../skill/skill-compound/README.md) — the viewer assets, the loopback bridge, and the service lifecycle.
- [compound-skills](https://github.com/tobenwarrior/compound-skills) — upstream viewer and its documentation.

## Model Experience

None. The panel is browser chrome: it adds no prompt section, no tool, and no session event. When the model wants the map, it uses the `map` skill, which drives the same service through the command line.

## Known Limitations and Deferred Work

- The frame loads the viewer for the workspace the Host mapped at startup; choosing another registered project happens inside the viewer's own project picker.
- A deployment without Python 3.11+ cannot start the service, and the viewer's own error overlay reports it.
- The panel holds no state beyond the reload generation: switching panels and returning reloads the frame.

## Dev Note

The viewer is a vendored asset served through the Host proxy; the package itself adds no build step beyond the shared client bundle.

---
description: "Appearance settings for the dsh web client: Default or Terminal style, Light/Dark/System color mode, conversation font size, and --yh-* token stylesheets."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-theme

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-theme` lets Web GUI users choose Default or Terminal style, Light/Dark/System color mode, and conversation text from 10 to 22 px in Settings → Appearance. These choices persist across restarts on a loopback browser. Terminal applies compact corners and monospace labels across the app while preserving readable conversation text. Style and color mode remain independent, so either style supports both palettes and the System preference. Default preserves the existing appearance when no style override is saved.

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

Users choose Style, Color mode, and Font size in Settings → Appearance. Feature plugins consume the current snapshot through `ctx.theme` and read the `--yh-*` tokens in CSS; they do not manage theme state themselves.

### Style, color mode, and font size

The Appearance tab offers Default and Terminal preview cards, Light/Dark/System color-mode choices, and a font-size stepper. The `ui-theme.style` setting stores `default` or `terminal` and defaults to `default`. The independent color preference (`ui-theme.preference`) defaults to `system`, and content size (`ui-theme.fontSize`) defaults to 14 px. Selecting a style preserves the color preference and content font size. The local provider persists the namespace in `$DSH_HOME/cordis.patch.yml` by default.

Terminal applies its treatment to the sidebar and navigation, conversation and dock tabs, run summaries, tool rows, composer, menus, settings, plugin and automation pages, and file/browser toolbars. Flat panels, visible dividers and outlined controls share the current light or dark palette. Functional labels, commands, paths and status metadata use the existing monospace font stack; assistant prose, user messages, headings and composer text keep the system font stack. The composer prompt is decorative and does not change editing or submission. The style uses existing theme accents.

The stepper accepts integer values from 10 to 22 px. It changes conversation headings and base text by the same increment, including the user bubble and composer draft; flow-row titles, summaries, and tables follow one step under the body size, while small text and code keep fixed sizes. Each accepted change writes through the Host settings API. Rapid changes serialize in gesture order with namespace revisions, and a rejected latest write reloads the durable values. Non-loopback pages keep all three choices process-local.

### Registering a theme

A composition can register a third-party theme id with alias-token overrides through `ctx.theme`; the override layer folds into the active snapshot's tokens in registration order. Removing one never overwrites the last durable built-in preference. Third-party theme ids remain an in-process extension and do not cross the built-in settings schema.

### Pre-plugin appearance

When the host composition includes an HTTP server, the host half embeds the registered `ui-theme` settings, or schema defaults, into each index response. Head CSS selects the document canvas color scheme before any script runs, including a `prefers-color-scheme` query for the `system` preference. A body script then sets `body[data-ds-dark-theme]`, `body[data-yh-style]`, and `--dsh-content-font-size` before the loading page and application scripts. The first paint uses the selected palette and text size, and the selected style applies when the plugin styles load.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Shared menus use `--yh-menu-surface-fill` and blur through `MenuSurface`; platform code must preserve those token values. Sticky menu group headings can use `--yh-alias-menu-group-header-fill`, a 94%-opaque light or dark fill, independently of the menu material. Other overlays consume `--yh-specific-menu`, which keeps a nearly opaque macOS fill without a menu backing. The enforced source rules are defined in the [styling reference](../../../docs/web-styling.md#component-rules). Modal masks retain their dark translucent fill without background blur.

<details>
<summary>Implementation internals — click to expand</summary>

The service owns style, theme, and font-size state and publishes snapshots. The ui-layout presenter applies those snapshots, and the token sheets own the color and conversation text scales.

### Stylesheets

`base.css` owns the shared radius scale and settings-card material aliases. The material aliases resolve on `body`, alongside the active palette. Follow [Web styling](../../../docs/web-styling.md#corner-radii-and-settings-cards) when choosing component radii.

[`src/client/styles.ts`](src/client/styles.ts) imports the shared sheets in order, ending with [`terminal.css`](src/styles/terminal.css). Terminal rules apply only under `body[data-yh-style='terminal']`; Default keeps the existing sheets' presentation. The client bundle compiles and injects these plugin-owned global styles, so unload and HMR remove them with ui-theme. `scrollbar.css` consumes the `--yh-alias-scrollbar-*` tokens and must follow `design-platform.css`, which declares them. Status marks use their own semantic state tokens. `--yh-alias-bg-document-selection` uses blue-500 at 40% opacity in both themes for selections over original document colors. `design-platform.css` also owns the code-diff fill aliases and their static alpha palette entries, plus the `--yh-alias-file-diff-*` code, gutter, and marker palette for file comparisons; `shiki.css` owns syntax colors.

[`focus.css`](src/styles/focus.css) provides a `:focus-visible` fallback that names the ring colour through `var(--yh-focus-ring-color, var(--yh-alias-state-business-primary))` and the standard width through `--yh-focus-ring-width`, never the outline style — so a control that disables its outline stays paintless, and one that declares no ring keeps the standard geometry instead of Chromium's `auto 1px`. The theme resolves this blue to `#4176E6` in light mode and `#599DE7` in dark mode. Component outlines and focus-ring shadows use the same colour expression, including rings on descendants and pseudo-elements. `--yh-focus-ring-width` (2px) is the standard width; dense tables and toolbars may keep 1px, and offsets remain component-owned.

In pointer modality, `html[data-input-modality='pointer'] body :focus-visible:not(:read-write)` makes the ring colour transparent. Descendants and pseudo-elements inherit that value; the rule does not clear `box-shadow`, so elevation and selected-state borders remain independent of ring visibility. Editable text controls matching `:read-write` retain their own focus feedback on click. [Input modality](../ui-primitives/README.md#input-modality) determines when keyboard focus styling resumes; it does not move DOM focus.

Menu icons use `--yh-alias-menu-icon`: neutral-bluish 800 in light mode and `label-primary-dimmed` in dark mode.

`base.css` suppresses only the outline of focused elements marked `data-dsh-automatic-focus` by the [primitive focus helper](../ui-primitives/README.md); ordinary keyboard focus styling, borders, shadows, and error states remain intact.

System toasts use `--yh-alias-toast-bg` and `--yh-alias-toast-label` for a shared background and text color across callers. Document previews pair `--yh-alias-bg-document-preview` with `--yh-alias-label-document-preview` so the backdrop and status text follow the same theme. Tooltip keycaps use `--yh-alias-tooltip-key-bg`, a lighter fill derived from the tooltip background in each palette. Switch thumbs read `--yh-alias-switch-thumb`: white in light mode and neutral-bluish 400 in dark mode, so an off switch stays lighter than its track without the glare of pure white.

`--yh-alias-label-shimmer` supplies an overlay for the shared text shimmer: black at 30% alpha in the light palette and white at 45% alpha in the dark palette. `--yh-alias-label-deep-diving` and `--yh-alias-label-deep-diving-shimmer` supply the blue activity label and sweep; the dark palette uses a lighter, less saturated label with a brighter blue sweep.

The `--yh-alias-turn-trigger-*` tokens provide separate resting and hover backgrounds for Turn-trigger notices in each palette. Dark notices use brighter interactive layers so the resting card remains distinct from the transcript background.

`brand-font.css` exports the local Montserrat Light, Regular and Medium faces (normal style, weights 300, 400 and 500), with `montserrat-light.woff2`, `montserrat-regular.woff2`, `montserrat-medium.woff2` and its SIL Open Font License in `lib/styles/`. Desktop bundles the same stylesheet, font and license for offline welcome brand text; ordinary UI keeps its system font stack.

`corner-shape.css` smooths every rounded corner: inside `@supports (corner-shape: superellipse(1.5))` it defines `--yh-corner-shape` and applies it to all elements and their `::before`/`::after` through the universal selector, so engines without `corner-shape` keep circular corners. Full-round shapes — `border-radius: 50%` circles and pill radii — pair `corner-shape: round` with their radius in the owning component sheet because a superellipse deforms them; the corner-shape stylesheet spec enforces that pairing across every package stylesheet.

`gradient-shadow-text.css` derives `--dsh-content-font-delta` from `--dsh-content-font-size` and shifts the Markdown heading and base-text ladder by that increment. It also derives the secondary tier `--dsh-content-font-size-secondary` (setting −1 at ≤14, setting −2 above; 13px at the default) with its own `--dsh-content-font-delta-secondary` for the table variants and the flow rows one step under the body. Dense small and code variants stay fixed. Outside the ladder, the user bubble and composer draft read the body pair directly, and flow-row titles and summaries read the secondary pair. The sheet also owns the shadow scale (`--yh-shadow-lv*`), the translucent-menu `--yh-menu-backdrop-filter`, and the elevation tokens: `--yh-elevation-stroke` draws a 0.5px hairline through the rebindable `--yh-elevation-stroke-color`, and `--yh-elevation-panel`/`--yh-elevation-prominent`/`--yh-elevation-soft` (the composer's larger-blur, lower-alpha tier) layer two faint soft shadows over that stroke, so elevated surfaces set `border: 0` and carry no layout-consuming outline; the derived tokens are re-declared per element so a surface's stroke-color rebind takes effect. An elevated surface that paints `--yh-specific-menu` also applies `backdrop-filter: var(--yh-menu-backdrop-filter)` ([styling reference](../../../docs/web-styling.md#component-rules)). Dark menus use a 45%-opaque gray fill and the `border-l3` stroke; light menus retain their `border-l1` stroke.

`brand-font.css` references the bundled `montserrat-regular.woff2` / `montserrat-light.woff2` / `montserrat-medium.woff2`, Montserrat Regular, Light, and Medium under the SIL Open Font License shipped with the stylesheet and WOFF2 under `lib/styles/`. `--yh-font-family-brand` selects this face for brand text; ordinary UI keeps the system font stack. The source is Google Fonts' Montserrat distribution. The Web entry imports the package's `./brand-font.css` export so Vite emits and resolves the font asset; the Web build also includes its license. The Web application, including Desktop onboarding, loads the font offline. The native credential welcome retains its system font.

`onboarding.css` owns the onboarding accent, named violet/blue/cyan gradients, and light/dark card, checkbox, and secondary-action colors. The feature owns card shadow offsets and blur sizes.

### Scrollbar rebinding

`scrollbar.css` binds `--dsh-scrollbar-thumb` and `--dsh-scrollbar-thumb-hover` on `body` to the l1 base-surface tokens; an elevated surface (menu, popover, dialog) rebinds them to the l2 tokens on its own container, and the pair's other legal target is `transparent` (ui-sidebar rebinds its column that way while the pointer is elsewhere). WebKit-based browsers use a 5px default `--dsh-scrollbar-width` and also read `--dsh-scrollbar-thumb-border` and `--dsh-scrollbar-track-margin`; a scroll surface may rebind them to keep a wide draggable rail around a narrower visible thumb or to inset the track from rounded ends. The two rendering paths are mutually exclusive by construction: Firefox takes the standard thin scrollbar inside `@supports not selector(::-webkit-scrollbar)`, and WebKit-based engines take the pseudo-elements, so geometry and hover customization apply only through the pseudo-element path.

### Preference persistence

The service reads boot style and font size before loading the `ui-theme` namespace. It writes each accepted style, theme, or font-size change through the Host settings API. Pushed settings changes and reconnects refetch the namespace. Non-loopback pages do not create that Host-backed scope. The persistence boundary is owned by the [Host-backed preferences reference](../ui-settings/README.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the layout presenter, the token consumers, and the styling rules.

- [ui-layout](../ui-layout/README.md) — the presenter that applies the resolved theme snapshot.
- [ui-sidebar](../ui-sidebar/README.md) — a consumer of the scrollbar rebinding contract.
- [ui-conversation](../ui-conversation/README.md) — a consumer of `--dsh-scrollbar-width` for the composer seat.
- [Web styling](../../../docs/web-styling.md) — the authoritative styling rules for web client components.
- [historical Host-backed preferences](../../../.agents/notes/archived/bug-fix/2026-08-06-host-backed-web-preferences.md) — the persistence boundary decision.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the theme extension surface and the color authority; they are current package constraints.

- **Third-party themes are an extension point, not a product** — registering one means overriding same-named alias variables; no validation exists that an override set is complete.
- **The token sheets are the sole color authority** — values absent from the design system are deliberately not appended; the nearest semantic token wins, and design-owner-approved additions enter as a static step plus a semantic alias in the same change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

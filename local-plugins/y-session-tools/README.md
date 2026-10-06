# y-session-tools (local plugin bundle)

English | [中文](README.zh.md)

A profile plugin for this fork's Web UI. It is **not** a workspace package: the `pnpm-workspace.yaml` globs do not cover `local-plugins/`, so nothing here is built, tested, or published with the repository. It is installed into the `desktop` profile by path.

## What it adds

Four rows in every session row's menu (`sidebar.workspaces.session.menu.item`), plus one confirmation dialog in `shell.overlay`:

| Row | Order | Effect |
|---|---|---|
| Copy session ID | 500 | Copies the raw session id. |
| Copy session reference | 510 | Copies the canonical `@[title](dsh-session:…)` mention, which pastes into another session's composer as model context. |
| Copy session path | 520 | Copies the session's stored artifact directory. |
| Delete session… | 900 | Permanently deletes the session's stored log and directory, behind a confirmation. |

The Host row also enables `@deepseek-ai/dsh-tool-session-query`, which gives the model `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, and `session_event_read` for reading other sessions' history.

The two search tools additionally need the SQLite index, which both shipped layers configure with `openAt: never` — the sidebar's own search matches titles and workspace names only. The bundle's patch therefore overrides `session-query-sqlite` to `openAt: first-search`, the base patch's documented opt-in: it keeps the ephemeral in-memory index and defers the `node:sqlite` import and handle to the first search. Without that override the two search tools are registered but refuse with *"session search is disabled in this deployment"*, while the three trace/read tools work regardless.

The fork's `packages/client/ui-workspace` opens this same menu on right-click, so every row above is reachable by right-clicking a session row.

## How it works

`index.js` registers one authenticated route on the shared API channel:

- `GET /api/y-session-tools.session?sessionId=&label=` returns `{ sessionId, path, mention }`.
- `POST /api/y-session-tools.session` with `{ sessionId }` deletes the session.

Deleting has no shipped Host entry point (`workspaceRegistry` owns archive and pin; `sessionPersistence` is append-only), so the route resolves the artifact directory itself, archives the session to hide it from every browsing surface, removes the directory, unarchives it so the archive set returns to its prior state, and then publishes `api-session/removed` for the session. The published removal is what drops the sidebar row: Workspace membership is durable and does not follow the artifacts, so hiding alone would leave the row behind after the archive set is restored. A live session is refused with `session/live`.

`client.js` is a dynamic browser bundle: it registers the menu rows and the dialog and imports only the module table's React, `react-dom`, and `client-store`.

## Verify

```sh
node local-plugins/y-session-tools/verify-host-route.mjs
```

Drives the registered fetch handler against a real temporary session tree and checks path discovery, the reference mention (compared with the shipped `formatSessionReferenceMention` once the checkout is built), the live-session refusal, the archive/delete/unarchive/removal ordering, and the 400/404 paths.

## Known limitations

- Deleting removes the session log and its directory. Attachment blobs it referenced, the search index's rows, and projection-cache entries are left for their own reconciliation.
- Deleting a **live** session is refused; stop it first.
- The `tool-session-query` dependency is pinned to the runtime's version. After a DSH upgrade, re-check that pin.

## Install / remove

```sh
# install (from a session in this profile)
#   plugin_manager install_bundle /abs/path/to/local-plugins/y-session-tools
# remove
#   plugin_manager remove_bundle @local/y-session-tools
```

Updating the Host half of an installed bundle needs an app restart to load a fresh JavaScript module generation; the browser half is served from the bundle directory.

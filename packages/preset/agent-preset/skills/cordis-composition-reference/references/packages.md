# Loadable Harness plugin packages

This file is GENERATED from workspace manifests (`scripts/gen-plugin-packages.ts`) and verified fresh by `pnpm run verify-plugin-packages` (part of `doc-sync`); do not edit it by hand.

Every package below exports a Cordis plugin that a bundle patch can name in a Loader row. `Config` marks packages whose row accepts a `config` mapping; query `Config.listConfigs` through `cordis_inspect_query` (filter by `name`, then query the `entry` id) for the mounted schema. Packages under `experimental` are pre-stable.

## acp

| Package | Config | Description |
|---|---|---|
| `@yharness/acp` | yes | Automation-only Agent Client Protocol server for driving Y Harness agents over JSON-RPC stdio |

## agents

| Package | Config | Description |
|---|---|---|
| `@yharness/avatar-generation` | yes | Y Harness Host-only OpenAI avatar generation using configured credentials and durable image attachments |
| `@yharness/bots` | no | Y Harness durable user-owned Bot roster with one persistent Session per Bot |

## api

| Package | Config | Description |
|---|---|---|
| `@yharness/api-account-controller` | no | Expose safe account operations over authenticated Remote |
| `@yharness/api-gateway` | yes | Typert Remote Host dispatcher and Client API endpoint |
| `@yharness/api-job-controller` | yes | Job Remote observation stream and the reference-counted client job-output service |
| `@yharness/api-remotes` | no | Remote BFF assembly for application-selected Host capabilities |
| `@yharness/api-session-controller` | yes | Session Remote commands, cold reads, and live control transport |
| `@yharness/api-settings-controller` | yes | Remote owner for the configuration surfaces over the settings-domain seams |
| `@yharness/api-terminal-controller` | yes | Session-owned interactive terminals with shell discovery, screen recovery and typed Remote control |
| `@yharness/api-workspace-controller` | yes | Workspace Remote commands and reconnect-safe state transport |
| `@yharness/api-workspace-files` | yes | Workspace file service and Client resource provider: bounded reads, directory listing, and live metadata over the workspaceFiles Remote namespace |

## attachment

| Package | Config | Description |
|---|---|---|
| `@yharness/attachment-local` | yes | Private content-addressed DSH_HOME attachment storage |

## boot

| Package | Config | Description |
|---|---|---|
| `@yharness/config-editor` | no | Persist plugin configuration through profile patches and Loader reconciliation |
| `@yharness/hmr` | yes | Coordinated module and profile configuration hot reload |
| `@yharness/plugin-manager` | yes | Current-profile plugin and bundle management shared by dsh CLI, Web and agent tools |

## browser-use

| Package | Config | Description |
|---|---|---|
| `@yharness/browser-use` | no | Exclusive named browser-use provider registration |

## bundle

| Package | Config | Description |
|---|---|---|
| `@yharness/acp-app` | no | The Y Harness ACP profile bundle: automation-only JSON-RPC stdio and process lifecycle over yharness-base |
| `@yharness/headless` | yes | The Y Harness one-shot bundle: a direct core Agent/Session runner over yharness-base with no Host, HTTP, or browser layer |
| `@yharness/sdk-app` | yes | The Y Harness SDK profile bundle: stdio JSON-RPC serving and process lifecycle over yharness-base |
| `@yharness/web-app` | yes | The Y Harness browser-surface bundle: the Web patch layer over the base bundle plus the runtime glue plugin (frontend dist serving, Web-surface prompt, shell runtime variables, URL line) |

## client

| Package | Config | Description |
|---|---|---|
| `@yharness/client-connection` | yes | Authenticated RPC transport and generation lifecycle |
| `@yharness/client-file-upload` | no | Agent-scoped browser file upload, streaming intake, and staged receipt service |
| `@yharness/client-hmr` | yes | Web client graph synchronization and rebuilt-bundle reload transport |
| `@yharness/client-locale` | no | Locale plugin: Host-backed preference, extensible language catalog, browser fallback, and typed built-in dictionaries |
| `@yharness/client-modules` | no | Client module system, dual-face: node half composes the __DSH_BOOT__ entry graph (incremental dsh.client scan, bundle route, index tap, webPlugins service); browser half is the lazy-CJS module table the vendored cordis Loader consumes as its internal seam |
| `@yharness/client-product-analytics` | yes | Desktop product event collection and authenticated Host reporting |
| `@yharness/client-resources` | no | Unified client resource model: protocol-registered providers turn URL addresses into live values, consumed through the useResource global standard hook |
| `@yharness/client-shortcuts` | yes | Application keyboard command registry and physical-key routing |
| `@yharness/client-ui-agent-preset` | no | Agent-preset surfaces: the default for later sessions, this session's seat, and the composition editor |
| `@yharness/client-ui-approval` | no | Approval composer takeover over the scoped Remote Event waterfall |
| `@yharness/client-ui-attachment` | no | Dynamic attachment presentation plugin for conversation input, message-image, and trajectory image slots |
| `@yharness/client-ui-bots` | no | Bot workspace panel and roster for the Y Harness Web client |
| `@yharness/client-ui-brand-official` | no | Official Y Harness brand occupants for the Web client's sidebar slots |
| `@yharness/client-ui-chat` | no | Chat Conversation target, node definitions, renderers, and details surface |
| `@yharness/client-ui-commands` | no | Client command surface: global directory cache, '/' source, three command UI kinds, popupSelect registry |
| `@yharness/client-ui-compound-map` | no | Compound code-map panel and sidebar entry for the Web client |
| `@yharness/client-ui-compound-update` | no | Compound skills update indicator and update-steps panel for the Web client |
| `@yharness/client-ui-conversation` | no | Target-neutral Conversation assembly, shell, composer, queue, and view navigation |
| `@yharness/client-ui-deepseek-model-label-1017` | no | Temporary 1017 release badge for official DeepSeek Flash model labels |
| `@yharness/client-ui-deliverables` | no | Changed-files card with per-file comparison tabs, delivery cards, and clickable final-response file references for Web |
| `@yharness/client-ui-directory-picker-browse` | no | In-app directory browsing surface: the workspace directory-flow owner rendering the host's listing and creation primitives |
| `@yharness/client-ui-directory-picker-native` | no | Native directory-picker surface: the renderless workspace directory-flow occupant driving the local Desktop or Host OS chooser |
| `@yharness/client-ui-goal` | no | Session goal surface: GoalBar docked above the composer, read from the goal session projection |
| `@yharness/client-ui-input-trigger` | no | Input trigger pipeline: '/' and '@' detection, candidate menu, pick routing to registered sources |
| `@yharness/client-ui-jobs` | no | Session-header background-job list with on-demand streaming record panels |
| `@yharness/client-ui-layout` | no | Shell plugin: three-column AppFrame with drag handles, ctx.layout viewing-state service (navigation + panels) |
| `@yharness/client-ui-message-feedback` | no | The Web feedback surface: per-message Like/Dislike in the assistant-message action strip and the feedback dialog behind both ratings and /feedback, backed by the messageFeedback and sessionFeedback Host Remotes |
| `@yharness/client-ui-model-selection` | no | Model selection over the shared model catalog, Session projection, and session.selectModel |
| `@yharness/client-ui-open-in-app` | no | Web "Open In..." controls: the Session-header split button opening the workspace directory in an installed application, and the document preview's default-application controls for one file |
| `@yharness/client-ui-permission-presets` | no | Permission surfaces: a new-session default in General settings and a current-session /permission popup over the permissions projection |
| `@yharness/client-ui-plan` | no | Plan mode controls, persistent transcript plan cards, and sidebar Markdown previews |
| `@yharness/client-ui-plugin-manager` | yes | Plugin management for the dsh web client: the sidebar Plugins panel installs, enables, disables, retries, and composes installed plugin packages |
| `@yharness/client-ui-reference` | no | Unified Web @file and @session reference source |
| `@yharness/client-ui-renderer` | no | Browser UI renderer: React slot bindings, ctx.uiRenderer, and the assembled application root |
| `@yharness/client-ui-schedule` | no | Host task management page and Session reminder catalog |
| `@yharness/client-ui-session` | no | Session Controller adapter for React and session-scoped slots |
| `@yharness/client-ui-settings` | no | Settings domain base plugin: shared configuration forms and the canonical settings slot-type contract |
| `@yharness/client-ui-settings-account` | yes | Manage DeepSeek login and open Platform billing pages |
| `@yharness/client-ui-settings-agent-loop` | no | Settings page of the agent loop on the dsh web client's Plugins page: the parallel tool-call cap of the agent-loop namespace |
| `@yharness/client-ui-settings-coding-sessions` | no | Source-labelled native coding session import and refresh Settings |
| `@yharness/client-ui-settings-general` | no | Settings ownerless-copy and product onboarding plugin: the General section, shell trigger/header chrome content, settings dictionaries, and the versioned welcome notice |
| `@yharness/client-ui-settings-models` | yes | Models settings and shared product-onboarding dialogs over existing settings and credential joins |
| `@yharness/client-ui-settings-plugin-inventory` | no | Read-only Cordis Loader inventory tab in Web Plugins settings |
| `@yharness/client-ui-settings-plugins` | no | Built-in plugins settings section for the dsh web client: the Settings navigation entry and the tab chrome feature-owned tabs register into |
| `@yharness/client-ui-settings-session-log` | no | General settings control for Session-log upload with DeepSeek API requests |
| `@yharness/client-ui-settings-shell` | no | Settings page of the shell executor on the dsh web client's Plugins page: the command timeout and the per-stream output cap of the shell namespace |
| `@yharness/client-ui-settings-subagent` | no | Settings page of Subagent delegation on the dsh web client's Plugins page: recursion depth, parallel capacity, and the models agents may choose for subagents |
| `@yharness/client-ui-settings-web-search` | no | Settings page of the DeepSeek web-search provider on the dsh web client's Plugins page: its API key, endpoint, and per-request search budget |
| `@yharness/client-ui-shortcuts` | no | Keyboard shortcut reference, recording, and local preference editing |
| `@yharness/client-ui-sidebar` | no | Sidebar plugin: session multi-level tree, search, grouping, state dots |
| `@yharness/client-ui-sidebar-browser` | no | Sandboxed Web browser tabs for the right Sidebar |
| `@yharness/client-ui-sidebar-documentpreview` | yes | Extensible Sidebar previews for Office documents, spreadsheets, Markdown, code, images, PDF, HTML, and plain text |
| `@yharness/client-ui-sidebar-files` | no | Workspace file tree tab type for the right Sidebar: lazy directory listing over the workspaceFiles Remote namespace, opening files into the Sidebar |
| `@yharness/client-ui-sidebar-right` | no | Right Sidebar: the docking surface's session-bound state, its panel and header expand control, and the navigation service over it |
| `@yharness/client-ui-sidebar-terminal` | no | Interactive shell tabs for the right Sidebar |
| `@yharness/client-ui-skill` | no | Web skill references and the dedicated skill tool row |
| `@yharness/client-ui-skill-library` | no | Scoped skill inventory, reversible maintenance, and explicit relationship graph for the Y Harness client |
| `@yharness/client-ui-subagent` | no | Subagent conversation catalog, continuation routing UI, and '@' reference source |
| `@yharness/client-ui-theme` | yes | Theme plugin: Host bootstrap for the pre-plugin palette; DOM-free ThemeRuntime for light/dark/system state; --yh-* token styles and Appearance settings row |
| `@yharness/client-ui-tool` | no | Client Tool call-tree renderer and keyed per-tool presentation slot |
| `@yharness/client-ui-trajectory` | no | Trajectory event ledger with an interactive timing overview: pure-consumer plugin registering into the conversation ViewMap (no service) |
| `@yharness/client-ui-user-questions` | no | Web ask_user_question composer takeover and plan-review presentation UI |
| `@yharness/client-ui-workflow-run` | no | Durable workflow-run Conversation Node and nested member disclosure for dsh web |
| `@yharness/client-ui-workspace` | no | Workspace picker plugin: one WorkspacePicker registered into the sidebar and empty-state workspace slots |

## compaction

| Package | Config | Description |
|---|---|---|
| `@yharness/command-compact` | no | Human-facing slash command for explicit session compaction |
| `@yharness/compaction-basic` | yes | Token-meter-driven compaction policy and LLM summarization backend for the Y Harness |
| `@yharness/compaction-image-offload` | no | Durable image offload for image-capable routes: replace over-budget request images with placeholders and retry |
| `@yharness/compaction-tool-result-pruner` | yes | Replay-safe model-free head/middle/tail pruning for tool-result surface nodes |

## computer-use

| Package | Config | Description |
|---|---|---|
| `@yharness/computer-use` | no | Exclusive named computer-use provider registration |

## context

| Package | Config | Description |
|---|---|---|
| `@yharness/agent-instructions` | yes | Workspace context loader for AGENTS.md/CLAUDE.md instruction files |
| `@yharness/file-reference-local` | yes | Local-filesystem ctx.fileReferences provider with bounded fuzzy indexes |
| `@yharness/session-reference` | yes | Cross-session snapshot references and durable untrusted model context (ctx.sessionReferenceResolver) |
| `@yharness/time-context` | yes | Durable per-step context with the current time and elapsed time |
| `@yharness/tmux-context` | yes | Opt-in durable per-step context with this agent's tmux pane and window location |

## core

| Package | Config | Description |
|---|---|---|
| `@yharness/agent` | no | Agent interface, registry, initiator scope, and event vocabulary for the Y Harness |
| `@yharness/agent-default-model` | yes | Default model selection shared by Agent entry points |
| `@yharness/agent-loop` | yes | The concrete agent loop plugin for the Y Harness |
| `@yharness/agent-tool-presentation` | yes | Agent-plane presentation selector: composes one agent's tools as PTC mode, native, or both |
| `@yharness/session` | no | Event-sourced session store for the Y Harness |
| `@yharness/system-prompt` | yes | System prompt assembly registry for the Y Harness |
| `@yharness/tools` | yes | Tool registry and execution pipeline for the Y Harness |

## credentials

| Package | Config | Description |
|---|---|---|
| `@yharness/authorization` | no | Authorization seam (ctx.authorization): plugin-owned flows that obtain a credential through a conversation with the human |
| `@yharness/credentials-local` | yes | File-backed credentials provider ($DSH_HOME/.env under the live process environment) for the Y Harness |
| `@yharness/deepseek-account-platform` | yes | Authorize DeepSeek accounts through browser PKCE |

## deliverables

| Package | Config | Description |
|---|---|---|
| `@yharness/tool-present` | yes | Explicit workspace file delivery declarations for the Y Harness |
| `@yharness/workspace-changes` | yes | Per-turn workspace file changes recorded from git working-tree snapshots and whole-file captures, with per-file comparisons, for the Y Harness |

## document

| Package | Config | Description |
|---|---|---|
| `@yharness/office-to-pdf` | yes | Shared Office-to-PDF conversion with bounded queues and caching |

## experimental

| Package | Config | Description |
|---|---|---|
| `@yharness/experimental-agent-team` | yes | Implicit-root Agent Teams roster, durable peer mailbox, and shared task DAG |
| `@yharness/experimental-api-speech-to-text` | yes | Authenticated experimental speech transcription for browser clients |
| `@yharness/experimental-auto-review` | no | Per-tool LLM authorization review for the Y Harness Auto permission preset |
| `@yharness/experimental-browser-use-chrome-devtools-mcp` | yes | Experimental per-Session Chromium browser tools through chrome-devtools-mcp |
| `@yharness/experimental-browser-use-playwright-mcp` | yes | Experimental per-Session Chromium browser tools through @playwright/mcp |
| `@yharness/experimental-browser-use-stagehand-native` | yes | Experimental Stagehand browser tools with separately configured native models |
| `@yharness/experimental-claude-code-mods` | yes | Experimental bridge: load Claude Code mods (hooks modules) and run their hook chains on Y Harness extension points |
| `@yharness/experimental-client-ui-agent-team` | no | Web Agent Teams roster, task board, and teammate navigation |
| `@yharness/experimental-client-ui-claude-code-mods` | no | Web band above the prompt for Claude Code mods: draws each session's mod tree and sends button presses back to the bridge |
| `@yharness/experimental-client-ui-voice-input` | no | Record speech and insert editable text into the conversation draft |
| `@yharness/experimental-computer-use-cua-driver-mcp` | yes | Experimental computer use through an installed Cua Driver MCP executable |
| `@yharness/experimental-computer-use-cua-driver-native` | no | Experimental computer-use provider embedding the Cua Driver native npm SDK |
| `@yharness/experimental-inspector` | yes | Experimental cross-realm CDP hub for Host debugging and Client Runtime inspection |
| `@yharness/experimental-ptc-runtime-python` | yes | CPython subprocess implementation of the Y Harness PTC execution seam |
| `@yharness/experimental-session-inspector` | no | Experimental virtualized Session log and live Chat group/node inspectors |
| `@yharness/experimental-speech-to-text` | yes | Experimental speech recognition with independently selectable providers |
| `@yharness/experimental-speech-to-text-sensevoice` | yes | Local SenseVoice ONNX transcription with a managed sherpa-onnx process |
| `@yharness/experimental-tool-agent-team` | yes | Scoped model-facing Agent Teams tools over ctx.agentTeams |

## extensions

| Package | Config | Description |
|---|---|---|
| `@yharness/client-ui-cordis` | no | Cordis dynamic-plugin definition card: the keyed cordis_define tool row with its run/stop switch |
| `@yharness/cordis-client-runner` | no | Browser half of dynamic dual-half plugin packages: event subscription, closure evaluation, guard facade, and loader entries |
| `@yharness/cordis-host-runner` | yes | Dynamic package definition registry, host-half sandbox lifecycle, and invoke handler table for model-mounted dual-half packages |
| `@yharness/tool-cordis` | no | Read-only runtime API inspection for Harness plugin development |

## feedback

| Package | Config | Description |
|---|---|---|
| `@yharness/command-feedback` | no | Log-only session feedback: the record event, the sessionFeedback Host Remote, and the human-facing slash command |
| `@yharness/message-feedback` | yes | Canonical Session-log ratings and notes for finalized assistant messages |

## fs

| Package | Config | Description |
|---|---|---|
| `@yharness/fs-local` | yes | Local-filesystem implementation of the Y Harness filesystem seam (ctx.fs) |
| `@yharness/fs-observation-policy` | no | File-context policy plugin for the Y Harness — observed-state, read-before-edit, and version-guarded write/edit added over the ctx.fs provider seam through the fs/* event gate (no service API) |
| `@yharness/fs-sandbox` | yes | Sandbox-enforcing implementation of the Y Harness filesystem seam: fences write/edit by the per-call sandbox mode (read-only denies mutation, workspace-write contains it to the workspace + temp roots) while reads pass through |
| `@yharness/tool-fs` | yes | Model-facing filesystem tools (read, write, edit) over the Y Harness filesystem seam (ctx.fs) |
| `@yharness/tool-fs-search` | yes | Model-facing filesystem discovery tools (glob, grep) backed by the packaged ripgrep binary (@vscode/ripgrep) |
| `@yharness/tool-str-replace-editor` | yes | Model-facing view, create, literal replace, and line insert tool over the Harness filesystem service |

## goal

| Package | Config | Description |
|---|---|---|
| `@yharness/command-goal` | no | Human-facing slash command for persisted same-session goals |
| `@yharness/goal` | yes | Event-sourced same-session goal state and lifecycle service for the Y Harness |
| `@yharness/goal-round-driver` | no | Race-fenced same-session goal-round driver |
| `@yharness/tool-goal` | yes | Model-facing same-session goal tools with execution-time authority checks |

## guard

| Package | Config | Description |
|---|---|---|
| `@yharness/repeat-tool-reminder` | yes | Repeat-tool-call guard plugin: advisory reminders when an agent loops on identical tool calls |
| `@yharness/tool-call-timeout-policy` | no | Tool-call timeout policy: a tools/execute wrapper that arms a per-tool deadline on exec.signal and returns TOOL_TIMEOUT when it wins |

## hooks

| Package | Config | Description |
|---|---|---|
| `@yharness/hooks-claude-code` | yes | Bridge plugin: run a Claude Code hooks.json / settings hook config on the Y Harness interception seams |
| `@yharness/hooks-codex` | yes | Bridge plugin: run a Codex hooks.json hook config on the Y Harness interception seams |

## host

| Package | Config | Description |
|---|---|---|
| `@yharness/host-directory-picker-auto` | no | Adaptive chooser of the directory-picker seam: resolves the host situation at boot and mounts the native or browse backend for the Y Harness web GUI host |
| `@yharness/host-directory-picker-browse` | yes | In-app browsing backend of the directory-picker seam (listing/creation primitives over the host filesystem) |
| `@yharness/host-directory-picker-native` | no | Native-OS-chooser backend of the directory-picker seam for the Y Harness web GUI host |
| `@yharness/host-frontend-static` | yes | SPA dist server for the Web shell: owns the webserver fallback seat, serving explicit index entries and static assets with traversal rejection and 404 misses |
| `@yharness/host-open-in-app` | yes | Host half of open-in-app: resolved application catalog, icons, and the launch endpoint as three webServer routes |
| `@yharness/host-plugin-inventory` | no | Read-only Remote projection of current Cordis Loader plugin state |
| `@yharness/host-product-telemetry-otel` | yes | Explicit product usage events exported through OpenTelemetry HTTP logs |
| `@yharness/host-webserver` | yes | Web route-registration plugin: HTTP and upgrade routes, index transform taps, and static dist fallback; knows no harness concepts |

## interaction

| Package | Config | Description |
|---|---|---|
| `@yharness/commands` | no | Plugin-owned human command registry for Y Harness UIs |
| `@yharness/permission-presets` | yes | User-facing permission presets (ctx.permissionPresets) for the Y Harness: one product-level Permissions select bundling the sandbox-mode and approval-policy knobs, written through to their own session events |
| `@yharness/tool-ask-user` | yes | Model-facing ask_user_question tool over the ctx.userQuestions seam |
| `@yharness/user-approval` | yes | User-approval seam (ctx.approval) for the Y Harness: one-shot permission decisions dispatched to composed answerers over the approval/request waterfall, fail-closed by default |
| `@yharness/user-questions` | no | Abstract user-questions seam (ctx.userQuestions) for asking the human during agent runs |

## jobs

| Package | Config | Description |
|---|---|---|
| `@yharness/jobs-local` | yes | Process-local implementation of the Y Harness background job registry seam |
| `@yharness/tool-jobs` | yes | Model-facing background job control tools (job_output, job_list, job_kill) over the ctx.jobs registry |

## llm

| Package | Config | Description |
|---|---|---|
| `@yharness/deepseek-llm-api-extensions` | no | Additive request-field registry for the official DeepSeek LLM API adapter |
| `@yharness/llm` | no | Provider-neutral LLM service interface for the Y Harness |
| `@yharness/llm-deepseek-account` | yes | DeepSeek account provider authentication and discovery |
| `@yharness/llm-deepseek-api-key` | yes | DeepSeek api-key provider authentication and discovery |
| `@yharness/llm-pi-ai` | yes | pi-ai-backed DeepSeek adapter for the Y Harness LLM seam (design-verification twin of dsh-llm-deepseek) |
| `@yharness/llm-retry` | yes | Provider-routed LLM request retry policy for the Y Harness |
| `@yharness/plugin-package-inventory-deepseek` | yes | Active Loader-backed plugin package inventory for official DeepSeek LLM API requests |
| `@yharness/token-meter` | yes | Replay-aware token measurement service (ctx.tokenMeter) for the Y Harness |

## lsp

| Package | Config | Description |
|---|---|---|
| `@yharness/lsp` | no | Abstract LSP capability seam (ctx.lsp) for Y Harness — language-server provider registry keyed by branded id and extension mapping, order-independent per-query selection, normalized definition/references/implementation/hover requests and results, and the LspError taxonomy |
| `@yharness/lsp-stdio` | yes | Generic stdio language-server provider for the Y Harness LSP capability seam (ctx.lsp) — spawns configured servers, translates JSON-RPC, and serves transient-open goToDefinition/findReferences/goToImplementation/hover queries in the host filesystem namespace |
| `@yharness/tool-lsp` | yes | Model-facing lsp tool over the Y Harness LSP capability seam (ctx.lsp) — one read-only tool with goToDefinition/findReferences/goToImplementation/hover operations, one-based UTF-16 cursor coordinates, bounded location rendering, and hover normalization |

## mcp

| Package | Config | Description |
|---|---|---|
| `@yharness/mcp-client` | yes | MCP client bridge: connects to MCP servers and registers their tools on ctx.tools |
| `@yharness/mcp-resources` | no | Scoped MCP resource discovery and reading through shared model tools |

## plan

| Package | Config | Description |
|---|---|---|
| `@yharness/plan-mode` | yes | Logged per-agent plan mode with deployment guidance, a direct slash command, and a user-reviewed exit |

## preset

| Package | Config | Description |
|---|---|---|
| `@yharness/agent-preset` | yes | Declare an Agent capability composition in Cordis YAML |
| `@yharness/agent-preset-registry` | yes | Declarative Agent preset registry and profile-backed editing |
| `@yharness/persona` | yes | Composition-authored deployment persona section for Y Harness |

## ptc-runtime

| Package | Config | Description |
|---|---|---|
| `@yharness/ptc-runtime-node` | yes | Sandboxed Node process implementation of the Y Harness PTC execution capability |

## sandbox

| Package | Config | Description |
|---|---|---|
| `@yharness/sandbox-local` | yes | Local process-sandbox backends for the Y Harness sandbox seam: bwrap, the npm-distributed landlock-run launcher, macOS Seatbelt, or the Windows ACL restricted-token runner — functionally probed, fail-closed |
| `@yharness/sandbox-policy` | yes | Per-call sandbox policy resolver and current model context: deployment fallbacks plus each session's mode and workspace root, shared by every enforcing capability family |

## schedule

| Package | Config | Description |
|---|---|---|
| `@yharness/schedule` | yes | Host-wide durable reminders with shared management and original-Session delivery |
| `@yharness/tool-schedule` | no | Model-facing reminder management tools (schedule_create, schedule_list, schedule_update, schedule_delete) over the Host ctx.schedule service |

## sdk

| Package | Config | Description |
|---|---|---|
| `@yharness/sdk-jsonrpc-server` | yes | Stdio JSON-RPC server plugin for out-of-process Y Harness SDK clients |

## session

| Package | Config | Description |
|---|---|---|
| `@yharness/coding-session` | yes | Source-labelled native coding-session discovery, durable mirrors, and explicit sequential handoff |
| `@yharness/session-checkpoint-policy` | no | Semantic session durability checkpoints before model requests and tool side effects |
| `@yharness/session-log-deepseek` | yes | Incremental lossless session-log request extension for the official DeepSeek LLM API |
| `@yharness/session-persistence-jsonl` | yes | JSONL durable session persistence backend for the Y Harness |
| `@yharness/session-projection` | no | Session-projection seam: the merge-extensible projection type table, the provider contract, and the ctx.sessionProjections registry serving whole current values of log-derived per-session state |
| `@yharness/session-projection-cache` | yes | Persisted projection cache (ctx.sessionProjectionCache): durable per-session checkpoint records on the session_projcache storage domain (per-record layout), throttled write-behind, and the cached listing read |
| `@yharness/session-stats` | no | Whole-log conversation counts and wall times projection (sessionStats) for the Y Harness |
| `@yharness/session-telemetry-otel` | yes | Feedback-authorized Session logs over byte-bounded OpenTelemetry HTTP requests |
| `@yharness/session-title` | yes | Log-backed session title service and provider registry for the Y Harness |
| `@yharness/session-title-all-prompts-llm` | yes | All-user-messages LLM provider plugin for Y Harness session titles |
| `@yharness/session-title-first-prompt-llm` | yes | First-message LLM provider plugin for Y Harness session titles |
| `@yharness/session-turn-outline` | no | Whole-log turn outline projection (turnOutline) for the Y Harness |

## session-query

| Package | Config | Description |
|---|---|---|
| `@yharness/session-log-export` | yes | Web Session-log export command and shared download dialog |
| `@yharness/session-query-sqlite` | yes | Concrete ctx.sessionQuery backend with SQLite FTS5 search |
| `@yharness/tool-session-query` | yes | Workspace-authorized model-facing session history search, trace, and event read tools |

## settings

| Package | Config | Description |
|---|---|---|
| `@yharness/provider-config-sync` | yes | Opt-in ordinary provider catalog configuration synchronization |
| `@yharness/settings` | no | Abstract user-settings seam (ctx.settings) for the Y Harness |

## shell

| Package | Config | Description |
|---|---|---|
| `@yharness/bash-local` | yes | Local-subprocess implementation of the Y Harness bash executor seam |
| `@yharness/bash-sandbox` | yes | Sandbox-consuming implementation of the Y Harness bash executor seam (confines every command via ctx.sandbox, reports denial/enforcement result facts) |
| `@yharness/pwsh-local` | yes | Local PowerShell implementation of the Y Harness bash executor seam |
| `@yharness/pwsh-sandbox` | yes | Sandbox-consuming implementation of the Y Harness PowerShell executor seam (confines every command via ctx.sandbox, reports denial/enforcement result facts) |
| `@yharness/shell-env` | yes | Tool-independent managed DSH_* shell environment registry |
| `@yharness/tool-bash` | yes | Model-facing bash tool with optional generic background-job and sandbox-escalation support |
| `@yharness/tool-bash-persistent` | yes | Model-facing owner-scoped persistent Bash tool backed by the Harness PTY service |
| `@yharness/tool-pwsh` | yes | Model-facing pwsh tool over the bash executor seam |
| `@yharness/tool-pwsh-persistent` | yes | Model-facing owner-scoped persistent PowerShell tool backed by the Harness PTY service |

## skill

| Package | Config | Description |
|---|---|---|
| `@yharness/skill` | yes | Agent skill provider registry for the Y Harness |
| `@yharness/skill-badge` | no | Bundled Y Harness badge skill provider |
| `@yharness/skill-compound` | yes | Bundled Compound engineering skills with their vendored Python analysis tooling |
| `@yharness/skill-filesystem` | yes | Local filesystem skill provider for the Y Harness |
| `@yharness/skill-library` | yes | Project skill inventory and reversible managed maintenance |
| `@yharness/skill-office` | yes | Bundled Word, PowerPoint, and Excel workflows and structural checks |
| `@yharness/tool-skill` | yes | Model-facing skill loading tool for the Y Harness |
| `@yharness/tool-workspace-dependencies` | yes | The load_workspace_dependencies tool: absolute paths into a bundled Python, Node.js, and pnpm payload |

## spill

| Package | Config | Description |
|---|---|---|
| `@yharness/spill-local` | yes | Local-filesystem implementation of the Y Harness spill storage seam (private session-scoped files) |
| `@yharness/spill-policy` | yes | Token-budgeted tool-result retention with recoverable text and image paths |

## ssh

| Package | Config | Description |
|---|---|---|
| `@yharness/fs-ssh` | no | Filesystem provider over the shared POSIX SSH helper |
| `@yharness/sandbox-ssh` | no | Remote POSIX sandbox argv provider over the shared SSH helper |
| `@yharness/ssh` | yes | Shared OpenSSH connection and versioned POSIX remote helper |
| `@yharness/subprocess-ssh` | no | Subprocess and terminal provider over the shared POSIX SSH helper |

## storage

| Package | Config | Description |
|---|---|---|
| `@yharness/storage` | no | Storage hub (ctx.storage): named backend registry plus mounted data-form facilities for the Y Harness |
| `@yharness/storage-domain` | yes | Domain data form (ctx.storage.domain): schema-validated, event-emitting KV domains over storage backends for the Y Harness |
| `@yharness/storage-json` | yes | JSON file KV storage backend for the Y Harness storage hub |
| `@yharness/storage-sqlite` | yes | SQLite storage backend (kv facet) for the Y Harness storage hub |

## subagent

| Package | Config | Description |
|---|---|---|
| `@yharness/subagent` | yes | Abstract subagent seam (ctx.subagents): named-provider registry for delegating to child agents |
| `@yharness/subagent-acp` | yes | Out-of-process ACP subagent backend: drives a child agent in a spawned subprocess over the Agent Client Protocol |
| `@yharness/subagent-claude-code` | yes | Claude Code one-shot subagents and optional normal root turns over the official Agent SDK |
| `@yharness/subagent-codex` | yes | One-shot Codex subagent provider over the official app-server protocol |
| `@yharness/subagent-dsh-sdk` | yes | Out-of-process SDK subagent backend: drives a child Y Harness runtime subprocess over stdio JSON-RPC through the TypeScript SDK client |
| `@yharness/subagent-fork-in-process` | yes | In-process fork subagent backend: runs a child agent seeded with a prefix of the parent's log |
| `@yharness/subagent-spawn-in-process` | yes | In-process spawn subagent backend: runs a fresh child agent on ctx.agents |
| `@yharness/tool-subagent` | yes | Model-facing subagent delegation tool over the ctx.subagents seam |
| `@yharness/tool-subagent-control` | no | Globally named send_message, interrupt_agent, and list_agents tools over ctx.subagents continuations |

## subprocess

| Package | Config | Description |
|---|---|---|
| `@yharness/subprocess-local` | no | Local-subprocess implementation of the Y Harness subprocess seam |

## telemetry

| Package | Config | Description |
|---|---|---|
| `@yharness/otel` | no | Cordis service for independent ordinary-event and byte-bounded Session-log OTLP channels |

## terminal

| Package | Config | Description |
|---|---|---|
| `@yharness/terminal` | no | Persistent PTY session seam for the Y Harness — owner-scoped ids, backend registry, interactive sends, reads, signals, and awaited cleanup |
| `@yharness/terminal-bash` | yes | Persistent shell PTY backend over the Y Harness subprocess terminal primitive |
| `@yharness/tool-terminal` | yes | Six model-facing persistent PTY tools with owner isolation and generic background-job integration |

## test-support

| Package | Config | Description |
|---|---|---|
| `@yharness/llm-replay` | yes | Replay LLM plugin: short-circuits llm/stream with model chunks reconstructed from a recorded session JSONL (keyless snapshot tests) |

## todo

| Package | Config | Description |
|---|---|---|
| `@yharness/tool-todo` | yes | Model-facing todo_write tool over the Y Harness event-sourced session log |

## typert

| Package | Config | Description |
|---|---|---|
| `@yharness/typert-loader` | yes | Loader integration for generated Typert package contributions |

## web

| Package | Config | Description |
|---|---|---|
| `@yharness/tool-web` | yes | Model-facing web tools (web_search, web_fetch) over the Y Harness web capability seam (ctx.web) |
| `@yharness/web` | yes | Abstract web access capability seam (ctx.web) for the Y Harness — search/fetch provider registry, registration-order-independent selection, request/result vocabulary, and the WebError taxonomy |
| `@yharness/web-deepseek-api` | yes | DeepSeek Search and Fetch API providers for the Y Harness web capability seam (ctx.web) |
| `@yharness/web-fetch-http` | yes | Anonymous public HTTP(S) fetch provider for the Y Harness web capability seam (ctx.web) |
| `@yharness/web-search-deepseek` | yes | DeepSeek-backed search provider (native web_search via the Anthropic-compatible API) for the Y Harness web capability seam (ctx.web) |
| `@yharness/web-search-exa` | yes | Exa-backed search provider for the Y Harness web capability seam (ctx.web) |
| `@yharness/web-search-perplexity` | yes | Perplexity-backed search provider for the Y Harness web capability seam (ctx.web) |

## webhook

| Package | Config | Description |
|---|---|---|
| `@yharness/webhook` | no | Fire-and-forget webhook rule runtime that creates Workspace-backed Y Harness Sessions |
| `@yharness/webhook-github` | yes | Signed GitHub HTTP webhook adapter for the Y Harness webhook runtime |

## workflow

| Package | Config | Description |
|---|---|---|
| `@yharness/tool-ralph` | yes | Model-facing fresh-agent Ralph loop over the workflow and subagent seams |
| `@yharness/tool-workflow` | yes | Model-facing workflow tool: run a JavaScript orchestration script over ctx.workflowEngine |
| `@yharness/workflow-ptc` | yes | Workflow orchestration in the shared sandboxed Node PTC runtime |

## workspace

| Package | Config | Description |
|---|---|---|
| `@yharness/workspace` | no | Workspace entity registry (ctx.workspaceRegistry): durable workspace records with validated session attachment over the domain data form for the Y Harness |

/** Pure archive-format, triplet, and immutable-manifest helpers. */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { AGENT_NOTE_CLASSES } from './agent-note-tree.ts'


/** Versioned fields in the frozen-content manifest. */
export interface ArchiveManifest {
  version: 1 | 2
  files: Readonly<Record<string, string>>
  /**
   * SHA-256 seals for translation artifacts retired by the one-time English-only migration.
   *
   * @remarks
   * Version 2 manifests keep these hashes as source-record seals while the corresponding files are
   * intentionally absent from the working tree. The record is immutable after migration.
   */
  retired?: Readonly<Record<string, string>>
  /**
   * Pre-migration SHA-256 seals for retained English notes rewritten by the migration.
   *
   * @remarks
   * Version 2 manifests keep these hashes so the verifier can distinguish the approved
   * switcher/reference rewrite from an unrelated edit to a frozen note.
   */
  rewritten?: Readonly<Record<string, string>>
}

/** Hash one archived artifact independently of the repository's Git object format. */
function archiveContentHash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/** Compute the SHA-1 Git blob id used by bilingual consistency sidecars. */
export function gitBlobHash(content: Buffer): string {
  const hash = createHash('sha1')
  hash.update(`blob ${content.byteLength}\0`)
  hash.update(content)
  return hash.digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the archive manifest and reject fields or hashes outside its closed schema. */
export function parseArchiveManifest(content: string): ArchiveManifest {
  const value: unknown = JSON.parse(content)
  if (!isRecord(value)) throw new Error('expected a JSON object')
  const version = value.version
  if (version !== 1 && version !== 2) throw new Error('unsupported manifest version (expected 1 or 2)')
  const fields = Object.keys(value).sort()
  const expectedFields = version === 1 ? 'files,version' : 'files,retired,rewritten,version'
  if (fields.join(',') !== expectedFields) {
    throw new Error(`expected exactly the fields for manifest version ${version}: ${expectedFields}`)
  }
  if (!isRecord(value.files)) throw new Error('`files` must be an object')
  const files: Record<string, string> = {}
  for (const [path, hash] of Object.entries(value.files)) {
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid content hash for ${path}`)
    }
    files[path] = hash
  }
  if (version === 1) return { version, files }
  if (!isRecord(value.retired)) throw new Error('`retired` must be an object in manifest version 2')
  const retired: Record<string, string> = {}
  for (const [path, hash] of Object.entries(value.retired)) {
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid retired content hash for ${path}`)
    }
    retired[path] = hash
  }
  if (!isRecord(value.rewritten)) throw new Error('`rewritten` must be an object in manifest version 2')
  const rewritten: Record<string, string> = {}
  for (const [path, hash] of Object.entries(value.rewritten)) {
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid rewritten content hash for ${path}`)
    }
    rewritten[path] = hash
  }
  return { version, files, retired, rewritten }
}

/** Render the archive manifest with deterministic path ordering. */
export function renderArchiveManifest(
  files: Readonly<Record<string, string>>,
  options: {
    version?: 1 | 2
    retired?: Readonly<Record<string, string>>
    rewritten?: Readonly<Record<string, string>>
  } = {},
): string {
  const version = options.version ?? 1
  const orderedFiles = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)))
  const manifest = version === 1
    ? { version, files: orderedFiles }
    : {
      version,
      files: orderedFiles,
      retired: Object.fromEntries(Object.entries(options.retired ?? {}).sort(([left], [right]) => left.localeCompare(right))),
      rewritten: Object.fromEntries(Object.entries(options.rewritten ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Whether a path is one of the translation artifacts removed by the English-only migration. */
export function isRetiredTranslationArtifact(path: string): boolean {
  return path.endsWith('.zh.md') || path.endsWith('.i18n.yaml')
}

function recordsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

// Exact seals for the authorized Figma-link removal and its bilingual sidecar.
const figmaLinkRemovals = [
  {
    path: 'feature/2026-08-10-durable-workflow-runs-in-chat.md',
    before: 'sha256:f9f5290cd880908d17b1080ae5776f22e182f5253471f90cf8bead418b33b502',
    after: 'sha256:6018de4a89ca99d6cbfd618aff1c8136b23d8e4854a30f7b12a602f0417cbdc2',
  },
  {
    path: 'feature/2026-08-10-durable-workflow-runs-in-chat.zh.md',
    before: 'sha256:f4ffd2700bc9c2a0cc4b9d90f84e1d0a576939e2e6f0b130c5b142fd8cd518b0',
    after: 'sha256:0080859221773122022d5880efa3d52f29c0872b52d63e170250d94f214ff37a',
  },
  {
    path: 'feature/2026-08-10-durable-workflow-runs-in-chat.i18n.yaml',
    before: 'sha256:0db3c21a3c8785e56d5d7b90df990b158069cd1cea664e62fc4786c6d7588450',
    after: 'sha256:03eadb60c8ba4fde262cd61e3f911d8cd68ea4a58f57adeb8dd7bb9a97d08ca2',
  },
]

/** Reject sealed changes except the exact authorized Figma-link removal hashes. */
export function validateArchiveManifestExtension(
  baseline: ArchiveManifest,
  current: ArchiveManifest,
): string[] {
  const errors: string[] = []
  const baselineRetired = baseline.retired ?? {}
  const currentRetired = current.retired ?? {}
  const baselineRewritten = baseline.rewritten ?? {}
  const currentRewritten = current.rewritten ?? {}
  if (baseline.version === 1 && current.version === 2) {
    const expectedRetired = Object.fromEntries(
      Object.entries(baseline.files).filter(([path]) => isRetiredTranslationArtifact(path)),
    )
    const expectedRewritten = Object.fromEntries(
      Object.entries(baseline.files).filter(([path]) => path.endsWith('.md') && !path.endsWith('.zh.md')),
    )
    if (!recordsEqual(currentRetired, expectedRetired)) {
      errors.push('manifest version 2 must retire exactly the baseline translation artifacts')
    }
    if (!recordsEqual(currentRewritten, expectedRewritten)) {
      errors.push('manifest version 2 must record exactly the baseline seals for rewritten English artifacts')
    }
  } else if (baseline.version !== current.version) {
    errors.push(`manifest version changed from ${baseline.version} to ${current.version} outside the one-time migration`)
  } else {
    if (!recordsEqual(baselineRetired, currentRetired)) {
      errors.push('retired archive seals changed after the one-time migration')
    }
    if (!recordsEqual(baselineRewritten, currentRewritten)) {
      errors.push('rewritten archive seals changed after the one-time migration')
    }
  }

  for (const [path, expected] of Object.entries(baseline.files)) {
    const actual = current.files[path]
    if (actual === undefined) {
      const retired = baseline.version === 1 && current.version === 2
        && currentRetired[path] === expected
        && isRetiredTranslationArtifact(path)
      if (!retired) errors.push(`${path}: sealed manifest entry is missing`)
    }
    else if (actual !== expected) {
      const migrationRewrite = baseline.version === 1 && current.version === 2
        && currentRewritten[path] === expected
        && path.endsWith('.md')
        && !path.endsWith('.zh.md')
      const figmaRewrite = figmaLinkRemovals.some(change =>
        change.path === path && change.before === expected && change.after === actual,
      )
      if (!migrationRewrite && !figmaRewrite) errors.push(`${path}: sealed manifest hash changed`)
    }
  }

  for (const [path, hash] of Object.entries(currentRetired)) {
    if (!isRetiredTranslationArtifact(path)) errors.push(`${path}: only translation artifacts may be retired`)
    if (current.files[path] !== undefined) errors.push(`${path}: retired artifact is still present in files`)
    const baselineHash = baseline.version === 1 ? baseline.files[path] : baselineRetired[path]
    if (baselineHash !== hash) errors.push(`${path}: retired seal does not match the baseline manifest`)
  }
  return errors
}

type ArchiveTextReplacement = readonly [before: string, after: string]

const hanCharacter = /\p{Script=Han}/u

// These full-line entries preserve the approved English rewrites for retained notes that had Han text.
// Keeping the old and new lines together makes the migration deterministic and fail closed.
const englishOnlyHanLineReplacements: Readonly<Record<string, readonly ArchiveTextReplacement[]>> = {
  'architecture/2026-07-19-gui-layering-and-rpc-protocol.md': [
    ['                 client \u{53D1}\u{8D77}                      server \u{53D1}\u{8D77}', '                 client initiated                 server initiated'],
    ['            （POST /api/<method> body）      （WebSocket message：session \u{4E8B}\u{4EF6}\u{3001}\u{5BA1}\u{6279}/\u{95EE}\u{7B54} requested）', '            (POST /api/<method> body)        (WebSocket message: session events, approval/question requested)'],
    ['            （\u{8BE5} POST \u{7684} HTTP \u{5E94}\u{7B54}\u{4F53}）        （POST /api/respond body，\u{56DE}\u{586B} ③ \u{7684} rpcId）', '            (HTTP response body for that POST) (POST /api/respond body, fills the rpcId in ③)'],
    ["  'session.list': SessionsApi['list']        // map key \u{5373} wire \u{8DEF}\u{5F84}\u{6BB5}", "  'session.list': SessionsApi['list']        // map key is the wire path segment"],
    ['  // …\u{5176}\u{4F59}\u{65B9}\u{6CD5}\u{540C}\u{5F62}\u{767B}\u{8BB0}，\u{5168}\u{96C6}\u{89C1} api/rpc-map.ts', '  // …other methods are registered the same way; see api/rpc-map.ts for the full list'],
    ['// \u{6D3E}\u{751F}\u{6CDB}\u{578B}（\u{7A7F}\u{900F}\u{7A84}\u{5F62}\u{53D6}\u{4E1A}\u{52A1}\u{7C7B}\u{578B}；\u{5B9E}\u{9645}\u{58F0}\u{660E}\u{5E26} K extends keyof RpcMethodMap \u{7EA6}\u{675F}）', '// Derived generic (unwraps the narrow form to the business type; the declaration constrains K with keyof RpcMethodMap)'],
  ],
  'architecture/2026-07-19-gui-web-client-architecture.md': [
    ['│ Connection + Gateway: RPC/events│◀─▶│  ├ vendored Loader + ctx.modules（\u{5185}\u{6838}，\u{58F3}\u{9759}\u{6001}\u{6301}\u{6709}）│', '│ Connection + Gateway: RPC/events│◀─▶│  ├ vendored Loader + ctx.modules (kernel, statically held by shell)│'],
    ['│  ├ GET /plugins/<id>/client.js │   │  │   ui-theme/i18n（fetch bundle，boot \u{9884}\u{62C9}）       │', '│  ├ GET /plugins/<id>/client.js │   │  │   ui-theme/i18n (fetch bundle, prefetched at boot)       │'],
    ['│  └ GET / \u{6CE8}\u{5165} __DSH_BOOT__ \u{56FE}  │   │  ├ lazy entries: layout/sidebar/                   │', '│  └ GET / injects __DSH_BOOT__  │   │  ├ lazy entries: layout/sidebar/                   │'],
    ['│                                │   │  │   conversation/trajectory（fetch bundle，\u{6309}\u{9700}） │', '│                                │   │  │   conversation/trajectory (fetch bundle, on demand) │'],
    ['└────────────────────────────────┘   │  ├ ui-renderer（fetch bundle，React \u{6839}）       │', '└────────────────────────────────┘   │  ├ ui-renderer (fetch bundle, React root)       │'],
    ['                                     │  └ session scope ×N（\u{89C2}\u{770B}\u{9A71}\u{52A8}，\u{60F0}\u{6027}\u{5EFA}）            │', '                                     │  └ session scope ×N (observation-driven, lazily created)            │'],
    ['                                     │ DOM loading \u{9875} → settled → React UI \u{4E00}\u{6B21}\u{6210}\u{578B}       │', '                                     │ DOM loading page → settled → React UI rendered once       │'],
    ['Notifier \u{5FAE}\u{4EFB}\u{52A1}\u{5408}\u{6279} ──► ConversationSnapshot \u{7F13}\u{5B58} ──uSES──► \u{7EC4}\u{4EF6}', 'Notifier microtask batching ──► ConversationSnapshot cache ──uSES──► components'],
  ],
  'architecture/2026-07-30-command-row-copy-contract.md': [
    ["The row title is the bare command name — no `/`, no arguments. The `/` belongs to the composer's input grammar, not to a settled record, and the argument is not the row's to report: the summary already says what the command did. `GenericCommandCard` keeps the `\u{547D}\u{4EE4}` fallback for a cross-window node whose `command/run` page fell out of the client's window.", "The row title is the bare command name — no `/`, no arguments. The `/` belongs to the composer's input grammar, not to a settled record, and the argument is not the row's to report: the summary already says what the command did. `GenericCommandCard` keeps the `Command` fallback for a cross-window node whose `command/run` page fell out of the client's window."],
    ["Every command row gets shorter, and the rule scales: a new command's author writes its outcome without knowing which surface renders it, and no surface has to de-duplicate. The cost is that the dispatched arguments leave the collapsed row — while a command is still executing the row shows only its name and `\u{6267}\u{884C}\u{4E2D}…` — and that the no-caption rule is a convention the reviewer enforces, not a gate. The `/permission` texts are pinned by the permission package's command tests, and the assembled row copy by the [seeded-history](../../../../snapshots/web/seeded-history/command-row.expected.md) web golden, which reaches a real settled command row keylessly because `/permission` runs entirely on the host.", "Every command row gets shorter, and the rule scales: a new command's author writes its outcome without knowing which surface renders it, and no surface has to de-duplicate. The cost is that the dispatched arguments leave the collapsed row — while a command is still executing the row shows only its name and `Running…` — and that the no-caption rule is a convention the reviewer enforces, not a gate. The `/permission` texts are pinned by the permission package's command tests, and the assembled row copy by the [seeded-history](../../../../snapshots/web/seeded-history/command-row.expected.md) web golden, which reaches a real settled command row keylessly because `/permission` runs entirely on the host."],
  ],
  'architecture/2026-07-30-web-config-plane.md': [
    ["**A hand-written editor over a schema model layer.** `ctx.settingsSchema`, provided by `dsh-client-ui-settings`, rehydrates the wire's `toJSON()` envelope into live schemastery nodes for validation, path resolution, and immutable draft editing — but no generic rendering: the first cut shipped a full schema-driven form renderer, and the resulting page was an unstyled schema dump (every advanced field flattened onto the card, raw field names as labels, the `retryPolicy` unsupported-fallback in the main flow). The hand-written direction won over adding a hint/grouping system, and a further simplification removed the reference input entirely: the card's primary field is one **API key** input, a whole-section provider without a configured key opens as its setup card, and the collapsed \u{81EA}\u{5B9A}\u{4E49}\u{8BBE}\u{7F6E} fold carries the curated per-family extras (`baseURL` for both families, `reasoningEffort` for deepseek / `reasoning` for pi-ai, plus direct DeepSeek model rows with `id`, `name`, and `contextWindow`). Existing model fields outside that visible set survive array edits; retry policy, timeouts, and other fields remain owned by `settings.yaml`. Validation still runs the rehydrated schema before writing, while adapter-specific checks reject catalog invariants that the serialized schema cannot express. The card's colors resolve through the `--dsw-alias-*` design tokens; it had named `--border`/`--surface`/`--text-*`, which nothing in this app defines, so it rendered their light-mode fallbacks and stayed light under the dark theme. The model catalog takes the row shape the pi-ai provider form introduces: one bordered entry per model, id and display name on the row, and the capacities behind the row's own disclosure, so the two editors read as one design rather than diverging. Every field keeps the indexed `aria-label` that names it. Both capacities are text fields reading a decimal `K`/`M` suffix (`1M` is 1000K, matching how capacities are quoted) and storing the plain count: a field holds the typed text while it has focus, because re-deriving it from the parsed count on every keystroke would rewrite `1000` to `1K` mid-word, and text that does not parse stays on screen so the save-time rejection names a row the user can still see. The shared class names carry only declared token spellings: `--dsw-alias-border-subtle`, `--dsw-alias-text-tertiary`, and `--dsw-alias-text-primary` are undeclared, so naming them resolves to the light-mode literals in their fallback slots. A styles test now rejects any `--dsw-*` name the token sheet does not declare, so the next editor to name one fails rather than shipping a light-only surface.", "**A hand-written editor over a schema model layer.** `ctx.settingsSchema`, provided by `dsh-client-ui-settings`, rehydrates the wire's `toJSON()` envelope into live schemastery nodes for validation, path resolution, and immutable draft editing — but no generic rendering: the first cut shipped a full schema-driven form renderer, and the resulting page was an unstyled schema dump (every advanced field flattened onto the card, raw field names as labels, the `retryPolicy` unsupported-fallback in the main flow). The hand-written direction won over adding a hint/grouping system, and a further simplification removed the reference input entirely: the card's primary field is one **API key** input, a whole-section provider without a configured key opens as its setup card, and the collapsed Custom settings fold carries the curated per-family extras (`baseURL` for both families, `reasoningEffort` for deepseek / `reasoning` for pi-ai, plus direct DeepSeek model rows with `id`, `name`, and `contextWindow`). Existing model fields outside that visible set survive array edits; retry policy, timeouts, and other fields remain owned by `settings.yaml`. Validation still runs the rehydrated schema before writing, while adapter-specific checks reject catalog invariants that the serialized schema cannot express. The card's colors resolve through the `--dsw-alias-*` design tokens; it had named `--border`/`--surface`/`--text-*`, which nothing in this app defines, so it rendered their light-mode fallbacks and stayed light under the dark theme. The model catalog takes the row shape the pi-ai provider form introduces: one bordered entry per model, id and display name on the row, and the capacities behind the row's own disclosure, so the two editors read as one design rather than diverging. Every field keeps the indexed `aria-label` that names it. Both capacities are text fields reading a decimal `K`/`M` suffix (`1M` is 1000K, matching how capacities are quoted) and storing the plain count: a field holds the typed text while it has focus, because re-deriving it from the parsed count on every keystroke would rewrite `1000` to `1K` mid-word, and text that does not parse stays on screen so the save-time rejection names a row the user can still see. The shared class names carry only declared token spellings: `--dsw-alias-border-subtle`, `--dsw-alias-text-tertiary`, and `--dsw-alias-text-primary` are undeclared, so naming them resolves to the light-mode literals in their fallback slots. A styles test now rejects any `--dsw-*` name the token sheet does not declare, so the next editor to name one fails rather than shipping a light-only surface."],
  ],
  'architecture/2026-08-25-rename-code-mode-to-ptc.md': [
    ["The tool-registry presentation mode that exposes tools through a generated SDK and the `run_code` transport shipped under the name Code Mode, while the client preset that selects it already shipped as \"PTC mode\" (locale `presetPtcName: 'PTC mode'`, zh `PTC \u{6A21}\u{5F0F}`). One feature had two names: config values, plugin and event names, files, and documentation said `code`/`code-mode`, and the user-facing name said \"PTC mode\". A pre-release rename must update every reference together — no compatibility aliases.", "The tool-registry presentation mode that exposes tools through a generated SDK and the `run_code` transport shipped under the name Code Mode, while the client preset that selects it already shipped as \"PTC mode\" (locale `presetPtcName: 'PTC mode'`, locale label `PTC mode`). One feature had two names: config values, plugin and event names, files, and documentation said `code`/`code-mode`, and the user-facing name said \"PTC mode\". A pre-release rename must update every reference together — no compatibility aliases."],
    ['The feature is renamed to PTC (programmatic tool calls). Code identifiers use `ptc` — the transport is not a sibling of plan-mode, so the identifier does not carry `-mode`. User-facing prose keeps "PTC mode" (EN) / "PTC \u{6A21}\u{5F0F}" (zh), matching the shipped preset name.', 'The feature is renamed to PTC (programmatic tool calls). Code identifiers use `ptc` — the transport is not a sibling of plan-mode, so the identifier does not carry `-mode`. User-facing prose keeps "PTC mode" in every locale, matching the shipped preset name.'],
    ['- prose "Code Mode" → "PTC mode" / "PTC \u{6A21}\u{5F0F}" in docs, READMEs, and the eight implemented Agent Notes whose topic names the feature (those files were renamed in place)', '- prose "Code Mode" → "PTC mode" in docs, READMEs, and the eight implemented Agent Notes whose topic names the feature (those files were renamed in place)'],
  ],
  'bug-fix/2026-07-26-intent-draft-same-tick-echo.md': [
    ['A deferred echo violates the controlled-input contract documented on the Notifier (see the [web client architecture note](../architecture/2026-07-19-gui-web-client-architecture.md)): React compares the DOM value against the still-stale snapshot during the same tick as `onChange` and rolls the textarea back. With plain typing this shows as caret jumps; with an IME it corrupts input — every composition update gets rolled back and re-applied against a stale value, so typing Pinyin "nihao" commits fragments like "nnini hni hani hao\u{4F60}\u{597D}". The resident composer (`ConversationRoot`) was not affected: its draft lives in the chat store (sync flush) or comes from `updateSessionPrompt`, which reads the Session snapshot directly rather than the list projection.', 'A deferred echo violates the controlled-input contract documented on the Notifier (see the [web client architecture note](../architecture/2026-07-19-gui-web-client-architecture.md)): React compares the DOM value against the still-stale snapshot during the same tick as `onChange` and rolls the textarea back. With plain typing this shows as caret jumps; with an IME it corrupts input — every composition update gets rolled back and re-applied against a stale value, so typing Pinyin "nihao" commits intermediate fragments like `nnini hni hani hao\\u4F60\\u597D`. The resident composer (`ConversationRoot`) was not affected: its draft lives in the chat store (sync flush) or comes from `updateSessionPrompt`, which reads the Session snapshot directly rather than the list projection.'],
  ],
  'bug-fix/2026-07-28-web-conversation-polish-sweep.md': [
    ['- **The chat flow skips assistant nodes that render nothing.** A finalized assistant node whose blocks are only tool-call heads and blank text/reasoning is dropped from the flow derivation, so consecutive tool results merge into one group. Interrupted nodes always render (they carry the \u{5DF2}\u{505C}\u{6B62} marker).', '- **The chat flow skips assistant nodes that render nothing.** A finalized assistant node whose blocks are only tool-call heads and blank text/reasoning is dropped from the flow derivation, so consecutive tool results merge into one group. Interrupted nodes always render (they carry the Stopped marker).'],
  ],
  'bug-fix/2026-08-11-preset-card-description-clamp.md': [
    ['A roster row that failed its shape check is badged `Failed to load` (`\u{52A0}\u{8F7D}\u{5931}\u{8D25}`) rather than `Broken` (`\u{5DF2}\u{635F}\u{574F}`). Discovery sets `broken` when the composition file is missing, unreadable, or malformed — most often a file the user just edited or deleted — so a damage claim overstates what was observed, and the verbatim reason under the badge already names the file and the fix.', 'A roster row that failed its shape check is badged `Failed to load` rather than `Broken`. Discovery sets `broken` when the composition file is missing, unreadable, or malformed — most often a file the user just edited or deleted — so a damage claim overstates what was observed, and the verbatim reason under the badge already names the file and the fix.'],
  ],
  'bug-fix/2026-08-12-full-session-turn-step-counts.md': [
    ["The web chat stats strip folded `StatsLine`'s loaded conversation window (`deriveStats` over `chat.legacy.nodes`) for every non-token figure: the \"N turns · M steps\" counter, the LLM and tool wall times, and the TTFT/throughput averages. History is paged 50 messages at a time, so each \u{52A0}\u{8F7D}\u{66F4}\u{65E9} (Load earlier) click grew the window and every figure with it — 7 turns · 44 steps became 10 turns · 89 steps after one page, and the LLM duration climbed the same way. The product expectation is whole-session figures independent of how much history a client has loaded. Token accounting in the same strip already had the correct architecture: the durable `tokenUsage` projection.", "The web chat stats strip folded `StatsLine`'s loaded conversation window (`deriveStats` over `chat.legacy.nodes`) for every non-token figure: the \"N turns · M steps\" counter, the LLM and tool wall times, and the TTFT/throughput averages. History is paged 50 messages at a time, so each Load earlier click grew the window and every figure with it — 7 turns · 44 steps became 10 turns · 89 steps after one page, and the LLM duration climbed the same way. The product expectation is whole-session figures independent of how much history a client has loaded. Token accounting in the same strip already had the correct architecture: the durable `tokenUsage` projection."],
  ],
  'bug-fix/2026-08-21-inline-user-text-projection.md': [
    ["Two display gaps in sent user text, both older than the Lexical composer. The user-bubble decorator (`projectUserText`, then private to `MessageItem`) split one message into plain runs and reference chips, but rendered every plain run through the block-level `MessageText` div — so a decorated single-line message broke into one line per run, and the single space between two adjacent tokens rendered as a whole blank line. Separately, the queue dock's read-only row printed `row.preview` verbatim, so a queued message carrying a chip showed the wire session form `@[\u{67E5}\u{770B}\u{5E76}\u{5206}\u{6790}\u{56FE}\u{7247}](dsh-session:InNlc3Npb24t…)` — the model-facing text, unreadable as a preview. The logged model text was correct in both cases (verified against the session log bytes); both defects were presentation only.", "Two display gaps in sent user text, both older than the Lexical composer. The user-bubble decorator (`projectUserText`, then private to `MessageItem`) split one message into plain runs and reference chips, but rendered every plain run through the block-level `MessageText` div — so a decorated single-line message broke into one line per run, and the single space between two adjacent tokens rendered as a whole blank line. Separately, the queue dock's read-only row printed `row.preview` verbatim, so a queued message carrying a chip showed the wire session form `@[View and analyze image](dsh-session:InNlc3Npb24t…)` — the model-facing text, unreadable as a preview. The logged model text was correct in both cases (verified against the session log bytes); both defects were presentation only."],
  ],
  'bug-fix/2026-08-23-win32-utf16-nul-truncation.md': [
    ['`readUtf16` in `packages/host/directory-picker-native/src/win32-dialog-bindings.ts` translated the `IFileOpenDialog` result buffer by scanning for a zero byte with `bytes[end] !== 0`. UTF-16LE encodes NUL as two zero bytes, so any BMP code unit whose low byte is zero — U+XX00, such as \u{5F00} (U+5F00) — ended the scan early. Selecting a folder like `C:\\Users\\XIAOPAN\\Desktop\\\u{5B89}\u{5353}\u{5F00}\u{53D1}` returned `C:\\Users\\XIAOPAN\\Desktop\\\u{5B89}\u{5353}`, and the workspace-creation call failed with `workspace-invalid-path ... ENOENT`.', '`readUtf16` in `packages/host/directory-picker-native/src/win32-dialog-bindings.ts` translated the `IFileOpenDialog` result buffer by scanning for a zero byte with `bytes[end] !== 0`. UTF-16LE encodes NUL as two zero bytes, so any BMP code unit whose low byte is zero — U+XX00, such as U+5F00 (written as \\u5F00) — ended the scan early. Selecting a folder like `C:\\Users\\XIAOPAN\\Desktop\\\\u5B89\\u5353\\u5F00\\u53D1` returned `C:\\Users\\XIAOPAN\\Desktop\\\\u5B89`, and the workspace-creation call failed with `workspace-invalid-path ... ENOENT`.'],
    ['The scan ends only when both bytes of a code unit are zero, still advancing two bytes at a time over the same 32KiB `koffi.view` buffer. A regression test drives `readUtf16` through the existing fake koffi COM world with a path containing \u{5B89}\u{5353}\u{5F00}\u{53D1} (U+5F00), so the termination rule is proven without a real Windows host.', 'The scan ends only when both bytes of a code unit are zero, still advancing two bytes at a time over the same 32KiB `koffi.view` buffer. A regression test drives `readUtf16` through the existing fake koffi COM world with a path containing \\u5B89\\u5353\\u5F00\\u53D1 (U+5F00), so the termination rule is proven without a real Windows host.'],
    ["- Real-dialog rendering and selection remain a manual Windows check; this change's regression test exercises only the byte-to-string translation against the fake COM world. The fixture path is synthetic (`C:\\fixture\\\u{5B89}\u{5353}\u{5F00}\u{53D1}`) so no real user path appears in the repository.", "- Real-dialog rendering and selection remain a manual Windows check; this change's regression test exercises only the byte-to-string translation against the fake COM world. The fixture path is synthetic (`C:\\fixture\\\\u5B89\\u5353\\u5F00\\u53D1`) so no real user path appears in the repository."],
  ],
  'feature/2026-07-23-web-assistant-markdown.md': [
    ["Visual spacing, tables, links, blockquotes, inline code, and code-block chrome follow deepsuite `@deepseek/md` (`markdown.css` / `code-block.css`) and the same `--dsw-alias-markdown-*`, `--dsw-font-markdown-*`, `--dsw-alias-border-l*`, and `--dsw-alias-label-*` tokens. Links use `--dsw-alias-state-business-primary` (deepsuite's sheet uses `--dsw-alias-brand-text`, which is blue only under newDesign; design-platform keeps brand-text near-black and is not retuned here). When one inline-code token consists entirely of an absolute HTTP(S) URL, its code chrome contains the same keyboard-focusable safe external anchor as an ordinary link; port, path, and query text remain unchanged, while commands, partial URLs, other schemes, and fenced code stay inert. `CodeBlock` ships a language banner and a copy control (`\u{590D}\u{5236}` / `\u{590D}\u{5236}\u{6210}\u{529F}`). Finalized text renders KaTeX through the settled grammar's math extensions; `mathCompatibility` maps `\\(...\\)`, `\\[...\\]`, and block-level same-line `$$...$$` to the same standard math AST nodes. This is a narrow parser compatibility layer, not a regex rewrite or malformed-model-output repair. Streaming stays literal until finalization so incomplete formulae do not flash errors. Citation pills, heading anchors, the thinking-small markdown variant, and custom □/☑ task markers remain out of scope; GFM task lists keep native checkboxes.", "Visual spacing, tables, links, blockquotes, inline code, and code-block chrome follow deepsuite `@deepseek/md` (`markdown.css` / `code-block.css`) and the same `--dsw-alias-markdown-*`, `--dsw-font-markdown-*`, `--dsw-alias-border-l*`, and `--dsw-alias-label-*` tokens. Links use `--dsw-alias-state-business-primary` (deepsuite's sheet uses `--dsw-alias-brand-text`, which is blue only under newDesign; design-platform keeps brand-text near-black and is not retuned here). When one inline-code token consists entirely of an absolute HTTP(S) URL, its code chrome contains the same keyboard-focusable safe external anchor as an ordinary link; port, path, and query text remain unchanged, while commands, partial URLs, other schemes, and fenced code stay inert. `CodeBlock` ships a language banner and a copy control (`Copy` / `Copied`). Finalized text renders KaTeX through the settled grammar's math extensions; `mathCompatibility` maps `\\(...\\)`, `\\[...\\]`, and block-level same-line `$$...$$` to the same standard math AST nodes. This is a narrow parser compatibility layer, not a regex rewrite or malformed-model-output repair. Streaming stays literal until finalization so incomplete formulae do not flash errors. Citation pills, heading anchors, the thinking-small markdown variant, and custom □/☑ task markers remain out of scope; GFM task lists keep native checkboxes."],
  ],
  'feature/2026-07-26-todo-parallel-in-progress.md': [
    ["Lifting the cap makes a list shape reachable that no renderer had ever received, so this change builds on the [web todo display](2026-07-23-web-todo-display.md) rather than landing beside it: both change `tool-todo`, and the GUI is where a parallel plan becomes visible. Two web sites derived their one-line summary with `todos.find(t => t.status === 'in_progress')` — the collapsed plan-strip header and the `todo_write` row — and under the old cap that `find` was total, since at most one item could match. With several active it silently dropped every active item but the first: a four-item plan with three running tasks collapsed to the name of one, and the row read `1/4 \u{5DF2}\u{5B8C}\u{6210} · <one task>` while two others were in flight. The expanded list was always correct (it maps every item), which is why neither change's tests caught it — only the collapsed header and the row lost information. The panel redesign replaced the collapsed header's named hint with `·`-joined per-status counts (localized, `1 completed · 2 in progress · 1 pending`, zero-count segments omitted), which reports parallel work correctly and needs no name to truncate; the row is the one site this change still had to fix.", "Lifting the cap makes a list shape reachable that no renderer had ever received, so this change builds on the [web todo display](2026-07-23-web-todo-display.md) rather than landing beside it: both change `tool-todo`, and the GUI is where a parallel plan becomes visible. Two web sites derived their one-line summary with `todos.find(t => t.status === 'in_progress')` — the collapsed plan-strip header and the `todo_write` row — and under the old cap that `find` was total, since at most one item could match. With several active it silently dropped every active item but the first: a four-item plan with three running tasks collapsed to the name of one, and the row read `1/4 completed · <one task>` while two others were in flight. The expanded list was always correct (it maps every item), which is why neither change's tests caught it — only the collapsed header and the row lost information. The panel redesign replaced the collapsed header's named hint with `·`-joined per-status counts (localized, `1 completed · 2 in progress · 1 pending`, zero-count segments omitted), which reports parallel work correctly and needs no name to truncate; the row is the one site this change still had to fix."],
    ["Two known gaps are deferred. The `summarySuffix` span carries no accessible name, so a screen reader reads the count without its noun (`… \u{5B9E}\u{73B0} fixture \u{6837}\u{672C} +1`); naming it introduces localized copy with its own test contract, which belongs to an accessibility pass over the whole `ToolRow` summary line rather than to one row. And when the *first* active item's content is unusable — missing, mistyped, or blank once trimmed — the row drops the active clause and the count with it, so a parallel plan renders as bare counts; skipping forward to the first usable active item was rejected because call args are an explicitly unvalidated boundary where model order is the only ordering the row can honour, and dropping the unusable clause alone keeps the `done`/`total` counts, which are trustworthy regardless.", "Two known gaps are deferred. The `summarySuffix` span carries no accessible name, so a screen reader reads the count without its noun (`… in-progress fixture sample +1`); naming it introduces localized copy with its own test contract, which belongs to an accessibility pass over the whole `ToolRow` summary line rather than to one row. And when the *first* active item's content is unusable — missing, mistyped, or blank once trimmed — the row drops the active clause and the count with it, so a parallel plan renders as bare counts; skipping forward to the first usable active item was rejected because call args are an explicitly unvalidated boundary where model order is the only ordering the row can honour, and dropping the unusable clause alone keeps the `done`/`total` counts, which are trustworthy regardless."],
  ],
  'feature/2026-07-27-web-session-search.md': [
    ["Content matching inherits the SQLite backend's normalized literal token/phrase semantics. The shared semantic projection excludes reasoning blocks, so UI search never returns a model's private reasoning as a hit or snippet; the derived-index schema version advances so existing persistent indexes rebuild without the former documents. FTS5 operators are inert data, and this surface adds no typo, fuzzy, prefix, or arbitrary-substring expansion. In particular, the `unicode61` tokenizer may treat an uninterrupted Chinese sequence as one token, so a shorter query such as `\u{641C}\u{7D22}` is not guaranteed to match inside `\u{4F1A}\u{8BDD}\u{641C}\u{7D22}\u{529F}\u{80FD}`. Title and Workspace matching remains ordinary client-side substring matching.", "Content matching inherits the SQLite backend's normalized literal token/phrase semantics. The shared semantic projection excludes reasoning blocks, so UI search never returns a model's private reasoning as a hit or snippet; the derived-index schema version advances so existing persistent indexes rebuild without the former documents. FTS5 operators are inert data, and this surface adds no typo, fuzzy, prefix, or arbitrary-substring expansion. In particular, the `unicode61` tokenizer may treat an uninterrupted CJK sequence as one token, so a shorter query such as `\\u641C\\u7D22` is not guaranteed to match inside `\\u4F1A\\u8BDD\\u641C\\u7D22\\u529F\\u80FD`. Title and Workspace matching remains ordinary client-side substring matching."],
  ],
  'feature/2026-07-29-addressable-queue-operations.md': [
    ['**Web actions address Queue only.** The Host excludes pending steering from `session/queue`; steering retains its existing durable transcript path after consumption. QueueDock hides while empty, renders one pending occurrence directly, and defaults two or more occurrences to a collapsed `"<n> \u{6761}\u{6392}\u{961F}\u{6D88}\u{606F}"` header that expands or collapses the complete list. The header exposes `aria-expanded` and `aria-controls`; the expanded list scrolls within a 180px height bound. An active edit or mutation keeps its rows visible, and emptying the queue restores the collapsed default for the next queue. Visible rows expose edit and delete, but no send-now control. The UI derives queue row and mutation types from the runtime `SessionFace` contract rather than importing the connection plugin, so plugin cooperation continues through services and snapshots. Edit is available only when all content blocks are text; the editor cannot silently drop non-text blocks. An editing row exposes only save and cancel, with Enter and Escape as their keyboard equivalents. Delete removes the exact occurrence.', '**Web actions address Queue only.** The Host excludes pending steering from `session/queue`; steering retains its existing durable transcript path after consumption. QueueDock hides while empty, renders one pending occurrence directly, and defaults two or more occurrences to a collapsed `"<n> queued messages"` header that expands or collapses the complete list. The header exposes `aria-expanded` and `aria-controls`; the expanded list scrolls within a 180px height bound. An active edit or mutation keeps its rows visible, and emptying the queue restores the collapsed default for the next queue. Visible rows expose edit and delete, but no send-now control. The UI derives queue row and mutation types from the runtime `SessionFace` contract rather than importing the connection plugin, so plugin cooperation continues through services and snapshots. Edit is available only when all content blocks are text; the editor cannot silently drop non-text blocks. An editing row exposes only save and cancel, with Enter and Escape as their keyboard equivalents. Delete removes the exact occurrence.'],
  ],
  'feature/2026-07-29-ask-question-web-presentation.md': [
    ['Separately, the composer visuals had drifted from the current design: an expand-to-open custom answer entry, no multi-select affordance beyond a trailing check, header-mounted paging, and a `（\u{53EF}\u{591A}\u{9009}）` title-suffix convention parsed out of model text.', 'Separately, the composer visuals had drifted from the current design: an expand-to-open custom answer entry, no multi-select affordance beyond a trailing check, header-mounted paging, and a `(multi-select)` title-suffix convention parsed out of model text.'],
    ['**Keep the title-suffix multi-select convention.** Rejected: `multi_select` is structured request metadata and the checkbox affordance now carries the signal, so parsing `（\u{53EF}\u{591A}\u{9009}）` out of model text was a fragile duplicate channel.', '**Keep the title-suffix multi-select convention.** Rejected: `multi_select` is structured request metadata and the checkbox affordance now carries the signal, so parsing `(multi-select)` out of model text was a fragile duplicate channel.'],
  ],
  'feature/2026-07-29-web-message-icon-actions-and-clock.md': [
    ["Both seats format `node.time` through `formatMessageClock`: same calendar day → `HH:mm`, earlier this year → `M\u{6708}D\u{65E5} HH:mm`, other years → `YYYY\u{5E74}M\u{6708}D\u{65E5} HH:mm`. `useCalendarDay` is a component-local day tick (timeout to the next local midnight) so memoized rows re-render when the calendar day changes without a new framework hook. `MessageItem` places the label before copy (figma `388:20051`). `ChatView` derives turn-tail seqs via `assistantActionsSeqs` and withholds `time` for mid-turn content; `AssistantMarkdown` places the row after branch (figma `43:32997`) only when `streaming` is false, the event time is known, and the node has non-empty text content. Think-only nodes, mid-turn narration, and the streaming tail omit the row. Copy writes joined text blocks. Both message rows pass their event's `seq` to the same fork callback; [Web session fork actions](2026-07-27-web-session-fork-actions.md) define the real mutation contract. Clipboard write and the clock helpers live in `message-chrome.ts`. The assembled surface is pinned by `apps/web/tests/message-actions.e2e.ts` (cold-seeded history + aria golden); aria normalization collapses every clock shape to `{{clock}}`.", "Both seats format `node.time` through `formatMessageClock`: same calendar day → `HH:mm`, earlier this year → `M/D HH:mm`, other years → `YYYY-MM-DD HH:mm`. `useCalendarDay` is a component-local day tick (timeout to the next local midnight) so memoized rows re-render when the calendar day changes without a new framework hook. `MessageItem` places the label before copy (figma `388:20051`). `ChatView` derives turn-tail seqs via `assistantActionsSeqs` and withholds `time` for mid-turn content; `AssistantMarkdown` places the row after branch (figma `43:32997`) only when `streaming` is false, the event time is known, and the node has non-empty text content. Think-only nodes, mid-turn narration, and the streaming tail omit the row. Copy writes joined text blocks. Both message rows pass their event's `seq` to the same fork callback; [Web session fork actions](2026-07-27-web-session-fork-actions.md) define the real mutation contract. Clipboard write and the clock helpers live in `message-chrome.ts`. The assembled surface is pinned by `apps/web/tests/message-actions.e2e.ts` (cold-seeded history + aria golden); aria normalization collapses every clock shape to `{{clock}}`."],
  ],
  'feature/2026-07-30-plan-review-presentation-intent.md': [
    ['Every one of those affordances is wrong for the surface. Reviewing a plan is one decision over one document, and the quiz chrome told the user they were being examined rather than asked to approve work — reported as "\u{8BA9}\u{4EBA}\u{5F88}\u{56F0}\u{60D1}\u{4EE5}\u{4E3A}\u{5728}\u{505A}\u{9898}". The paging controls page a set of one. Skipping is not an outcome the tool accepts (it folds into keep-planning). Worst, the surface gave no hint that this was the plan gate at all, while the adjacent waiting-approval takeover already had exactly the right shape for a decision: a tinted strip naming what is being decided, the subject as the body, and a right-aligned action row.', 'Every one of those affordances is wrong for the surface. Reviewing a plan is one decision over one document, and the quiz chrome told the user they were being examined rather than asked to approve work — reported as "It was confusing and looked like a quiz". The paging controls page a set of one. Skipping is not an outcome the tool accepts (it folds into keep-planning). Worst, the surface gave no hint that this was the plan gate at all, while the adjacent waiting-approval takeover already had exactly the right shape for a decision: a tinted strip naming what is being decided, the subject as the body, and a right-aligned action row.'],
  ],
  'feature/2026-07-30-web-context-injection-disclosure.md': [
    ["`MessageItem` routes context nodes to `ContextInjectionRow`. The row starts collapsed, names the presentation `\u{4E0A}\u{4E0B}\u{6587}\u{6CE8}\u{5165}`, uses the existing browse glyph, and exposes the whole 24px header as one pointer and keyboard disclosure target. Its expanded body begins 4px below the header at the shared 22px content indent and renders the design's 141px scrollport with 8px radius, code-block background, 11/16 code text, and no border.", "`MessageItem` routes context nodes to `ContextInjectionRow`. The row starts collapsed, names the presentation `Context injection`, uses the existing browse glyph, and exposes the whole 24px header as one pointer and keyboard disclosure target. Its expanded body begins 4px below the header at the shared 22px content indent and renders the design's 141px scrollport with 8px radius, code-block background, 11/16 code text, and no border."],
  ],
  'feature/2026-07-30-web-queue-steer-action.md': [
    ["Each non-editing ordinary-session QueueDock row exposes the upward-arrow action as “\u{63D2}\u{8BDD}\u{53D1}\u{9001}”. The action is enabled only while the session reports a running agent; mixed-content messages remain eligible because steering forwards the complete immutable `UserMessage` rather than the row's text projection. An addressed subagent keeps its Queue projection read-only because its continuation transport does not expose queue mutation.", "Each non-editing ordinary-session QueueDock row exposes the upward-arrow action as “Steer message”. The action is enabled only while the session reports a running agent; mixed-content messages remain eligible because steering forwards the complete immutable `UserMessage` rather than the row's text projection. An addressed subagent keeps its Queue projection read-only because its continuation transport does not expose queue mutation."],
  ],
  'feature/2026-07-30-web-result-card-frontend.md': [
    ['One component draws both kinds, discriminated by `kind`. A `search` shows the answer as markdown above a citation list; each source is a safe external link labelled by its title, or its hostname when the provider gave none, with the snippet and publication date below it, and a `\u{6765}\u{6E90}\u{5217}\u{8868}\u{5DF2}\u{622A}\u{65AD}` indicator when the tool capped the list. A `fetch` shows a compact summary: the linked final URL, its HTTP status, and a `\u{5185}\u{5BB9}\u{5DF2}\u{622A}\u{65AD}` indicator. One component rather than two because both are web retrieval rendered as one card family, which is exactly the reason the contract carries them under one `card` tag with a `kind` discriminant.', 'One component draws both kinds, discriminated by `kind`. A `search` shows the answer as markdown above a citation list; each source is a safe external link labelled by its title, or its hostname when the provider gave none, with the snippet and publication date below it, and a `Source list truncated` indicator when the tool capped the list. A `fetch` shows a compact summary: the linked final URL, its HTTP status, and a `Content truncated` indicator. One component rather than two because both are web retrieval rendered as one card family, which is exactly the reason the contract carries them under one `card` tag with a `kind` discriminant.'],
  ],
  'feature/2026-07-30-web-search-card.md': [
    ['- **A capped indicator.** When `truncated`, the banner summary folds the pre-cap total in — `\u{663E}\u{793A} X / \u{5171} N \u{5904}\u{5339}\u{914D} · K \u{4E2A}\u{6587}\u{4EF6}` for grep, `\u{663E}\u{793A} X / \u{5171} N \u{4E2A}\u{8DEF}\u{5F84}` for glob — so the card never presents a capped page as the complete result. When not `truncated` the summary is a plain structural count (`{n} \u{5904}\u{5339}\u{914D} · {m} \u{4E2A}\u{6587}\u{4EF6}`, or `{n} \u{4E2A}\u{8DEF}\u{5F84}`).', '- **A capped indicator.** When `truncated`, the banner summary folds the pre-cap total in — `Showing X / N total matches · K files` for grep, `Showing X / N total paths` for glob — so the card never presents a capped page as the complete result. When not `truncated` the summary is a plain structural count (`{n} matches · {m} files`, or `{n} paths`).'],
  ],
  'feature/2026-07-31-gui-full-access-confirmation.md': [
    ["- Canonical built-in preset names render through each picker's locale dictionary (`Full access` in English and `\u{5B8C}\u{5168}\u{6743}\u{9650}` in Chinese), while explicit host labels remain unchanged. Command and Settings writes keep the machine name on the wire, and each warning body remains locale-aware in Chinese and English.", "- Canonical built-in preset names render through each picker's locale dictionary (`Full access` in English and the same English label in the English-only build), while explicit host labels remain unchanged. Command and Settings writes keep the machine name on the wire, and each warning body remains locale-aware in the supported locale."],
  ],
  'feature/2026-07-31-hover-card-click-copy.md': [
    ["The Workspace browser chooses the payload rather than making the primitive infer it from rendered text: a Workspace card passes the full directory path, and a non-blank Session card passes the full display title. A provisional blank New Session card remains read-only because its localized label is a placeholder, not session content. The browser's locale seat supplies `Copy`/`\u{590D}\u{5236}` and the success state `Copied`/`\u{5DF2}\u{590D}\u{5236}`.", "The Workspace browser chooses the payload rather than making the primitive infer it from rendered text: a Workspace card passes the full directory path, and a non-blank Session card passes the full display title. A provisional blank New Session card remains read-only because its localized label is a placeholder, not session content. The browser's locale seat supplies `Copy` and the success state `Copied`."],
    ['**Change the common Chinese `copied` label from `\u{590D}\u{5236}\u{6210}\u{529F}` to `\u{5DF2}\u{590D}\u{5236}`.** That would alter every existing copy control to satisfy one card interaction. The Workspace dictionary owns the card-specific wording instead.', '**Change the common `copied` label from `Copy succeeded` to `Copied`.** That would alter every existing copy control to satisfy one card interaction. The Workspace dictionary owns the card-specific wording instead.'],
  ],
  'feature/2026-08-03-web-search-source-scroll.md': [
    ["The `web_search` result card (`WebBlock`, `packages/client/ui-primitives/src/WebBlock.tsx`) rendered its source list with a head/tail collapse: past a `maxSources` count (16 in the details panel, 8 in the chat row via `CHAT_WEB_MAX_SOURCES`) it drew the first `ceil(max/2)` sources, an `… \u{5176}\u{4F59} N \u{6761}\u{6765}\u{6E90}` expand button, then the last `max - ceil(max/2)`, mirroring `TerminalBlock`'s output cap. A user reading the card saw `\u{6765}\u{6E90}\u{5217}\u{8868}\u{5DF2}\u{622A}\u{65AD}` and assumed the frontend had dropped sources it was holding.", "The `web_search` result card (`WebBlock`, `packages/client/ui-primitives/src/WebBlock.tsx`) rendered its source list with a head/tail collapse: past a `maxSources` count (16 in the details panel, 8 in the chat row via `CHAT_WEB_MAX_SOURCES`) it drew the first `ceil(max/2)` sources, an `… remaining N sources` expand button, then the last `max - ceil(max/2)`, mirroring `TerminalBlock`'s output cap. A user reading the card saw `Source list truncated` and assumed the frontend had dropped sources it was holding."],
    ['The model side remains capped at `searchMaxResults`: the seam caps each provider result, the multi-query consumer caps a combined list, and the `truncated` flag and its `\u{6765}\u{6E90}\u{5217}\u{8868}\u{5DF2}\u{622A}\u{65AD}` indicator stay. The card draws the final tool source list in full and scrollable, instead of collapsing its middle.', 'The model side remains capped at `searchMaxResults`: the seam caps each provider result, the multi-query consumer caps a combined list, and the `truncated` flag and its `Source list truncated` indicator stay. The card draws the final tool source list in full and scrollable, instead of collapsing its middle.'],
    ["Every source the tool returned is always in the DOM, so no source the view carries is hidden behind an interaction. The card's height is bounded regardless of source count, and a list taller than the container scrolls in place. The cost is that the scroll affordance depends on the platform's scrollbar rendering: an overlay-scrollbar system (macOS default) shows no persistent bar when the pointer is away, so a capped list relies on the `\u{6765}\u{6E90}\u{5217}\u{8868}\u{5DF2}\u{622A}\u{65AD}` note plus a clipped last row to signal there is more. `WebSearchBlockProps`/`WebFetchBlockProps` lose their `maxSources` prop and the primitive loses `DEFAULT_WEB_MAX_SOURCES`, so any future caller renders the full list by construction rather than by passing a large cap.", "Every source the tool returned is always in the DOM, so no source the view carries is hidden behind an interaction. The card's height is bounded regardless of source count, and a list taller than the container scrolls in place. The cost is that the scroll affordance depends on the platform's scrollbar rendering: an overlay-scrollbar system (macOS default) shows no persistent bar when the pointer is away, so a capped list relies on the `Source list truncated` note plus a clipped last row to signal there is more. `WebSearchBlockProps`/`WebFetchBlockProps` lose their `maxSources` prop and the primitive loses `DEFAULT_WEB_MAX_SOURCES`, so any future caller renders the full list by construction rather than by passing a large cap."],
    ["jsdom resolves no CSS Modules layout, so it reports `scrollHeight === clientHeight` for every element and cannot witness the scroll at all. The geometry is pinned in the assembled browser instead, by `apps/web/tests/web-search-round.e2e.ts`: its deterministic search double returns 6 results for each of two queries, each with a title, a citation snippet, and a date. The real composition observes both provider requests and pins the tool's round-robin combined cap — the shipped `searchMaxResults` keeps 8 sources representing both queries, the model-visible render text omits the 4 dropped URLs and includes `(Showing the first 8 sources. Refine the query for more.)`, and `meta.truncated` is true. A case after the aria golden then expands the `web_search` row and asserts on the card's `<ol>`: 8 `<li>`, no `<button>` anywhere in the card, the `\u{6765}\u{6E90}\u{5217}\u{8868}\u{5DF2}\u{622A}\u{65AD}` indicator visible, and computed `max-height: 320px` with `overflow-y: auto` over a taller scroll body. A further case measures a `999. ` marker in the list's own inherited font and requires the computed `padding-left` to be at least that wide, so the marker room the scroll container cannot clip back is pinned against the widest marker rather than against one fixture's source count. Replay is a positional cursor over the fixture's embedded Assistant settlements, and the search double is a separate local endpoint the provider reaches by `fetch`.", "jsdom resolves no CSS Modules layout, so it reports `scrollHeight === clientHeight` for every element and cannot witness the scroll at all. The geometry is pinned in the assembled browser instead, by `apps/web/tests/web-search-round.e2e.ts`: its deterministic search double returns 6 results for each of two queries, each with a title, a citation snippet, and a date. The real composition observes both provider requests and pins the tool's round-robin combined cap — the shipped `searchMaxResults` keeps 8 sources representing both queries, the model-visible render text omits the 4 dropped URLs and includes `(Showing the first 8 sources. Refine the query for more.)`, and `meta.truncated` is true. A case after the aria golden then expands the `web_search` row and asserts on the card's `<ol>`: 8 `<li>`, no `<button>` anywhere in the card, the `Source list truncated` indicator visible, and computed `max-height: 320px` with `overflow-y: auto` over a taller scroll body. A further case measures a `999. ` marker in the list's own inherited font and requires the computed `padding-left` to be at least that wide, so the marker room the scroll container cannot clip back is pinned against the widest marker rather than against one fixture's source count. Replay is a positional cursor over the fixture's embedded Assistant settlements, and the search double is a separate local endpoint the provider reaches by `fetch`."],
  ],
  'feature/2026-08-04-web-context-source-and-steer-marks.md': [
    ['Everything a producer adds to the model-facing conversation reached the Web transcript as one of two anonymous shapes. Every logged non-user `user/message` — the skill catalog, the runtime snapshot, reconciled `AGENTS.md` instructions, a guard notice, a subagent report, a cross-session snapshot — collapsed into one identical `\u{4E0A}\u{4E0B}\u{6587}\u{6CE8}\u{5165}` row, so a reader could not tell what had been added without expanding each row and reading raw JSON. Mid-turn steering was worse: it rendered in exactly the bubble a turn-opening prompt uses, leaving the transcript unable to say which message interrupted a running turn.', 'Everything a producer adds to the model-facing conversation reached the Web transcript as one of two anonymous shapes. Every logged non-user `user/message` — the skill catalog, the runtime snapshot, reconciled `AGENTS.md` instructions, a guard notice, a subagent report, a cross-session snapshot — collapsed into one identical `Context injection` row, so a reader could not tell what had been added without expanding each row and reading raw JSON. Mid-turn steering was worse: it rendered in exactly the bubble a turn-opening prompt uses, leaving the transcript unable to say which message interrupted a running turn.'],
    ["`MessageItem` captions durable and pending steering bubbles with `\u{63D2}\u{8BDD}`. The Chat Inbox and Message Definitions replay durable `agent/inbox/spliced` events and project a user-origin `user/message` as `SteeringMessageNode` when that same message identity was claimed from `next-step`; a queued-turn claim stays a `UserMessageNode`, and a non-user next-step message stays context. This reverses one clause of the [archived no-steer decision](../../archived/simplification/2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md), which removed the badge because the composer could not steer and the label named a gesture users could not perform. The composer gained a Steer gesture afterwards without amending that note; this decision supplies the product decision its reintroduction clause required, and corrects the stale facts left in it. The caption is the only steering chrome here: composer modes, the Queue dock's strict-steer action, and pending-steering lifecycle stay with their own owners.", "`MessageItem` captions durable and pending steering bubbles with `Steering`. The Chat Inbox and Message Definitions replay durable `agent/inbox/spliced` events and project a user-origin `user/message` as `SteeringMessageNode` when that same message identity was claimed from `next-step`; a queued-turn claim stays a `UserMessageNode`, and a non-user next-step message stays context. This reverses one clause of the [archived no-steer decision](../../archived/simplification/2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md), which removed the badge because the composer could not steer and the label named a gesture users could not perform. The composer gained a Steer gesture afterwards without amending that note; this decision supplies the product decision its reintroduction clause required, and corrects the stale facts left in it. The caption is the only steering chrome here: composer modes, the Queue dock's strict-steer action, and pending-steering lifecycle stay with their own owners."],
    ['- **Superseded in part.** The steering-caption clause of the Decision no longer describes master: the [caption removal](../simplification/2026-08-10-web-remove-steering-interjection-caption.md) deleted the `\u{63D2}\u{8BDD}` / `Interjection` caption, leaving a mid-turn steer recognizable only by its position in the flow. The context-source and recall naming in the Decision stays current, and the `SteeringMessageNode` projection is unchanged.', '- **Superseded in part.** The steering-caption clause of the Decision no longer describes master: the [caption removal](../simplification/2026-08-10-web-remove-steering-interjection-caption.md) deleted the `Interjection` caption, leaving a mid-turn steer recognizable only by its position in the flow. The context-source and recall naming in the Decision stays current, and the `SteeringMessageNode` projection is unchanged.'],
  ],
  'feature/2026-08-04-web-latency-throughput-metrics.md': [
    ["The assistant footer appends the readings to the existing hover-revealed time chrome after `Ran for`, as `TTFT {s}s · {tps} tok/s`, each omitted independently when unrecorded. ChatView shows a turn's readings only when that turn's `turnTimings` entry has an `endTime`: the loaded window is a contiguous log suffix, so an in-window settled turn carries every one of its steps and the first-step TTFT is genuine rather than a window artifact. `formatLatencySeconds` is unit-less so each locale template owns its second suffix (`TTFT {seconds}s` / `\u{9996} token {seconds}\u{79D2}`).", "The assistant footer appends the readings to the existing hover-revealed time chrome after `Ran for`, as `TTFT {s}s · {tps} tok/s`, each omitted independently when unrecorded. ChatView shows a turn's readings only when that turn's `turnTimings` entry has an `endTime`: the loaded window is a contiguous log suffix, so an in-window settled turn carries every one of its steps and the first-step TTFT is genuine rather than a window artifact. `formatLatencySeconds` is unit-less so each locale template owns its second suffix (`TTFT {seconds}s` in the English-only build)."],
  ],
  'feature/2026-08-05-per-agent-tool-presentation.md': [
    ["Agent presets compose an agent's tools per session, but not the FORM those tools reach the model in. PTC mode — one `run_code` tool plus a generated TypeScript SDK, replacing a call sequence with one program — was a deployment-wide `mode` field on the host's `dsh-tools` row. A deployment either ran every session in PTC mode or none, so the obvious product shape (\"\u{4EE3}\u{7801}\u{6A21}\u{5F0F}\" beside \u{6807}\u{51C6}/\u{6781}\u{7B80}/\u{521B}\u{9020} in the preset picker) had nothing to hang on.", "Agent presets compose an agent's tools per session, but not the FORM those tools reach the model in. PTC mode — one `run_code` tool plus a generated TypeScript SDK, replacing a call sequence with one program — was a deployment-wide `mode` field on the host's `dsh-tools` row. A deployment either ran every session in PTC mode or none, so the obvious product shape (\"Code mode\" beside Standard/Minimal/Creative in the preset picker) had nothing to hang on."],
    ['The shipped roster is four presets (\u{6807}\u{51C6}/\u{4EE3}\u{7801}/\u{6781}\u{7B80}/\u{521B}\u{9020}), so any golden listing them moves. A deployment that composes no code runtime can compose no ptc preset; the shipped Web overlay carries one, the base composition does not.', 'The shipped roster is four presets (Standard/Code/Minimal/Creative), so any golden listing them moves. A deployment that composes no code runtime can compose no ptc preset; the shipped Web overlay carries one, the base composition does not.'],
  ],
  'feature/2026-08-05-web-preview-product-badge.md': [
    ['The empty hero always renders a localized `Preview` / `\u{9884}\u{89C8}\u{7248}` badge beneath the headline. It has no configuration switch: preview status is one product identity shared by every deployment, not a deployment-varying tunable.', 'The empty hero always renders a `Preview` badge beneath the headline. It has no configuration switch: preview status is one product identity shared by every deployment, not a deployment-varying tunable.'],
  ],
  'feature/2026-08-06-session-completed-done-dot.md': [
    ['`SessionManager` owns a client-side completion-reminder set, a sibling of the pending-interaction bit: a running→idle edge of a session that is not the selected one arms its reminder; `select()`/`selectSubagent()` consume it; starting a new run disarms it and its completion re-arms it; removal prunes it. The bit rides `SessionListEntry` → `SessionSummary` (optional, absent = no reminder) into the workspace browser, whose session and search rows render the existing `StateDot` `done` state — running keeps the ongoing spinner, an idle session without a reminder shows nothing — and whose hover card labels the reminder \u{5DF2}\u{5B8C}\u{6210} / Completed.', '`SessionManager` owns a client-side completion-reminder set, a sibling of the pending-interaction bit: a running→idle edge of a session that is not the selected one arms its reminder; `select()`/`selectSubagent()` consume it; starting a new run disarms it and its completion re-arms it; removal prunes it. The bit rides `SessionListEntry` → `SessionSummary` (optional, absent = no reminder) into the workspace browser, whose session and search rows render the existing `StateDot` `done` state — running keeps the ongoing spinner, an idle session without a reminder shows nothing — and whose hover card labels the reminder Completed.'],
  ],
  'feature/2026-08-06-web-queue-steer-all-gesture.md': [
    ['While a primary session runs, the Web queue accumulates messages the user typed with plain Enter (or queued while the busy-Enter preference was Queue). Flushing them into the current turn required clicking the per-row \u{63D2}\u{8BDD}\u{53D1}\u{9001} button once per message; an empty composer draft had no keyboard gesture at all — the input machine rejects empty drafts, so Enter and Cmd/Ctrl+Enter were both no-ops. With several queued messages, steering them one by one is the obvious multi-click friction, and the empty-draft accelerated chord is the natural slot for "steer everything".', 'While a primary session runs, the Web queue accumulates messages the user typed with plain Enter (or queued while the busy-Enter preference was Queue). Flushing them into the current turn required clicking the per-row Steer message button once per message; an empty composer draft had no keyboard gesture at all — the input machine rejects empty drafts, so Enter and Cmd/Ctrl+Enter were both no-ops. With several queued messages, steering them one by one is the obvious multi-click friction, and the empty-draft accelerated chord is the natural slot for "steer everything".'],
    ["Empty-draft Cmd/Ctrl+Enter now steers every still-pending `queued`-placement inbox row into the running turn, in FIFO order, on a primary session that reports running. The gesture decodes in `InputBar.onKeyDown`: accelerated Enter with a trimmed-empty draft, `running`, no subagent address, and at least one `queued` row calls the new `ComposerKeyboard.steerQueue()` verb instead of `submit()`. `SessionInputShell.steerQueue()` delegates to a hub-wired choreography that re-reads the authoritative `session/queue` snapshot, filters `placement: 'queued'` (pending steering rows are already in the turn), and applies the queue dock's exact strict-steer operation — `session.updateQueue(itemId, { kind: 'steer' })` — sequentially, so FIFO ordering is guaranteed at the host. A `steer-unavailable` (turn closed mid-flush) or `queue-item-not-found` (row claimed meanwhile) converges silently; any other failure surfaces one composer notice (`\u{63D2}\u{8BDD}\u{53D1}\u{9001}\u{5931}\u{8D25}，\u{8BF7}\u{91CD}\u{8BD5}\u{3002}`). No wire, on-disk, or agent-loop change: the host already owns the strict-steer boundary.", "Empty-draft Cmd/Ctrl+Enter now steers every still-pending `queued`-placement inbox row into the running turn, in FIFO order, on a primary session that reports running. The gesture decodes in `InputBar.onKeyDown`: accelerated Enter with a trimmed-empty draft, `running`, no subagent address, and at least one `queued` row calls the new `ComposerKeyboard.steerQueue()` verb instead of `submit()`. `SessionInputShell.steerQueue()` delegates to a hub-wired choreography that re-reads the authoritative `session/queue` snapshot, filters `placement: 'queued'` (pending steering rows are already in the turn), and applies the queue dock's exact strict-steer operation — `session.updateQueue(itemId, { kind: 'steer' })` — sequentially, so FIFO ordering is guaranteed at the host. A `steer-unavailable` (turn closed mid-flush) or `queue-item-not-found` (row claimed meanwhile) converges silently; any other failure surfaces one composer notice (`Steer failed; retry.`). No wire, on-disk, or agent-loop change: the host already owns the strict-steer boundary."],
    ['The per-row \u{63D2}\u{8BDD}\u{53D1}\u{9001} action and its strict-steer boundary are owned by [Steer a queued Web message into the active turn](../feature/2026-07-30-web-queue-steer-action.md); this note only adds the whole-queue keyboard gesture on top of that decision.', 'The per-row Steer message action and its strict-steer boundary are owned by [Steer a queued Web message into the active turn](../feature/2026-07-30-web-queue-steer-action.md); this note only adds the whole-queue keyboard gesture on top of that decision.'],
  ],
  'feature/2026-08-10-web-session-log-export.md': [
    ['- Fixture mode (no host) answers 404 for the export, which the browser reports as a failed download; the navigation-panes golden snapshot includes the \u{5BFC}\u{51FA} button.', '- Fixture mode (no host) answers 404 for the export, which the browser reports as a failed download; the navigation-panes golden snapshot includes the Export button.'],
  ],
  'feature/2026-08-18-settings-font-size-control.md': [
    ["The conversation's body text size was fixed (14px after the 0.875 markdown-ladder rescale). Users asked for a Settings control: a \"\u{5B57}\u{53F7}\u{5927}\u{5C0F}\" row under General → Appearance with a stepper, range 12–17, default 14, that resizes the transcript body text and the composer input text together.", "The conversation's body text size was fixed (14px after the 0.875 markdown-ladder rescale). Users asked for a Settings control: a \"Font size\" row under General → Appearance with a stepper, range 12–17, default 14, that resizes the transcript body text and the composer input text together."],
  ],
  'feature/2026-08-20-web-streaming-fence-highlight.md': [
    ["**Highlight only frozen (closed, settled-position) fences during streaming.** Bounded cost, but an unclosed fence pins the incremental parser's tail, so the actively growing fence — the one on screen — would stay plain until the reply finishes, failing the issue's \"\u{8BC6}\u{522B}\u{8BED}\u{8A00}\u{540E}\u{5373}\u{53EF}\u{589E}\u{91CF}\u{9AD8}\u{4EAE}\".", "**Highlight only frozen (closed, settled-position) fences during streaming.** Bounded cost, but an unclosed fence pins the incremental parser's tail, so the actively growing fence — the one on screen — would stay plain until the reply finishes, failing the issue's \"highlight incrementally once the language is recognized\"."],
  ],
  'feature/2026-08-25-unified-task-list.md': [
    ['- **User-facing vocabulary is "task" (\u{4EFB}\u{52A1})** — `N tasks running` / `N \u{4E2A}\u{4EFB}\u{52A1}\u{8FDB}\u{884C}\u{4E2D}` — because every row is running work to the user, while "background job" excludes workflow runs and "activity" names the internal plane, not the user concept. The dictionary namespace and package names stay `activity`: internal names follow the naming ledger, not display copy.', '- **User-facing vocabulary is "task"** — `N tasks running` — because every row is running work to the user, while "background job" excludes workflow runs and "activity" names the internal plane, not the user concept. The dictionary namespace and package names stay `activity`: internal names follow the naming ledger, not display copy.'],
  ],
  'feature/2026-08-26-web-trigger-menu-presentation-polish.md': [
    ['Candidate rows lead with a domain icon instead of a text prefix: `InputTriggerCandidate.icon` narrows from `string` to the closed union `InputTriggerCandidateIcon` (`file | folder | session`), the menu view maps it to `ReferenceIcon`, and `ui-reference` emits bare names (`folderx/`, session label). The `candidate.file`/`candidate.folder`/`candidate.session` locale keys are deleted; the session section title is `\u{5BF9}\u{8BDD}`/`Sessions`. The menu spans the composer card edge to edge (`left: 0; right: 0`), and a pending source renders two breathing skeleton bars in item cell metrics instead of the loading text row.', 'Candidate rows lead with a domain icon instead of a text prefix: `InputTriggerCandidate.icon` narrows from `string` to the closed union `InputTriggerCandidateIcon` (`file | folder | session`), the menu view maps it to `ReferenceIcon`, and `ui-reference` emits bare names (`folderx/`, session label). The `candidate.file`/`candidate.folder`/`candidate.session` locale keys are deleted; the session section title is `Sessions`. The menu spans the composer card edge to edge (`left: 0; right: 0`), and a pending source renders two breathing skeleton bars in item cell metrics instead of the loading text row.'],
    ['Composer placeholders advertise both triggers (`\u{63CF}\u{8FF0}\u{4F60}\u{60F3}\u{8981}\u{6784}\u{5EFA}\u{7684}\u{5185}\u{5BB9}… / \u{8C03}\u{7528}\u{6307}\u{4EE4} @ \u{6587}\u{4EF6}\u{6216}\u{5BF9}\u{8BDD}` / `Describe what you want to build... / commands, @ files or sessions`), and the zh copy for commands is unified from \u{547D}\u{4EE4} to \u{6307}\u{4EE4} across `ui-chat`, `ui-conversation`, `ui-goal`, and `ui-input-trigger`.', 'Composer placeholders advertise both triggers (`Describe what you want to build... / commands, @ files or sessions`), and the copy for commands is unified across `ui-chat`, `ui-conversation`, `ui-goal`, and `ui-input-trigger`.'],
  ],
  'feature/2026-08-27-web-at-mention-discovery-and-row-content.md': [
    ['The zh composer placeholder says `\u{6587}\u{4EF6}\u{6216}\u{5BF9}\u{8BDD}`, matching the `\u{5BF9}\u{8BDD}` section title the same menu already shows.', 'The composer placeholder says `files or sessions`, matching the `Sessions` section title the same menu already shows.'],
  ],
  // The predecessor id is escaped so namespace codemods leave the sealed historical literal unchanged.
  'feature/2026-09-05-sidebar-text-preview-and-file-tree.md': [
    ["The guide is what a pane shows before it holds content. Its registration is `{ id: '@\u{64}\u{65}\u{65}\u{70}\u{73}\u{65}\u{65}\u{6B}-ai/\u{64}\u{73}\u{68}-client-ui-sidebar-right/guide', kind: 'guide', priority: 'builtin', title }` with no `patterns`: a guide views nothing, so it is opened by kind through `openTab` and recorded under the page address `sidebar://guide`, which is the registry's bookkeeping and never composed by a caller. The tab's title is `\u{5F00}\u{59CB}` / `Start`, captured into the layout record when the pane is seeded, so a later language change relabels the type and not tabs already open.", "The guide is what a pane shows before it holds content. Its registration is `{ id: '@\u{64}\u{65}\u{65}\u{70}\u{73}\u{65}\u{65}\u{6B}-ai/\u{64}\u{73}\u{68}-client-ui-sidebar-right/guide', kind: 'guide', priority: 'builtin', title }` with no `patterns`: a guide views nothing, so it is opened by kind through `openTab` and recorded under the page address `sidebar://guide`, which is the registry's bookkeeping and never composed by a caller. The tab's title is `Start`, captured into the layout record when the pane is seeded, so a later language change relabels the type and not tabs already open."],
    ["Copy is the `sidebarFiles` namespace, thirteen keys. Row states: `loading` \u{300C}\u{6B63}\u{5728}\u{8BFB}\u{53D6}…\u{300D}/ \"Reading…\", `empty` \u{300C}\u{7A7A}\u{76EE}\u{5F55}\u{300D}/ \"Empty directory\", `truncated` \u{300C}\u{6761}\u{76EE}\u{592A}\u{591A}，\u{53EA}\u{663E}\u{793A}\u{4E86}\u{4E00}\u{90E8}\u{5206}\u{3002}\u{300D}/ \"Too many entries; showing only some of them.\", `noWorkspace` \u{300C}\u{8FD9}\u{4E2A}\u{4F1A}\u{8BDD}\u{6CA1}\u{6709}\u{5DE5}\u{4F5C}\u{533A}\u{76EE}\u{5F55}\u{3002}\u{300D}/ \"This session has no workspace directory.\", `entry.other` \u{300C}\u{8FD9}\u{4E0D}\u{662F}\u{6587}\u{4EF6}\u{6216}\u{76EE}\u{5F55}，\u{6CA1}\u{6CD5}\u{6253}\u{5F00}\u{3002}\u{300D}/ \"Not a file or a directory, so it cannot be opened.\", `reload` \u{300C}\u{91CD}\u{65B0}\u{8BFB}\u{53D6}\u{300D}/ \"Reload\". Failure lines are one per Host code, in terms of the directory: `workspace-file/not-found` \u{300C}\u{8FD9}\u{4E2A}\u{76EE}\u{5F55}\u{4E0D}\u{5728}\u{4E86}\u{3002}\u{53EF}\u{80FD}\u{5DF2}\u{88AB}\u{79FB}\u{52A8}\u{6216}\u{5220}\u{9664}\u{3002}\u{300D}/ \"That directory is gone. It may have been moved or deleted.\", `workspace-file/outside-workspace` \u{300C}\u{8FD9}\u{4E2A}\u{76EE}\u{5F55}\u{5728}\u{5DE5}\u{4F5C}\u{533A}\u{4E4B}\u{5916}，\u{4FA7}\u{680F}\u{4E0D}\u{4F1A}\u{8BFB}\u{53D6}\u{5B83}\u{3002}\u{300D}/ \"That directory is outside the workspace, so the sidebar will not read it.\", `workspace-file/not-directory` \u{300C}\u{8FD9}\u{4E0D}\u{662F}\u{4E00}\u{4E2A}\u{76EE}\u{5F55}\u{3002}\u{300D}/ \"That is not a directory.\"; any other failure, carrier or unclassified, shows `error.unavailable` \u{300C}\u{8BFB}\u{53D6}\u{5931}\u{8D25}：{message}\u{300D}/ \"Read failed: {message}\" with the failure's own message, because the tree has nothing useful to add to a transport-level error.", "Copy is the `sidebarFiles` namespace, thirteen keys. Row states: `loading` \"Reading…\", `empty` \"Empty directory\", `truncated` \"Too many entries; showing only some of them.\", `noWorkspace` \"This session has no workspace directory.\", `entry.other` \"Not a file or a directory, so it cannot be opened.\", `reload` \"Reload\". Failure lines are one per Host code, in terms of the directory: `workspace-file/not-found` \"That directory is gone. It may have been moved or deleted.\", `workspace-file/outside-workspace` \"That directory is outside the workspace, so the sidebar will not read it.\", `workspace-file/not-directory` \"That is not a directory.\"; any other failure, carrier or unclassified, shows `error.unavailable` \"Read failed: {message}\" with the failure's own message, because the tree has nothing useful to add to a transport-level error."],
  ],
  'feature/2026-09-23-language-neutral-default-workspace-naming.md': [
    ["[First-use default Workspace](2026-09-20-default-workspace.md) let the Client pick both the directory name and the stored title from its startup language: Chinese installations created `\u{9ED8}\u{8BA4}\u{5DE5}\u{4F5C}\u{533A}`, English ones `Default workspace`, everything else `default-workspace`. The name a reader sees and the name written to disk were the same string, so one product decision carried two incompatible requirements. A path is addressed by shell commands, tool arguments, `@path` references, session logs, and backups, and must not depend on which language happened to be active when the installation started. A label is read, and should be in the reader's language. Switching language afterwards satisfied neither: the path was already fixed, and so was the label derived from it.", "[First-use default Workspace](2026-09-20-default-workspace.md) let the Client pick both the directory name and the stored title from its startup language: localized installations derived a localized directory name, English ones `Default workspace`, everything else `default-workspace`. The name a reader sees and the name written to disk were the same string, so one product decision carried two incompatible requirements. A path is addressed by shell commands, tool arguments, `@path` references, session logs, and backups, and must not depend on which language happened to be active when the installation started. A label is read, and should be in the reader's language. Switching language afterwards satisfied neither: the path was already fixed, and so was the label derived from it."],
  ],
  'process/2026-07-22-cordis-tutorial-docs.md': [
    ['- **English-only, published to both website locales** through `mirroredPages()` in [website/docs.ts](../../../../website/docs.ts) under a `Cordis \u{6559}\u{7A0B}` / `Cordis tutorial` section of the develop sidebar — the same pattern as the reference pages, so a Chinese pair can ratchet in later without route changes.', '- **English-only, published to both website locales** through `mirroredPages()` in [website/docs.ts](../../../../website/docs.ts) under a `Cordis tutorial` section of the develop sidebar — the same pattern as the reference pages, so a translated pair can ratchet in later without route changes.'],
  ],
  'process/2026-07-26-briefed-minimal-translation-updates.md': [
    ["- **`pnpm run gen-translation-brief [--apply] [pair...]`** ([scripts/gen-translation-brief.ts](../../../../scripts/gen-translation-brief.ts), assembly in [scripts/translation-brief.ts](../../../../scripts/translation-brief.ts)) prints, per out-of-sync pair, the authored side's diff from its recorded last-confirmed blob to the working tree plus the change mapped at the narrowest safely aligned granularity, deterministically widening on mapping failure: a change confined to the pair's byte-identical code fences is computed outright (`--apply` splices it into the counterpart and validates the result against the pairing gate's structural signature before writing); otherwise changed Markdown units (headings, paragraphs, table rows, list items, code fences, block quotes, HTML blocks, thematic breaks, link definitions — matched by container-scoped kind sequences) each carry their last-confirmed source, current source, and current counterpart text with line numbers; units that do not align fall back to depth-matched heading sections; and when sections do not align either, or both sides drifted, the briefing says so and withholds the mapping instead of guessing. Terminology rows are matched against the changed spans only (word-boundary English matching with plural inflections), and for Chinese targets the briefing tracks each relevant term's document-wide first occurrence — when an edit moves it, the vacated and receiving spans join the briefing with an explanatory note, since the \u{9996}\u{6B21}\u{51FA}\u{73B0} annotation must move with it. The unit mapping, code splice, and first-occurrence mechanics adopt the planner design from the incremental prompt-pipeline work; its provider-backed bake-off independently validated the same scope ladder for the automated pipeline. The briefing is the translator's whole working set; the full sources of truth remain the escalation path for decisions the briefing cannot answer.", "- **`pnpm run gen-translation-brief [--apply] [pair...]`** ([scripts/gen-translation-brief.ts](../../../../scripts/gen-translation-brief.ts), assembly in [scripts/translation-brief.ts](../../../../scripts/translation-brief.ts)) prints, per out-of-sync pair, the authored side's diff from its recorded last-confirmed blob to the working tree plus the change mapped at the narrowest safely aligned granularity, deterministically widening on mapping failure: a change confined to the pair's byte-identical code fences is computed outright (`--apply` splices it into the counterpart and validates the result against the pairing gate's structural signature before writing); otherwise changed Markdown units (headings, paragraphs, table rows, list items, code fences, block quotes, HTML blocks, thematic breaks, link definitions — matched by container-scoped kind sequences) each carry their last-confirmed source, current source, and current counterpart text with line numbers; units that do not align fall back to depth-matched heading sections; and when sections do not align either, or both sides drifted, the briefing says so and withholds the mapping instead of guessing. Terminology rows are matched against the changed spans only (word-boundary English matching with plural inflections), and for translated targets the briefing tracks each relevant term's document-wide first occurrence — when an edit moves it, the vacated and receiving spans join the briefing with an explanatory note, since the first-occurrence annotation must move with it. The unit mapping, code splice, and first-occurrence mechanics adopt the planner design from the incremental prompt-pipeline work; its provider-backed bake-off independently validated the same scope ladder for the automated pipeline. The briefing is the translator's whole working set; the full sources of truth remain the escalation path for decisions the briefing cannot answer."],
    ["A second head-to-head replay on the same ten examples compared this note's shipped briefing against its earlier section-only form (no unit tier, no computed mechanical path, counterpart-only context, no first-occurrence tracking). Prose quality and cost were at parity — pairwise blind verdicts split with only stylistic margins — and the shipped form won on two objective outcomes: the two code-fence-only examples were completed byte-identical to the human-reviewed historical updates in under a second with no model tokens, and on the example whose edit moved a term's document-wide first occurrence, the shipped briefing's flagged move reproduced the human-reviewed gloss relocation while the section-only form left a \u{9996}\u{6B21}\u{51FA}\u{73B0} violation for review to catch.", "A second head-to-head replay on the same ten examples compared this note's shipped briefing against its earlier section-only form (no unit tier, no computed mechanical path, counterpart-only context, no first-occurrence tracking). Prose quality and cost were at parity — pairwise blind verdicts split with only stylistic margins — and the shipped form won on two objective outcomes: the two code-fence-only examples were completed byte-identical to the human-reviewed historical updates in under a second with no model tokens, and on the example whose edit moved a term's document-wide first occurrence, the shipped briefing's flagged move reproduced the human-reviewed gloss relocation while the section-only form left a first-occurrence violation for review to catch."],
    ['- A first-occurrence move can enlarge a briefing beyond the directly changed spans; that cost is an explicit consequence of the \u{9996}\u{6B21}\u{51FA}\u{73B0} contract, not an alignment heuristic.', '- A first-occurrence move can enlarge a briefing beyond the directly changed spans; that cost is an explicit consequence of the first-occurrence contract, not an alignment heuristic.'],
  ],
  'process/2026-08-09-chinese-contract-terminology.md': [
    ['# Agent Note: Standardize Chinese contract terminology on \u{7EA6}\u{5B9A}', '# Agent Note: Standardize translated contract terminology on `\\u7EA6\\u5B9A`'],
    ["The Chinese documentation rendered English `contract` inconsistently as `\u{5951}\u{7EA6}` and `\u{7EA6}\u{5B9A}`, sometimes within one file or paragraph. The terminology table prescribed `\u{5951}\u{7EA6}`, while reviewed incremental proofreading selected the more natural engineering rendering `\u{7EA6}\u{5B9A}`. Leaving the table and corpus split made either choice fail the repository's terminology rule and allowed later translations to reintroduce the disagreement.", "The translated documentation rendered English `contract` inconsistently as `\\u5951\\u7EA6` and `\\u7EA6\\u5B9A`, sometimes within one file or paragraph. The terminology table prescribed `\\u5951\\u7EA6`, while reviewed incremental proofreading selected the more natural engineering rendering `\\u7EA6\\u5B9A`. Leaving the table and corpus split made either choice fail the repository's terminology rule and allowed later translations to reintroduce the disagreement."],
    ['English `convention` also commonly renders as `\u{7EA6}\u{5B9A}`. That overlap is intentional: ordinary Chinese engineering prose uses `\u{7EA6}\u{5B9A}` for both concepts, and context normally carries whether a statement is descriptive practice or a binding interface rule. Where an English sentence explicitly contrasts a convention with a contract, the Chinese sentence must preserve the distinction through wording such as `\u{60EF}\u{4F8B}` versus `\u{7EA6}\u{5B9A}`, rather than mechanically giving every `convention` the same rendering.', 'English `convention` also commonly renders as `\\u7EA6\\u5B9A`. That overlap is intentional: the translated engineering prose uses `\\u7EA6\\u5B9A` for both concepts, and context normally carries whether a statement is descriptive practice or a binding interface rule. Where an English sentence explicitly contrasts a convention with a contract, the translation must preserve the distinction through wording such as `\\u60EF\\u4F8B` versus `\\u7EA6\\u5B9A`, rather than mechanically giving every `convention` the same rendering.'],
    ["The terminology source of truth defines `contract` as `\u{7EA6}\u{5B9A}` and `adapter contract` as `\u{9002}\u{914D}\u{5668}\u{7EA6}\u{5B9A}（adapter contract）` on first mention. Every active Chinese documentation pair follows that ruling; archived Agent Notes remain frozen. Unpaired bilingual calibration assets and the translation prompt's explanatory prose follow the same terms so they cannot teach the superseded rendering.", "The terminology source of truth defines `contract` as `\\u7EA6\\u5B9A` and `adapter contract` as `\\u9002\\u914D\\u5668\\u7EA6\\u5B9A` (`adapter contract`) on first mention. Every active translated documentation pair follows that ruling; archived Agent Notes remain frozen. Unpaired bilingual calibration assets and the translation prompt's explanatory prose follow the same terms so they cannot teach the superseded rendering."],
    ['**Keep `contract` as `\u{5951}\u{7EA6}`.** Rejected because the reviewed corpus consistently preferred `\u{7EA6}\u{5B9A}` for technical interfaces, lifecycle guarantees, and behavioral boundaries, and maintaining the older term would require reverting accepted proofreading across many documents.', '**Keep `contract` as `\\u5951\\u7EA6`.** Rejected because the reviewed corpus consistently preferred `\\u7EA6\\u5B9A` for technical interfaces, lifecycle guarantees, and behavioral boundaries, and maintaining the older term would require reverting accepted proofreading across many documents.'],
    ['**Permit both `\u{5951}\u{7EA6}` and `\u{7EA6}\u{5B9A}` for `contract`.** Rejected because it preserves the exact inconsistency that made package families and even individual paragraphs disagree.', '**Permit both `\\u5951\\u7EA6` and `\\u7EA6\\u5B9A` for `contract`.** Rejected because it preserves the exact inconsistency that made package families and even individual paragraphs disagree.'],
    ['The migration scans every active bilingual pair, updates each affected Chinese document, re-records its pairing sidecar, and leaves active prose with no `\u{5951}\u{7EA6}` occurrences. The pairing gate, full `doc-sync`, website build, translation prompt tests and snapshot, and `git diff --check` verify the resulting corpus and pipeline assets.', 'The migration scans every active translated pair, updates each affected document, re-records its pairing sidecar, and leaves active prose with no `\\u5951\\u7EA6` occurrences. The pairing gate, full `doc-sync`, website build, translation prompt tests and snapshot, and `git diff --check` verify the resulting corpus and pipeline assets.'],
  ],
  'process/2026-08-09-md-fragment-anchor-gate.md': [
    ["`verify-md-links` proved a relative link's target file exists but never looked at the `#fragment`, and the documentation standard compensated with a manual rule: grep anchors yourself before renaming a heading. A corpus sweep found 15 links whose fragments named no anchor in their target — three distinct decay modes: a heading reworded after the link was written (`#security-and-authority-are-explicit-non-goals` vs the note's current `Security and authority are non-goals`), a contract relocated to a different owning document (`tool-fs` linking the seam README for the no-timeout rule that now lives in the group README), and zh pair sides linking English slugs their Chinese headings never produce (`#deferred-work` against `## \u{63A8}\u{8FDF}\u{5DE5}\u{4F5C}`). None of these fail any gate, and each silently strands the reader at the top of the target page.", "`verify-md-links` proved a relative link's target file exists but never looked at the `#fragment`, and the documentation standard compensated with a manual rule: grep anchors yourself before renaming a heading. A corpus sweep found 15 links whose fragments named no anchor in their target — three distinct decay modes: a heading reworded after the link was written (`#security-and-authority-are-explicit-non-goals` vs the note's current `Security and authority are non-goals`), a contract relocated to a different owning document (`tool-fs` linking the seam README for the no-timeout rule that now lives in the group README), and translated pair sides linking English slugs their localized headings never produce (`#deferred-work` against exact heading `## \\u63A8\\u8FDF\\u5DE5\\u4F5C`). None of these fail any gate, and each silently strands the reader at the top of the target page."],
  ],
  'process/2026-08-12-documentation-site-navigation-and-chrome.md': [
    ["The reference sidebar rendered its 43 subsystem pages first, ahead of every other group: `sectionOrder` in the VitePress config listed no position for the subsystem groups, nor for the group holding the Python SDK page, so `indexOf` returned `-1` and sorted them ahead of the ordered sections. Clicking the `\u{53C2}\u{8003}` navigation item landed on the architecture page whose own sidebar entry was link 44 of 62, 1549px down a 2478px sidebar — outside the viewport. Four subsystem pages carried `order` values already taken by other pages in the same section, resolved only by `Array.prototype.sort` stability and the order the manifest's arrays happened to be concatenated.", "The reference sidebar rendered its 43 subsystem pages first, ahead of every other group: `sectionOrder` in the VitePress config listed no position for the subsystem groups, nor for the group holding the Python SDK page, so `indexOf` returned `-1` and sorted them ahead of the ordered sections. Clicking the `Reference` navigation item landed on the architecture page whose own sidebar entry was link 44 of 62, 1549px down a 2478px sidebar — outside the viewport. Four subsystem pages carried `order` values already taken by other pages in the same section, resolved only by `Array.prototype.sort` stability and the order the manifest's arrays happened to be concatenated."],
    ["[website/docs.ts](../../../../website/docs.ts) owns section placement. `sections` declares the groups per locale, and `sectionSpec(locale, label)` returns a group's position and collapse behavior, throwing when a locale declares no placement for a label. A group absent from the declaration now fails the build instead of sorting silently to the top. Placement is per locale because the two sidebars name their groups independently, and a label both use — `SDK` — cannot hold one rank against `\u{5165}\u{95E8}` and against `Guide` at once.", "[website/docs.ts](../../../../website/docs.ts) owns section placement. `sections` declares the groups per locale, and `sectionSpec(locale, label)` returns a group's position and collapse behavior, throwing when a locale declares no placement for a label. A group absent from the declaration now fails the build instead of sorting silently to the top. Placement is per locale because the two sidebars name their groups independently, and a label both use — `SDK` — cannot hold one rank against `Getting started` and against `Guide` at once."],
    ['**A search tokenizer for Chinese queries.** Built and reverted. The premise — that MiniSearch leaves Chinese prose as untokenizable whole sentences — was tested against a term (`\u{5B50}\u{4EE3}\u{7406}`) that appears nowhere in the corpus; the Chinese pages write `Subagent` and `\u{5B50} agent`. Measured against the unmodified index, `\u{63D2}\u{4EF6}\u{914D}\u{7F6E}` returns 120 hits, `\u{4F1A}\u{8BDD}\u{6301}\u{4E45}\u{5316}` 85, `\u{5DE5}\u{4F5C}\u{6D41}` 28, `\u{6C99}\u{7BB1}` 12, each ranking its own page first: `prefix: true` already reaches Chinese terms through the short tokens punctuation produces. Adjacent-character pairs grew the Chinese index from 1.23MB to 2.12MB for no gain. The attempt also surfaced a trap worth keeping: VitePress ships search-option functions to the browser through `Function.prototype.toString` and rebuilds them with `new Function`, so any such function that closes over a module-level constant throws in an empty scope and silently returns no results.', '**A search tokenizer for CJK queries.** Built and reverted. The premise — that MiniSearch leaves CJK prose as untokenizable whole sentences — was tested against a term that appears nowhere in the corpus; the translated pages use the English product term instead; the tested absent term was `\\u5B50\\u4EE3\\u7406`, while the corpus used `Subagent` and `\\u5B50 agent`. Measured against the unmodified index, `\\u63D2\\u4EF6\\u914D\\u7F6E` returns 120 hits, `\\u4F1A\\u8BDD\\u6301\\u4E45\\u5316` 85, `\\u5DE5\\u4F5C\\u6D41` 28, and `\\u6C99\\u7BB1` 12 hits, each ranking its own page first: `prefix: true` already reaches the escaped historical terms through the short tokens punctuation produces. Adjacent-character pairs grew the translated-text index from 1.23MB to 2.12MB for no gain. The attempt also surfaced a trap worth keeping: VitePress ships search-option functions to the browser through `Function.prototype.toString` and rebuilds them with `new Function`, so any such function that closes over a module-level constant throws in an empty scope and silently returns no results.'],
    ['**Placing the subsystem groups directly after `\u{6982}\u{5FF5}`.** Rejected: it restores the architecture page to the top but leaves generated reference, the Cordis API, and the cookbook below 43 rows.', '**Placing the subsystem groups directly after `Concepts`.** Rejected: it restores the architecture page to the top but leaves generated reference, the Cordis API, and the cookbook below 43 rows.'],
  ],
  'process/2026-09-02-project-local-issue-planning-fields.md': [
    ['The `DSH Issue Management` Project owns `Priority`, `Severity`, `Cost`, `Start Date`, and `Target Date` as Project custom fields. `Severity` uses the option meanings from the organization `\u{5F71}\u{54CD}\u{9762}` field, and `Cost` uses the option meanings from `\u{89E3}\u{51B3}\u{4EE3}\u{4EF7}`.', 'The `DSH Issue Management` Project owns `Priority`, `Severity`, `Cost`, `Start Date`, and `Target Date` as Project custom fields. `Severity` uses the option meanings from the organization `Impact` field, and `Cost` uses the option meanings from `Resolution cost`.'],
  ],
  'simplification/2026-07-31-one-route-to-add-a-workspace.md': [
    ['Adding a Workspace has one route: pick a host directory through the composed directory flow, new or existing. `menu.addWorkspace` ("\u{6DFB}\u{52A0}\u{5DE5}\u{4F5C}\u{533A}…" / "Add workspace…") is the entry; the create-by-name dialog and its `create.*` / `menu.createWorkspace` / `workspace.new` strings are gone. The label names the outcome, not the mechanism, because it is now the only door to that outcome — a user looking for "\u{65B0}\u{5EFA}" must find it.', 'Adding a Workspace has one route: pick a host directory through the composed directory flow, new or existing. `menu.addWorkspace` ("Add workspace…") is the entry; the create-by-name dialog and its `create.*` / `menu.createWorkspace` / `workspace.new` strings are gone. The label names the outcome, not the mechanism, because it is now the only door to that outcome — a user looking for "Create new" must find it.'],
    ["**Keep `Open local folder…` as the label.** Rejected: after the merge the entry both opens and creates, and naming it after the mechanism hides the creation half from exactly the users whose entry we removed. The counter-argument — \"\u{672C}\u{5730}\" usefully disambiguates the browser's machine from the harness's — is answered one step later by the dialog's own title and breadcrumbs.", "**Keep `Open local folder…` as the label.** Rejected: after the merge the entry both opens and creates, and naming it after the mechanism hides the creation half from exactly the users whose entry we removed. The counter-argument — \"local\" usefully disambiguates the browser's machine from the harness's — is answered one step later by the dialog's own title and breadcrumbs."],
  ],
  'simplification/2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md': [
    ["Mid-turn steering is a host/agent-loop capability (`mode:'steer'`, a durable `user/message`). The Web product already locked the composer while a turn runs and never shipped a queue/steer menu, yet the client still threaded `'queue' | 'steer'` through the input machine, `conversation.send`, and locale keys, and rendered consumed steering as a badged \u{300C}\u{63D2}\u{8BDD}\u{300D}/\u{300C}Interjection\u{300D} bubble. That left a half-built UI surface: an unused submit mode, a product label for a gesture users cannot perform, and e2e goldens that pinned chrome the product does not own.", "Mid-turn steering is a host/agent-loop capability (`mode:'steer'`, a durable `user/message`). The Web product already locked the composer while a turn runs and never shipped a queue/steer menu, yet the client still threaded `'queue' | 'steer'` through the input machine, `conversation.send`, and locale keys, and rendered consumed steering as a badged “Interjection” bubble. That left a half-built UI surface: an unused submit mode, a product label for a gesture users cannot perform, and e2e goldens that pinned chrome the product does not own."],
  ],
  'simplification/2026-08-10-web-remove-steering-interjection-caption.md': [
    ['The [context-source and steer marks decision](../feature/2026-08-04-web-context-source-and-steer-marks.md) captioned every durable and pending steering bubble with `\u{63D2}\u{8BDD}` / `Interjection` so the transcript could say which right-aligned bubble interrupted a running turn. The caption repeats what the flow already shows: a steering bubble sits mid-turn, between the assistant content it interrupted, while a turn-opening prompt sits at a turn boundary. A permanent line of tertiary text above every steer bubble buys no reading a position-aware reader does not already have, and it is the only chrome any user-style bubble carries, so it also breaks the otherwise uniform right-aligned rhythm.', 'The [context-source and steer marks decision](../feature/2026-08-04-web-context-source-and-steer-marks.md) captioned every durable and pending steering bubble with `Interjection` so the transcript could say which right-aligned bubble interrupted a running turn. The caption repeats what the flow already shows: a steering bubble sits mid-turn, between the assistant content it interrupted, while a turn-opening prompt sits at a turn boundary. A permanent line of tertiary text above every steer bubble buys no reading a position-aware reader does not already have, and it is the only chrome any user-style bubble carries, so it also breaks the otherwise uniform right-aligned rhythm.'],
  ],
  'simplification/2026-08-13-remove-first-run-beta-notice.md': [
    ['Every GUI first launch opened with a full-viewport internal-test statement (\u{5185}\u{6D4B}\u{58F0}\u{660E}): internal-beta framing plus instructions for enabling Session Log upload through `DSH_TELEMETRY_MODE`. Session telemetry already resolves to `DISABLED` when its mode is unset ([telemetry default-off](../feature/2026-08-10-telemetry-default-off.md)), so the only onboarding content about telemetry was a prompt explaining how to turn it on, and the internal-test framing itself must not ship in a release build.', 'Every GUI first launch opened with a full-viewport internal-test statement: internal-beta framing plus instructions for enabling Session Log upload through `DSH_TELEMETRY_MODE`. Session telemetry already resolves to `DISABLED` when its mode is unset ([telemetry default-off](../feature/2026-08-10-telemetry-default-off.md)), so the only onboarding content about telemetry was a prompt explaining how to turn it on, and the internal-test framing itself must not ship in a release build.'],
  ],
}

// These are the only historical prose references that remain after the language switcher is removed.
// Keeping the replacements exact makes the migration fail closed if an archived note has drifted.
const englishOnlyBodyReplacements: Readonly<Record<string, readonly ArchiveTextReplacement[]>> = {
  'process/2026-07-02-bilingual-docs-and-pairing-gate.md': [
    ['English `foo.md`, Chinese `foo.zh.md`, and a consistency record `foo.i18n.yaml`', 'English `foo.md`, a translated counterpart, and a consistency record `foo.i18n.yaml`'],
    ['a document may be authored and reviewed Chinese-first and translated to English afterwards, or the reverse', 'a document may be authored and reviewed in either language first and translated afterwards'],
    ['a `.zh.md` fence sequence', 'a translated fence sequence'],
    ['the Chinese side and every authored English source carry their switchers', 'both sides carry their switchers'],
    ['the structure signature normalizes `.md` and `.zh.md` siblings to one semantic target', 'the structure signature normalizes locale siblings to one semantic target'],
    ['projects `.zh.md` and `/en/` projects `.md`', 'projects the translated page and `/en/` projects the English page'],
    ['`.zh.md` files would carry an HTML comment', 'translated files would carry an HTML comment'],
    ['translation would flow EN → ZH only', 'translation would flow EN → translated only'],
    ['the team wants Chinese-first authoring (write and review a Chinese Agent Note, then translate to English) with the two languages holding equal authority, which a one-directional canonical model cannot express', 'the team wanted either-language authoring with both sides holding equal authority, which a one-directional canonical model could not express'],
  ],
  'process/2026-08-18-localized-bilingual-links.md': [
    ['sends readers from Chinese source files', 'sends readers from a translated source file'],
    ['a reviewed `.zh.md` sibling exists', 'a reviewed translated sibling exists'],
    ['Chinese sources use its `.zh.md`', 'translated sources use their translated sibling'],
    ['name `index.md` or `index.zh.md` explicitly', 'name the English or translated index explicitly'],
  ],
  'process/2026-07-28-per-subsystem-cordis-surface-regions.md': [
    ['into `foo.md` and `foo.zh.md`', 'into the English and translated pages'],
  ],
  'process/2026-06-20-core-data-structures-catalog.md': [
    ['A paired `.zh.md` block', 'A translated counterpart block'],
  ],
  'simplification/2026-08-11-quickstart-documentation-home.md': [
    ['`docs/user/index.md` and `docs/user/index.zh.md` own the redirect as VitePress frontmatter.', 'The English and translated root pages own the redirect as VitePress frontmatter.'],
    ['the canonical Markdown retains its bilingual switcher', 'the canonical Markdown retains its language switcher'],
  ],
  'process/2026-08-09-md-fragment-anchor-gate.md': [
    ['Chinese pair sides follow the existing repository convention (`docs/glossary.zh.md`, `docs/cordis-primer.zh.md`):', 'Translated pair sides follow the existing repository convention:'],
    ['before the Chinese heading', 'before the translated heading'],
  ],
}

/**
 * Apply the exact source-only edits allowed by the one-time English-only archive migration.
 *
 * @param path - archive-relative English Agent Note path.
 * @param content - sealed source bytes from the pre-migration archive.
 * @returns the expected post-migration bytes.
 * @throws when the source does not contain exactly the expected switcher or historical references.
 */
export function rewriteArchiveEnglishOnlySource(path: string, content: Buffer): Buffer {
  let text = content.toString('utf8')
  const switcherLine = /^English \| \[[^\]\r\n]+\]\([^\)\r\n]+\.zh\.md\)\r?$/gm
  const switchers = text.match(switcherLine) ?? []
  if (switchers.length !== 1) {
    throw new Error(`${path}: expected exactly one English translation switcher during migration`)
  }
  const switcherBlock = /^English \| \[[^\]\r\n]+\]\([^\)\r\n]+\.zh\.md\)\r?\n\r?\n/m
  text = text.replace(switcherBlock, '')
  for (const [before, after] of [
    ...(englishOnlyBodyReplacements[path] ?? []),
    ...(englishOnlyHanLineReplacements[path] ?? []),
  ]) {
    const occurrences = text.split(before).length - 1
    if (occurrences !== 1) {
      throw new Error(`${path}: expected one migration occurrence for ${JSON.stringify(before)}`)
    }
    text = text.replace(before, () => after)
  }
  return Buffer.from(text)
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

interface Triplet {
  source?: Buffer
  zh?: Buffer
  meta?: Buffer
}

function pairMeta(content: string): Map<string, string> | undefined {
  const entries = new Map<string, string>()
  for (const line of content.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const match = /^([^:#]+\.md): ([0-9a-f]{40})$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) return undefined
    entries.set(match[1], match[2])
  }
  return entries
}

function validateMetadata(path: string, content: Buffer, sourceBase: string): { errors: string[]; date: string | undefined } {
  const errors: string[] = []
  const lines = content.toString('utf8').split('\n')
  const status = lines.findIndex(line => line.startsWith('Status:'))
  if (lines[status] !== 'Status: implemented') errors.push(`${path}: requires \`Status: implemented\``)
  const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[status + 1] ?? '')?.[1]
  if (status < 0 || archived === undefined || !validDate(archived)) {
    errors.push(`${path}: requires \`Archived: YYYY-MM-DD\` with a valid date immediately after the status`)
  } else if (archived < sourceBase.slice(0, 10)) {
    errors.push(`${path}: archive date ${archived} predates the note filename`)
  }
  return { errors, date: archived }
}

/**
 * Validate the closed kind tree, implemented/archive metadata, and completeness.
 *
 * @param artifacts - archived note files by repository-relative path.
 * @param englishOnly - reason this checkout keeps no translation; the sealed note then
 *   stands alone instead of needing a Chinese counterpart and its record.
 * @returns the violations found.
 */
export function validateArchiveArtifacts(artifacts: ReadonlyMap<string, Buffer>, englishOnly?: string): string[] {
  const errors: string[] = []
  const triplets = new Map<string, Triplet>()
  for (const [path, content] of artifacts) {
    const match = /^([^/]+)\/(\d{4}-\d{2}-\d{2}-.+?)(\.zh\.md|\.i18n\.yaml|\.md)$/.exec(path)
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      errors.push(`${path}: expected {kind}/yyyy-mm-dd-topic.{md,zh.md,i18n.yaml}`)
      continue
    }
    if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(match[1])) {
      errors.push(`${path}: unknown Agent Note kind ${JSON.stringify(match[1])}`)
      continue
    }
    const key = `${match[1]}/${match[2]}`
    const triplet = triplets.get(key) ?? {}
    if (match[3] === '.md') triplet.source = content
    else if (match[3] === '.zh.md') triplet.zh = content
    else triplet.meta = content
    triplets.set(key, triplet)
  }

  for (const [key, triplet] of [...triplets].sort(([left], [right]) => left.localeCompare(right))) {
    const sourcePath = `${key}.md`
    const zhPath = `${key}.zh.md`
    const metaPath = `${key}.i18n.yaml`
    const { source, zh, meta } = triplet
    const missing = [
      source === undefined ? sourcePath : undefined,
      zh === undefined ? zhPath : undefined,
      meta === undefined ? metaPath : undefined,
    ].filter((path): path is string => path !== undefined)
    // An English-only checkout keeps the sealed note alone, so only its own file must exist.
    if (source === undefined || (englishOnly === undefined && (zh === undefined || meta === undefined))) {
      errors.push(`${key}: incomplete archived triplet; missing ${missing.join(', ')}`)
      continue
    }
    const sourceBase = basename(key)
    const { errors: sourceErrors, date: sourceDate } = validateMetadata(sourcePath, source, sourceBase)
    errors.push(...sourceErrors)
    if (englishOnly !== undefined && hanCharacter.test(source.toString('utf8'))) {
      errors.push(`${sourcePath}: English-only archived notes must not contain Han characters`)
    }
    if (zh === undefined || meta === undefined) continue
    const { errors: zhErrors, date: zhDate } = validateMetadata(zhPath, zh, sourceBase)
    errors.push(...zhErrors)
    if (sourceDate !== undefined && zhDate !== undefined && sourceDate !== zhDate) {
      errors.push(`${key}: English and Chinese archive dates differ (${sourceDate} vs ${zhDate})`)
    }
    const pair = pairMeta(meta.toString('utf8'))
    if (pair === undefined || pair.size !== 2
      || pair.get(`${sourceBase}.md`) !== gitBlobHash(source)
      || pair.get(`${sourceBase}.zh.md`) !== gitBlobHash(zh)) {
      errors.push(`${metaPath}: consistency record must contain the current Git blob hashes of both archived sides`)
    }
  }
  return errors
}

/** Preserve every sealed path/hash and append hashes for newly archived artifacts. */
export function extendArchiveManifest(
  existing: ArchiveManifest,
  artifacts: ReadonlyMap<string, Buffer>,
): { files: Record<string, string>; added: string[]; errors: string[] } {
  const errors: string[] = []
  const files: Record<string, string> = { ...existing.files }
  for (const [path, expected] of Object.entries(existing.files)) {
    const content = artifacts.get(path)
    if (content === undefined) errors.push(`${path}: sealed artifact is missing`)
    else if (archiveContentHash(content) !== expected) errors.push(`${path}: sealed content hash changed`)
  }
  const added: string[] = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    if (files[path] !== undefined) continue
    files[path] = archiveContentHash(content)
    added.push(path)
  }
  return { files, added, errors }
}

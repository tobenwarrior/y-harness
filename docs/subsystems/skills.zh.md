# Skills

[English](skills.md) | 中文

[skill（技能）能力族](../../packages/skill) 包含 Service Definition（[dsh-skill](../../packages/skill/skill)，`ctx.skills`）、本地 Service Provider（[dsh-skill-filesystem](../../packages/skill/skill-filesystem)）、可选的随包提供方（[dsh-skill-badge](../../packages/skill/skill-badge)、[dsh-skill-office](../../packages/skill/skill-office) 及 [dsh-sandbox-windows-acl](../../packages/sandbox/sandbox-windows-acl) 中的 Windows ACL 诊断提供方）和 Consumer（[dsh-tool-skill](../../packages/skill/tool-skill)）。注册表在其宿主层与各 scope 层之间合并各提供方的目录；提供方贡献本地或随包 skill；Consumer 拥有初始目录和替换目录，以及面向模型的 `skill` 工具。skill 是可选的指令而非会话事件，因此其词汇定义在此处而非 [core.md](core.zh.md)。

源码：[`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts)、[`packages/skill/skill-filesystem/src/index.ts`](../../packages/skill/skill-filesystem/src/index.ts)、[`packages/skill/skill-badge/src/index.ts`](../../packages/skill/skill-badge/src/index.ts)、[`packages/skill/skill-office/src/index.ts`](../../packages/skill/skill-office/src/index.ts)、[`packages/sandbox/sandbox-windows-acl/src/acl-skill.ts`](../../packages/sandbox/sandbox-windows-acl/src/acl-skill.ts) 与 [`packages/skill/tool-skill/src/index.ts`](../../packages/skill/tool-skill/src/index.ts)。

`ctx.skillLibrary` 为用户提供[技能库](../../packages/skill/skill-library)，包括项目与共享技能清单、受保护的接管流程、已记录的加载次数、明确引用和可撤销维护。[浏览器面板](../../packages/client/ui-skill-library)仅为选中的详情加载指令正文。清单包含原生元信息与当前已挂载的注册表视图；未启用的预设不在清单范围内。有界检索 API 不会替换模型自身的目录。

## 提供方注册表

`ctx.skills` 组合本地、内嵌、远程或其他提供方。注册是同步的；远程初始化与发现属于 `list()` 的 await 阶段。提供方对象、选项与候选项以只读方式借用，语义字段会被校验。

注册表采用宿主 + 按 scope 的分层结构，即[工具注册表](tools.zh.md)在 [dsh-scope](../../packages/core/scope) 之上确立的形态：注册会落入调用方上下文 scope 对应的层——宿主行与 repository 插件落入全局层，由 agent（智能体） preset 常驻组合挂载的插件落入该 preset 的层——提供方名称在每层内唯一，而非进程级唯一。读取时将全局层与观察 scope 的链合并：最近层的条目直接赢得重名 skill，下文的 rank 顺序只在单层内裁决重名。发现缓存以解析后的 scope 链为键，因此重设 scope 父级（空会话重组）无需注册表变更即可被下一次读取看到。

在单层内，重名项依次按 rank、提供方顺序和本地顺序确定优先级；摘要按名称排序。提供方的 `list()` 被拒绝时，系统会记录日志，并从不完整观测中省略该提供方的结果；显式的不完整观测会提供可用候选项，但不会使结果变得可缓存；格式错误的候选项快速失败。每个提供方工厂都会接收一项注册作用域内的控制能力；仅当该精确注册仍处于活动状态时，其 `invalidate()` 才会清除已完成目录；注册失败或 dispose（资源释放）时，其信号会中止。若提供方代次在发现进行期间发生变化，该发现会重试一次；若再次变化，则返回最新候选项，并将结果标为不完整且不予缓存。提供方和运行时变更会发出不带过滤条件的 `skills/change` 失效事件；该事件不携带 diff，因此消费方会使用自身的查找选项重新获取 `snapshot()`。

`SkillProvider.list()` 返回的数组是完整发现的简写形式。`SkillProviderObservation` 允许提供方公开仍可直接加载的候选项，同时报告该观测不具权威性。

```ts type-equiv
/** Provider candidates plus whether the current discovery is authoritative. */
interface SkillProviderObservation {
  /** Candidates available from the current provider discovery. */
  readonly candidates: readonly SkillCandidate[]
  /** Whether discovery completed and these candidates may be cached. */
  readonly complete: boolean
}
```

```ts type-equiv
/** Provider interface for one source of skills, such as local directories or a remote registry. */
interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  readonly name: string
  /**
   * List available skill candidates for the current lookup context. Provider
   * plugins register synchronously during `apply()`; remote initialization,
   * authentication, and discovery are awaited inside this method. Implementations
   * should settle promptly when `options.signal` aborts.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns provider candidates as a complete-array shorthand, or an explicit
   *   observation when usable candidates came from incomplete discovery.
   */
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>
  /**
   * Load a complete skill body for a previously listed candidate.
   * @param candidate - the winning candidate originally returned by this provider.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill body, or `undefined` if it is no longer loadable.
   */
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}
```

```ts type-equiv
/** Registration-scoped lifecycle and invalidation capability borrowed by one provider. */
interface SkillProviderControl {
  /** Aborts if registration fails or when the exact provider registration is disposed. */
  readonly signal: AbortSignal
  /** Invalidate completed catalogs and notify consumers only while the exact registration remains active. */
  readonly invalidate: () => void
}
```

## 本地发现优先级

随附的本地提供方按 rank 顺序扫描各根目录：

| Rank | Source | Root |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | 配置了 `Config.bundledSkillDir` 时使用该目录 |

项目根目录为包含 `.git` 的最近祖先目录；找不到时使用当前 cwd。当 `ctx.fs` 可用时，git-root 向上查找通过文件系统服务探测 `.git`，使远程或沙箱工作区不会回退到宿主文件系统边界。用户 DSH 根目录会跳过其 `.system` 子目录。本地提供方不会合成内置系统 skill；部署方通过已配置的 bundled 根目录或专用提供方提供随包 skill。

`dsh-skill-badge` 在 `BUNDLED_SKILL_RANK` 注册一个不可变的 `bundled` 候选项，并通过 `resourceBase` 公开其随包资产目录。交付的 CLI（命令行界面）将该插件声明为禁用，因此启用其组合配置行即为显式选择加入。

Chokidar 会监视现有根目录中直属 bundle 和平铺条目的添加与移除，以及直属 skill 条目的变更。缺失的根目录会从最近的现有祖先开始，逐个跟踪缺失路径段，直至 Chokidar 可以附加。bundle 下的资源文件变更不属于目录变更。面向模型的 `write` 和 `edit` 观测会在目标路径与目录相关时同步使提供方目录失效，而宿主 watcher 覆盖 IDE、Git、shell 和外部进程产生的变更。watcher 失败会使当前观测不完整，但不会在直接加载时隐藏可读候选项；项目作用域 watcher 使用按配置设限的 LRU。

## skill 身份

skill 名称为 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）。本地提供方接受目录包（`<name>/SKILL.md`）和扁平 Markdown 文件（`<name>.md`）。嵌套递归的 `**/SKILL.md` 发现不受支持。

```ts type-equiv
/** Origin bucket for a skill contribution. The value is prompt-visible metadata, not precedence by itself. */
type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})
```

## 摘要、候选项与完整定义

`SkillSummary` 是注册表中与调用策略无关的摘要形状。消费方自行选择渲染哪些条目和字段；模型会话目录仅使用模型可调用 skill 的 `name` 和 `description`，从不使用正文或绝对文件路径。`SkillInvocationPolicy` 将两个独立调用控制规范化为正向布尔值，且每个已解析的摘要、候选项和定义都携带该策略，而不会把任意 frontmatter 纳入领域模型。

```ts type-equiv
/** Invocation controls shared by skill discovery consumers. */
interface SkillInvocationPolicy {
  /** Whether model-facing catalogs and loaders include this skill. */
  readonly modelInvocable: boolean
  /** Whether human-facing command catalogs and loaders include this skill. */
  readonly userInvocable: boolean
}
```

```ts type-equiv
/** Invocation-neutral skill metadata returned by `ctx.skills.list()`. */
interface SkillSummary {
  /** Absolute instruction file path when supplied by the provider; absent for virtual skills. */
  readonly path?: string
  /** Kebab-case identifier used to address the skill. */
  readonly name: string
  /** Short routing description shown by discovery consumers. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved model and user invocation controls. */
  readonly invocation: SkillInvocationPolicy
  /** Discovery source that produced this winning skill. */
  readonly source: SkillSource
  /** Provider that owns this skill body. */
  readonly provider: string
  /** Provider-specific base for relative resources. */
  readonly resourceBase?: SkillResourceBase
}
```

`ctx.skills.list()` 保留全部四种策略组合。`isModelInvocable(skill)` 和 `isUserInvocable(skill)` 分别读取对应的必填字段。仅供模型调用的 skill 设置 `{ modelInvocable: true, userInvocable: false }`，仅供用户调用的 skill 设置 `{ modelInvocable: false, userInvocable: true }`，两个字段均设为 `false` 后，该 skill 只能由受信的 `ctx.skills.get()` 调用方获取。本地提供方读取名称完全匹配的 kebab-case frontmatter 键 `disable-model-invocation` 和 `user-invocable`，将省略的字段默认为 `true`，并为每个解析出的 skill 生成这个规范化策略。

`SkillCatalogSnapshot` 用于区分已确定的不存在与提供方的瞬时失败或发现期间持续变化的目录。`skills` 包含该次观测中收集、排序且与调用策略无关的摘要；只有每个已注册提供方都在没有并发目录修订时完成发现，`complete` 才为 true。不完整快照不会缓存，因此每个消费方可以保留上一份经过自身过滤的可用目录并重试。

```ts type-equiv
/** One catalog observation plus whether discovery completed within a stable catalog revision. */
interface SkillCatalogSnapshot {
  /** Sorted invocation-neutral summaries collected in this observation. */
  readonly skills: SkillSummary[]
  /** Whether every registered provider completed without a concurrent catalog revision. */
  readonly complete: boolean
}
```

`SkillCandidate` 是提供方到注册表的形状。`locator` 是提供方的不透明状态；注册表只存储它并在调用获胜提供方的 `get()` 时传回。

```ts type-equiv
/** Provider catalog entry used by the registry to merge and later load skills. */
interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names before provider registration order is considered. */
  readonly rank: number
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  readonly locator: unknown
  /** Parsed optional metadata object from provider-specific skill frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

`SkillDefinition` 是 `ctx.skills.get()` 返回的完整解析结果，供 `skill` 工具使用。`resourceBase` 告知工具如何为本地、URL 或提供方管理的 skill 渲染相对资源引导。

```ts type-equiv
/** Optional provider-specific base used by loaded skill bodies to resolve relative resources. */
type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }
```

```ts type-equiv
/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after any provider-specific metadata removal. */
  readonly content: string
  /** Parsed optional metadata object from frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

运行时 skill 输入可以省略调用控制和提供方标签。注册表会一次性补全这两项默认值，随后使用与提供方相同的完整定义形状和先到先得收集顺序。返回的 disposer 移除该贡献并使发现缓存失效。

```ts type-equiv
/** Runtime skill contribution accepted by `ctx.skills.register()`. */
type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
  /** Invocation controls; omission permits both model and user surfaces. */
  readonly invocation?: SkillInvocationPolicy
  /** Provider label; omission uses the registry-owned runtime provider. */
  readonly provider?: string
}
```

## 查找与配置

skill 查找对 cwd 敏感，因为提供方可能暴露工作区本地的 skill；可选的 signal 为调用方取消提供方的工作。注册表读取还通过 `SkillViewOptions` 携带观察 scope——消费方传入调用中的 agent，agent 本身就是自己的 scope key；注册表消费 `scope` 做层选择，提供方只从同一个借用的选项对象中读取其 `SkillLookupOptions` 约定。取消在目录选择前后（包括缓存命中时）都会检查，并与发现和完整定义加载竞争。如果找不到 git root，本地提供方将所提供的 cwd 本身视为项目根目录。

注册表不缓存完整定义。每次调用 `get()` 都会携所选候选项调用胜出提供方，因此本地提供方会重新读取当前正文。名称与该候选项不再匹配的定义会被拒绝，并使该提供方实例失效以便重新发现。

```ts type-equiv
/** Caller context used for cwd-sensitive and abortable provider work. */
interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}
```

```ts type-equiv
/**
 * Registry read options: provider lookup context plus the viewing scope.
 * The registry consumes `scope` to select layers; providers receive the same
 * borrowed options object and read only their {@link SkillLookupOptions}
 * contract from it.
 */
interface SkillViewOptions extends SkillLookupOptions {
  /** Viewing scope (the calling agent); omitted reads the global layer alone. */
  readonly scope?: ScopeKey | undefined
}
```

注册表拥有发现缓存上限，并通过 `retrieve()` 提供元数据选择。本地提供方拥有文件系统根目录（`dshHome`、`agentsHome`、`customSkillDirs`，以及可选的 `bundledSkillDir`/`DSH_BUNDLED_SKILL_DIR`）和 watcher 控制。消费方拥有投影模式、建议数量、渲染元数据字节、查询长度及描述上限。确切的默认值和校验规则见自动生成的[插件配置目录](../config-catalog.zh.md)。

```ts type-equiv
/** Skill registry configuration. */
interface Config {
  /** Maximum number of completed cwd/provider catalogs kept in memory. */
  readonly collectCacheMaxEntries?: number
}
```

## 会话目录与工具约定

`ctx.skills.retrieve({ cwd, scope, signal, query, limit, maxBytes, requestedNames?, descriptionMaxLength? })` 从与 `snapshot()` 相同的权威作用域获胜条目选择元数据。导出的纯函数 [`selectSkillCatalog`](../../packages/skill/skill/src/catalog-selection.ts) 按名称、描述和 `whenToUse` 词汇排序，返回原始的模型可调用摘要，不调用提供方正文加载器。结果包括发现 `complete`、`mode: 'relevance'`、`metadataBytes`、`omittedCount` 和 `explicitOverflow`。精确请求名称可超过普通数量及字节上限；`preserveNamedSkills: true` 还会识别可信查询中的名称。模型搜索关闭此选项。`list()` 与 `get()` 不受影响。

`dsh-tool-skill` 支持兼容默认值 `catalogMode: all` 和 `catalogMode: relevant`。两种模式都转发当前 cwd、scope 和取消信号，只渲染名称及规范化、经 XML 转义的描述。相关性模式默认最多八个普通建议、6000 UTF-8 条目行字节、最新任务查询后缀的 4096 个字符，以及每条描述 500 个字符。固定指引和搜索结果包装另计。当前已认领的 `source.kind: user` 文字提供查询，工具续步使用最新可见用户任务；注入规则、回忆、模型文字和工具输出不能提供查询。精确名称从权威任务全文单独提取，避免较早的显式名称因查询截断而丢失。每次模型步骤不扫描管理库，也不加载正文。

消费方通过获准的 `agent/pre-step` 决策追加目录消息。`all` 模式完整目录替换较早可用列表；相关性模式短名单替换建议，并明确还可能存在其他技能。空短名单不会撤销其他精确名称。来源记录任务消息 ID、元数据字节数、省略数量及显式预算例外。digest 包括渲染条目、投影模式及加载/搜索工具的精确可见性。不完整快照保留最后可用视图。目录变化仍保留历史直到普通压缩；建议上限不是完整提示词或已加载正文的上限。

面向模型的 `skill({ name })` 工具校验 kebab-case 名称，在与调用策略无关的目录中查找摘要，并在加载前通过 `isModelInvocable` 拒绝无权访问的 skill；随后它根据调用方 agent 的 cwd 重新读取完整定义，并在返回内容前再次检查策略。该工具将无法解析的 skill 报告为未知或已不可用，并返回包含 `<skill_content name="...">`、`<skill_resources>` 和 `<skill_instructions>` 的工具结果。`resourceBase` 仅按需解析显式引用的脚本、参考资料和资产；加载结果不枚举 skill 目录。因此，仅修改正文会改变后续工具调用，而不会生成目录消息或改写先前工具结果。

相关性模式的 `search_skills({ query })` 从作用域注册表进行有上限的元数据搜索；模型查询没有显式预算例外。省略的精确名称仍可按模型调用策略加载。用户 `/name` 保留原有指令注入路径，包括仅用户可调用的技能。完整正文不因元数据预算而被截断。

随附源码在基础 CLI 行及 web `standard`、`ptc`、`cordis` preset 行启用相关性模式。Harness 循环的 spawn/fork 和工作流子任务在组合挂载这些行时获得该行为；SDK 子任务取决于自己的命名 profile 和 patch。原生 Codex 后端可接收已记录的 Harness 指引，但原生技能目录及工具仍独立管理。外部 Claude Code/Codex 与 ACP 子任务绕过此消费方，因此其目录不受此选择器限制。现有用户 profile 可以覆盖随附配置。

## 学习观察与审核

[Host 技能库](../../packages/skill/skill-library/README.zh.md) 将观察记录和语义提案与技能文件分开保存。[运行时采集器](../../packages/skill/skill-library/src/learning-runtime.ts) 在持久化后记录活动根 Session 的工作，要求至少两次具体的 Harness 工具调用，以及一个未报告错误的配对结果。它跳过继承、种子、委派、琐碎、中断及失败任务。有上限的任务文字与助手完成声明仍未经验证；不保留原始工具参数或输出，采集器不提供验证检查。

仅当缓存的提供方元数据明确声明 `auxiliaryGeneration: api` 时，建议生成才使用任务捕获的路由。原生或未声明的路由保持不可用，手动生成需要活动的根证据 Session。Host 在加载完整正文前选择相关的受管理来源，拒绝过大或疑似凭据的输入，并在创建项目技能前检查已有元数据。生成器只能返回不确定的建议，不能指定路径、权限或验证依据；[学习类型](../../packages/skill/skill-library/src/learning-types.ts) 定义证据、完整差异及独立回执。

审核保留来源与保留技能的指令、资源哈希、约束、已解析的引用目标和不确定性。归档保留技能引用身份及外部目标；等价包内资源可以迁移。应用会在来源写入队列内复查当前来源与保护状态，保留回滚历史，并在继续前核对中断应用。创建始终需要审核。自动更新、压缩或归档还需要已批准的策略、每个文件的当前授权，以及绑定完整提案并具有已通过来源检查的独立可信回执。默认不附带可信语义验证器；仅凭完成状态、工具结果或模型声明不能授权自动更改。

## 浏览器 Session 目录

`SkillListRequest` 通过 `sessionId` 指定一个 Session；`SkillListValue` 返回允许用户调用的条目，其中包含名称、描述、可选使用提示与模型调用可用性。`SessionSkillCatalog` 在不激活 Agent 的前提下读取 Session cwd 与记录的 preset。live Agent 可以提供其作用域 registry，冷 Session 则使用 preset 的 standing scope。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionskillcatalog--sessionskillcatalog"></a>

### `ctx.sessionSkillCatalog` — `SessionSkillCatalog`

Host service backing `ctx.remote.skills` without activating a cold Agent.

```ts cordis-catalog
/**
 * List the user-invocable skills visible to one Session composition.
 * @param request - Session identity whose cwd and preset select the catalog view.
 * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
 * @returns user-invocable skill metadata without loading skill bodies.
 * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
 */
@Remote async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue>
```

Source: [`packages/api/session-controller/src/skill-catalog.ts`](../../packages/api/session-controller/src/skill-catalog.ts)

<a id="ctxskilllibrary--skilllibrarycontroller"></a>

### `ctx.skillLibrary` — `SkillLibraryController`

Owns the `skillLibrary` Remote namespace and local native-provider registrations.

```ts cordis-catalog
/**
 * Register metadata from an already-connected native route.
 * @param provider - process-free discovery adapter.
 * @returns provider disposer.
 */
registerNativeProvider(provider: NativeSkillLibraryProvider): () => void

/**
 * Read inventory summaries.
 * @param request - optional project selector.
 * @returns metadata, scopes and provider coverage.
 */
@Remote('list') list(request: SkillLibraryListRequest): Promise<SkillLibraryList>

/**
 * Load one selected instruction body.
 * @param request - stable library identity.
 * @returns detail and revision history.
 */
@Remote('detail') detail(request: SkillLibraryIdRequest): Promise<SkillLibraryDetail>

/**
 * Protect a skill from maintenance.
 * @param request - identity and pin value.
 * @returns updated item.
 */
@Remote('setPinned') setPinned(request: SkillLibraryPinRequest): Promise<SkillLibraryItemValue>

/**
 * Adopt a current local version without automatic cleanup.
 * @param request - identity and expected hash.
 * @returns updated item.
 */
@Remote('adopt') adopt(request: SkillLibraryHashRequest): Promise<SkillLibraryItemValue>

/**
 * Explicitly opt one managed version into conservative cleanup.
 * @param request - unchanged managed file and opt-in.
 * @returns updated item.
 */
@Remote('setAutomaticCleanup') setAutomaticCleanup(request: SkillLibraryAutomaticRequest): Promise<SkillLibraryItemValue>

/**
 * Archive a whole selected bundle reversibly.
 * @param request - identity and expected hash.
 * @returns archived item.
 */
@Remote('archive') archive(request: SkillLibraryHashRequest): Promise<SkillLibraryItemValue>

/**
 * Restore a selected archive into a vacant original location.
 * @param request - archived identity.
 * @returns restored item.
 */
@Remote('restore') restore(request: SkillLibraryIdRequest): Promise<SkillLibraryItemValue>

/**
 * Preview conservative managed-file compression.
 * @param request - selected ids or all eligible entries.
 * @returns source diffs and skipped reasons.
 */
@Remote('previewCleanup') previewCleanup(request: SkillLibraryCleanupRequest): Promise<SkillCleanupProposal>

/**
 * Apply an unchanged cleanup preview.
 * @param request - live preview identity.
 * @returns changed library identities.
 */
@Remote('applyCleanup') applyCleanup(request: SkillLibraryApplyRequest): Promise<SkillLibraryApplyValue>

/**
 * Restore previous instructions as a new revision.
 * @param request - expected current hash and previous version.
 * @returns updated item.
 */
@Remote('rollback') rollback(request: SkillLibraryRollbackRequest): Promise<SkillLibraryItemValue>

/**
 * Select metadata before progressively loading bodies.
 * @param request - current project and routing query.
 * @returns bounded ranked metadata.
 */
@Remote('retrieve') retrieve(request: SkillLibraryRetrieveRequest): Promise<readonly SkillLibraryItem[]>

/**
 * Record verified explicit instruction delivery.
 * @param request - exact library/version identity and observation.
 * @returns persistence completion.
 */
recordLoad(request: { readonly id: SkillLibraryId readonly contentHash?: string readonly loadedAt?: string readonly sessionId?: string }): Promise<void>

/**
 * Register a bounded suggestion provider.
 * @param provider - bounded suggestion capability.
 * @returns registration disposer.
 */
registerLearningGenerator(provider: SkillLearningGenerator): () => void

/**
 * Register a separate independent validation provider.
 * @param provider - separately trusted independent check capability.
 * @returns registration disposer.
 */
registerLearningValidator(provider: SkillLearningValidator): () => void

/**
 * Capture immutable task observations without inferring success.
 * @param observation - immutable host-captured task events; completed turns alone are unverified.
 * @returns retained evidence.
 */
recordLearningEvidence(observation: SkillLearningObservation): Promise<SkillLearningEvidence>

/**
 * Publish observed project route availability.
 * @param projectId - selected registered project.
 * @param value - observed route support.
 */
setLearningAvailability(projectId: string, value: Omit<SkillLearningAvailability, 'projectId'>): void

/**
 * Read provider availability and semantic consent.
 * @param request - current project.
 * @returns provider availability and separately approved policies.
 */
@Remote('learningStatus') learningStatus(request: SkillLearningListRequest): SkillLearningStatus

/**
 * Read captured task observations.
 * @param request - project filter.
 * @returns immutable observations available for review requests.
 */
@Remote('listLearningEvidence') listLearningEvidence(request: SkillLearningListRequest): readonly SkillLearningEvidence[]

/**
 * Generate a durable uncertain suggestion.
 * @param request - substantial task observations and selected local targets.
 * @returns durable uncertain proposal.
 */
@Remote('proposeLearning') proposeLearning(request: SkillLearningProposeRequest): Promise<SkillLearningProposal>

/**
 * Read metadata-only proposal summaries.
 * @param request - project filter.
 * @returns body-free proposal summaries.
 */
@Remote('listProposals') listProposals(request: SkillLearningListRequest): readonly SkillLearningProposalSummary[]

/**
 * Load a complete retained proposal.
 * @param request - proposal identity.
 * @returns full source diff and retained evidence.
 */
@Remote('detailProposal') detailProposal(request: SkillLearningProposalRequest): Promise<SkillLearningProposal>

/**
 * Check the proposal through an independent provider.
 * @param request - selected proposal.
 * @returns separate independent validation findings.
 */
@Remote('validateProposal') validateProposal(request: SkillLearningProposalRequest): Promise<SkillLearningProposal>

/**
 * Apply an admitted proposal with reversible source history.
 * @param request - reviewed or separately authorized proposal.
 * @returns durable application outcome.
 */
@Remote('applyProposal') applyProposal(request: SkillLearningApplyRequest): Promise<SkillLearningProposal>

/**
 * Retain a rejected suggestion in history.
 * @param request - selected suggestion.
 * @returns retained rejected history.
 */
@Remote('rejectProposal') rejectProposal(request: SkillLearningProposalRequest): Promise<SkillLearningProposal>

/**
 * Approve a semantic policy without enabling any file.
 * @param request - explicit independent validator and allowed operations.
 * @returns policy without enabling any file.
 */
@Remote('approveLearningPolicy') approveLearningPolicy(request: SkillLearningPolicyRequest): Promise<SkillLearningPolicy>

/**
 * Enable or revoke separate semantic consent.
 * @param request - per-file consent for separate semantic policy.
 * @returns enabled or revoked consent.
 */
@Remote('setAutomaticLearning') setAutomaticLearning(request: SkillLearningAutomaticRequest): Promise<SkillLearningOptIn>
```

Source: [`packages/skill/skill-library/src/index.ts`](../../packages/skill/skill-library/src/index.ts)

<a id="ctxskills--skillregistry"></a>

### `ctx.skills` — `SkillRegistry`

Layered registry of skill providers, the host+per-scope shape the tools registry established. A registration files into the layer of its calling context's scope (scopeOf): host rows and repository plugins land in the global layer, while a plugin mounted by an agent preset's standing composition lands in that preset's layer. A read merges the global layer with the viewing scope's chain — the nearest layer's entry wins a duplicate name outright, and the rank order decides duplicates only within one layer. It exposes sorted invocation-neutral summaries and loads full skill bodies on demand.

```ts cordis-catalog
/**
 * Register a borrowed same-process provider synchronously during plugin
 * apply, into the calling context's layer: a scoped context (an agent
 * preset's standing mount) registers for that scope alone, an unscoped
 * context registers globally. Duplicate names within one layer and reserved
 * names throw; remote initialization belongs in `list()`. Fiber disposal
 * unregisters the provider and invalidates catalog caches.
 * @param create - synchronous factory receiving this registration's lifecycle and invalidation control.
 * @returns the exact Cordis effect disposer that unregisters this provider;
 *   composite effects may yield it directly to preserve teardown ordering.
 */
registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void

/**
 * Register a borrowed readonly runtime skill into the calling context's
 * layer. Project entries outrank runtime entries, which outrank user
 * entries, within one layer. Same-name runtime entries in one layer are
 * first-wins; a duplicate logs a warning and receives a no-op disposer so
 * it cannot remove the winner.
 * @param skill - the skill definition input; omitted invocation and provider fields receive defaults.
 * @returns the exact Cordis effect disposer, preserving composite teardown order and invalidating caches.
 */
register(skill: SkillRegistration): () => void

/**
 * List invocation-neutral skill summaries for a workspace. Consumers apply
 * model or user invocation policy at their operational boundary. Lookup
 * options and provider candidates are readonly same-process values borrowed
 * throughout discovery.
 * @param options - view options; `scope` selects the viewing agent's layers, `cwd` selects project roots, and `signal` cancels discovery.
 * @returns all sorted winning summaries.
 */
async list(options: SkillViewOptions = {}): Promise<SkillSummary[]>

/**
 * Observe the current invocation-neutral catalog and whether discovery completed within a stable revision.
 * Incomplete observations are never cached, allowing consumers to retain last-good state and
 * retry on their next request boundary.
 * @param options - view options; `scope` selects the viewing agent's layers, `cwd` selects project roots, and `signal` cancels discovery.
 * @returns sorted summaries plus discovery-completeness state.
 */
async snapshot(options: SkillViewOptions = {}): Promise<SkillCatalogSnapshot>

/**
 * Retrieve a bounded relevance projection of the scoped metadata winners.
 * Explicit names remain loadable through `get()` regardless of suggestion budgets.
 * @param options - scoped lookup, bounded query and metadata selection policy.
 * @returns selected original summaries, completeness, and shortlist accounting.
 */
async retrieve(options: SkillViewOptions & SkillCatalogSelectionOptions): Promise<SkillCatalogSelection<SkillSummary> & { readonly complete: boolean; readonly mode: 'relevance' }>

/**
 * Load and validate the winning candidate, passing its opaque discovery locator back to the
 * provider. Cancellation is rechecked after selection, including cache hits, and raced against
 * loading so an uncooperative provider cannot hang the caller.
 * @param name - kebab-case skill name.
 * @param options - view options; `scope` selects the viewing agent's layers,
 *   `cwd` selects workspace-sensitive skills, and `signal` cancels work.
 * @returns the full skill, including body content, or `undefined`.
 */
async get(name: string, options: SkillViewOptions = {}): Promise<SkillDefinition | undefined>
```

Source: [`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts)

<a id="skills-events"></a>

### `skills/*` events

<a id="skillschange--emit"></a>

#### `skills/change` — emit

A skill provider, runtime contribution, or provider-backed catalog may have changed. This is an unfiltered invalidation notification; consumers refetch the catalog for their own lookup options. Listener failures are contained and cannot veto the registry mutation.

```ts cordis-catalog
/**
 * A skill provider, runtime contribution, or provider-backed catalog may
 * have changed. This is an unfiltered invalidation notification; consumers
 * refetch the catalog for their own lookup options. Listener failures are
 * contained and cannot veto the registry mutation.
 * @mode emit
 */
'skills/change'(): void
```

Source: [`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts)
<!-- END GENERATED cordis-surface -->

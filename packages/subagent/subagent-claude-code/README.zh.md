---
description: "面向用户与维护者的 Claude Code 委派和可选常规根轮次，用于配置原生产品路由。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-claude-code

[English](README.md) | 中文

## 概述

安装这个 Profile Bundle，可在父工作区中运行全新、无人值守的 Claude Code 委派。每次运行接受一个自包含文本任务，并返回最终答案或安全的失败诊断；推理、工具通信、stderr、用量信息和工作区差异不会进入父 Session。Claude 原生设置与身份验证继续是权威来源；Profile 配置选择模型、环境和 `permissionMode`。针对平台锁定的运行时仅在需要时启动，不会回退到宿主 `claude`。显式的 `rootRoute` 启用常规纯文本根轮次，每个 Harness Session 保持一个活动原生 query；默认处于休眠状态。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当委派应以父级工作区中的真实 Claude Code 会话运行时，挂载本提供方。常用路径是显式的：把 Bundle 安装进 Profile，可选地配置提供方行，并通过委派工具行把它暴露给模型。

### 安装 Bundle

把包安装进目标 Profile，然后重启该 Profile。安装会把锁定的 Agent SDK 与一个兼容的平台 CLI 载荷带入 Profile；声明的 patch 层只注册休眠的提供方，不启动任何 Claude 进程。

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-claude-code
dsh --profile <name>
```

移除包后，下一次 Profile 启动会撤回提供方及其私有运行时闭包。安装决定 Host 可用性，而不是模型权限：模型只能通过你组合的委派工具行触达提供方。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `claude-code` | `ctx.subagents` 上的非空注册名称；每个已挂载实例都需要唯一值 |
| `model` | Claude 原生设置 | 为本提供方实例的每次运行固定的可选非空模型名称；省略时不发送 SDK 覆盖 |
| `env` | `{}` | 叠加在已清理凭据的父环境之上的显式 SDK/CLI 环境 |
| `permissionMode` | `dontAsk` | 为本提供方实例的每次运行固定的原生非交互权限策略 |
| `disposeGraceMs` | `3000` | 共享 managed-range owner 各终止层级之间的宽限 |
| `toolObservationMaxItems` | `64` | 直接子级工具身份收集上限，必须是 1 到 256 的整数；超限时丢弃整批观测 |
| `rootRoute` | 未配置 | 可选常规根路由，明确指定 `connectionId` 和 `model`；限制与隔离独立于子任务设置 |

| `permissionMode` 值 | 原生行为 |
|---|---|
| `dontAsk` | 不弹出提示，直接拒绝尚未获授权的操作 |
| `acceptEdits` | 接受文件编辑；其余权限提示由无人值守回调拒绝 |
| `auto` | 由 Claude Code 原生分类器允许或拒绝权限请求 |
| `plan` | 使用原生规划模式，拒绝执行审批，并把完整计划作为最终答案返回 |
| `bypassPermissions` | 显式设置 SDK 的危险确认并跳过权限检查 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-claude-code)是每个受支持字段及其 JSDoc 的穷尽式真源。已配置的 `model` 会原样传给该提供方实例的每次 query；省略时保留原生模型选择。具有凭证特征的环境变量会在显式 `env` 覆盖生效前被移除，因此供子进程使用的 API 密钥必须在该配置中显式提供。提供方省略 SDK 的 `settingSources` 选项，因此 Claude Code 会相对于父会话 cwd 读取宿主机常规的用户、项目与本地设置。它不会复制或过滤这些文件、创建或修改登录状态、检查 `PATH`，也不会回退到宿主 `claude` 可执行文件。

### 常规根轮次

在已安装的提供方行设置 `rootRoute.connectionId` 与 `rootRoute.model`，然后为根 Agent 选择提供方 `claude-code-native` 和该精确模型。路由要求活动 Session 的 cwd 精确等于已注册项目根目录。子任务 `env`、模型及权限模式不配置此路由。根请求接受文本历史；不支持每次请求的推理力度、服务层级、token 覆盖、嵌套 Session 或辅助生成。

路由在同一个活动 Harness Session 的兼容轮次间保留一个受隔离的 SDK query，并禁用原生转录持久化。原生默认权限策略仍生效。只返回拒绝或中立结果的 `PreToolUse` hook 会在每次工具调用前复查发起 Agent、Session、项目及当前 sandbox 策略；原生权限提示通过 Harness 审批精确动作，只允许 `allowed-once`。策略收窄、取消、不支持的嵌套或后台工作、召回记忆、上下文重置及压缩会关闭 query。路由要求完整进程强制隔离，拒绝完全访问模式，也拒绝与原生配置或身份验证路径重叠的可写根目录。策略之外的原生缓存或身份验证刷新写入可能失败；路由绝不扩大根目录。

路由捕获实际启动的 POSIX `HOME` 或 Windows `USERPROFILE`，以及 `CLAUDE_CONFIG_DIR` 路径，并从现有祖先解析缺失后缀。这些路径写入有上限的持久公共协议记录。`connectionId` 是部署标签，不代表账户、外部 CLI 配置或可复用原生 Session。配置工具为 Read、Glob、Grep、Bash、Edit 和 Write；禁用从文件加载的设置、技能、插件及外部 MCP，并检查实际原生 init 声明。

`maxSessions`、`maxItems`、待处理帧、输入、输出、完整 Session 字节及轮次时长限制约束保留工作。关闭会取消待处理隔离及直接结果等待，然后观察受管理范围 `disposeGraceMs + 1000` 毫秒，并以计时器上限封顶。确认失败会关闭协议流、保留失败进程所有权并阻止进一步接纳。精确公共 SDK 输入、system 及所拥有的上下文帧作为持久可忽略 `claude-code/root-protocol` 记录，与净化的 `skill/native-item` 学习分开保存。它们保留可观察记录；不能从中重建隐藏的原生提示、工具 schema 或私有记忆。此临时根路由不支持重启、外部 CLI 续接或交替原生写入者。下述独立顺序模式用于恢复已持久化的原始会话。

### 原始会话的顺序对话交接

[原始配置 coding-session 来源](../../session/coding-session/README.zh.md) 通过可选的 `sequentialHandoff` 对象及 `knownUnmanagedStartup: true` 明确启用可持久化的同 ID Claude 对话轮次。该字段默认为 false；省略对象、false 或未确立的声明使来源保持只读。该对象要求为固定的 Claude 2.1.263 可执行文件明确提供 `nativeExecutablePath` 与精确的 `nativeExecutableSha256`。`codingSessions` 服务独立的 `enableSequentialHandoff` 设置默认为 false，也必须启用。本模式与子任务设置及临时 `rootRoute` 相互独立。它要求所选活动、空闲且同项目的 Y 根 Session，确切原始配置、项目与会话，以及其他写入方已关闭、原生配置在释放前保持不变的确认。

`knownUnmanagedStartup` 是可信部署方的声明，表示所选账户、配置及机器不存在受管、远程、helper 或父进程启动策略，独立于用户对写入方及配置的确认。每次发送前，所选配置的新 worker 通过公开 `resolveSettings({ cwd, settingSources: [] })` 进行观察；只有受支持且为空的设置级联才生成 `noManagedSettingsObserved: true` 与指纹。设置、逐字段设置来源或来源列表非空、形状未知、解析抛错、stderr 出现任何字节或缺少完整 stderr 覆盖证据时，在持久发送标记及查询前拒绝。SDK 0.3.263 不提供解析错误列表、跳过 policy helper 执行，也无法证明新的远程策略不存在。该声明是操作假设，不是无错误启动证书、原子策略固定，也不绕过受管策略。

每个轮次启动全新的有限 SDK 查询，恢复原始 ID 并启用持久化；不会分叉或替换历史。适配器不提供新的模型或推理强度覆盖值；实际选择由原生恢复及设置解析决定，不保证与此前 CLI 轮次相同。原生项目工具、从设置加载的技能、插件及外部 MCP 均被禁用。原生进程仅可写入所选项目的对话记录目录，本模式不能执行项目工作。仅子进程使用的 `CLAUDE_CODE_DISABLE_FAST_MODE=1`、`settings.fastMode: false`、`settings.fastModePerSessionOptIn: true` 与 `settingSources: []` 禁用 Fast，不改写原始配置设置。原生保留上下文仍受 Claude 压缩和保留规则约束；续写不传递中断工具或私有活动状态。

执行器在发起的 Y Session 中记录有界的公开输入与协议帧。成功释放要求所拥有的进程与范围自然退出、stdout 和 stderr 排空、未观察到诊断或持久化失败，以及原始配置的全新读取确认保留前缀和已发送用户及助手正文完全匹配。SDK result、空闲或 `Query.close()` 本身不能建立这些证据。不确定的释放持续阻止继续，包括重启后失去进程句柄的情况。释放成功后才能在外部恢复同一 ID；代码回滚不能移除已追加的原生轮次。[coding-session 服务](../../session/coding-session/README.zh.md) 负责持久认领、续写与释放控制。

### 暴露工具

每个委派工具行指名一个提供方，并需要独立的 `toolName`，因此模型看到的是静态工具，而不是动态提供方选择器。完整 Agent Preset 携带对应的默认工具行并设置 `disabled: true`；复制一个 preset 后删除该字段，即可只向由该副本组装的 agent（智能体）暴露 `subagent_claude_code`。

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: tool-subagent-claude
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: claude-code
    toolName: subagent_claude_code
    backgroundMode: one-shot
    maxDepth: provider-managed
```

`one-shot` 策略会让省略 `run_in_background` 或传入 `false` 的调用继续在前台等待，而显式传入 `true` 会返回由父 agent 拥有的 job id，供 `job_output` 或 `job_kill` 使用；base host（基础宿主）与完整 preset 已提供通用作业注册表和控制工具。

### 你会得到什么

前台调用会把严格的最终 Claude Code 答案交给模型；运行失败时则返回带停止原因与可选安全诊断的错误。后台调用先返回 job id；随后通用作业控制面会送达完成通知，并通过 `job_output` 公开同一最终答案或失败状态。Claude Code 的推理、工具活动、中间消息、stderr 与工作区差异绝不会进入父级会话。

### 失败与恢复

省略 optional dependencies、当前平台不受支持或所选载荷缺失的安装会让提供方保持休眠，并在第一次委派时于 SDK 启动边界报告安全的 `query-start` / `unknown` 失败事实；不存在宿主 CLI 回退。原始产品错误只保留在内部 cause 链与提供方 Host 日志中。被取消的运行以 `aborted` 结算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方如何驱动真实 Claude Code CLI，以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **每次子任务运行一个全新 query。** 每次子任务运行都拥有独立的 SDK query、取消控制器、CLI 进程与不持久化的产品会话；没有续接、恢复或池化。
- **原生子任务设置是权威。** 子任务提供方故意省略 SDK 的 `settingSources` 选项，因此 Claude Code 读取宿主机常规的用户、项目与本地设置；可选 `model` 与必需的 `permissionMode` 是仅有的 query 级覆盖。
- **无人值守的子任务委派。** `AskUserQuestion` 被禁用，除 bypass 模式外权限提示都会被拒绝，因此子任务 query 绝不会等待用户界面。

实时 `claude-code/tool-observations` 事件向以发起委派的父 Agent 为作用域的观察者发布冻结且有界的子级诊断，并单独携带该 Agent 的确切 Session。每条回执保留 SDK 会话 id、作为 `sourceMessageId` 的 assistant 消息 UUID、工具调用 id、可选的实际结果消息 UUID、允许列表中的工具名称、动作类型与报告结果。消息 UUID 标识来源消息，不是原生轮次。工具结果中显式的 `is_error` 值决定 `reported-success` 或 `reported-error`；省略时保持 `unknown`。事件不向父 Session 追加证据、不验证任务完成，也不保留参数或输出正文。仅在迭代器正常结束时发布；取消、资源释放或已观测的进程失败之后禁止发布。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、提供方注册 |
| [`src/run.ts`](src/run.ts) | SDK query 生命周期、结果接受与权限处理 |
| [`src/process.ts`](src/process.ts) | dispose（资源释放）时的 managed-range 逐级终止 |
| [`src/tool-observations.ts`](src/tool-observations.ts) | 有界的直接 SDK 工具回执关联与清理 |
| [`src/root.ts`](src/root.ts)、[`src/root-process.ts`](src/root-process.ts)、[`src/root-profile.ts`](src/root-profile.ts) | 可选根 query、发起权限、完整隔离与配置路径隔离 |
| [`src/root-observations.ts`](src/root-observations.ts)、[`src/root-types.ts`](src/root-types.ts) | 实际 SDK 标识配对与独立的有上限公共协议记录 |
| [`src/sequential.ts`](src/sequential.ts) | 独立的全新原始 ID 对话轮次及单独确认排空的原生进程 |
| [`cordis.patch.yml`](cordis.patch.yml) | 注册休眠提供方的 Profile patch 层 |

### 运行流程

一次启动只接受非空的文本块序列，并根据父会话确定子级 cwd。它创建私有 `AbortController`，用精确拼接的任务调用官方 SDK `query()`，并仅在 SDK 的 custom-spawn 钩子已经提供由子进程 seam 管理的活动 CLI 句柄后发布运行。提供方完整迭代消息流，只接受满足 `subtype: "success"`、`is_error: false` 且 `result` 非空白、随后迭代器正常结束的 `result` 消息。其余一切结果都映射为带固定类别的 `error` 诊断，命名生命周期阶段与已观测进程结果——类别集合见 [`src/run.ts`](src/run.ts)。本地取消会在结果竞态中胜出并映射为 `aborted`，且不附带失败诊断。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本提供方逐步进入它接入的 seam 与兄弟产品提供方。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md)——本提供方注册于其上的注册表与启动 API。
- [Codex subagent 提供方](../subagent-codex/README.zh.md)——经官方 app-server 协议的兄弟产品后端。
- [历史Claude Code 与 Codex 后端](../../../.agents/notes/archived/feature/2026-08-04-claude-code-and-codex-subagent-backends.md)——产品提供方的设计记录。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-claude-code)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子级请求

#### 模型看到什么

Claude Code 子级会在一个全新的 SDK query 中接收独立文本任务。它的工作区是父会话 cwd；所选提供方实例会固定已配置的模型、环境与非交互权限模式，而省略的模型及其余产品设置来自 Claude 原生配置。可执行版本来自 Bundle 锁定的 SDK 平台载荷。

#### Token 影响

子级需为独立的 Claude Code 上下文和 query 承担 token 成本。子级 token 不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。能否复用只取决于 Claude Code 自身的模型、指令、工具、原生设置和全新 query。

### 父级调度与结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，前台调用会让父级模型看到符合严格成功条件的 Claude Code 最终答案；若结果未完成，错误中会包含终止原因和可选的安全诊断。该诊断可以区分粗粒度行动类别、生命周期阶段和已观测的进程结果，而不复制原始产品文本或版本专属 subtype 名称。后台调用会先返回 job id；随后通用作业控制面会送达完成通知，通过 `job_output` 公开同一最终答案或失败状态详情，并允许 `job_kill` 请求取消。Claude Code 的推理、工具活动、中间消息、stderr、工作区差异、用量信息、产品标识符、工具输入和原始协议载荷均不会复制到父会话。

#### Token 影响

前台输入会增加工具结果中保留的最终答案或错误内容。后台输入还会包含启动确认、完成通知，以及 `job_output`、`job_kill` 或后续状态结果；子任务 token 仍不会进入父级上下文。本提供方自身不添加父级工具 schema。

#### KV Cache 影响

仅追加：前台会在可复用的父请求前缀后增加一个结果，后台则会继续追加 Job 启动确认、通知以及后续控制或收集结果。后台调度可能增加一个由通知唤醒的轮次，但这些消息都不会改写更早的前缀。

### 常规根请求

#### 模型看到什么

原生根模型接收所拥有的 system 和引用文本历史，然后在其活动 query 内接收原生工具结果。Harness 将助手文本投影到常规对话，并使精确公共协议记录与净化学习条目保持可忽略。续接标记绑定精确的投影历史和助手文本；它不能恢复隐藏原生上下文。

#### Token 影响

原生 query 在兼容的活动轮次间保留自身工具上下文。投影历史、system 或 sandbox 策略改变时，会以当前文本历史创建新 query；根限制阻止不支持的原生上下文改变。

#### KV Cache 影响

原生复用遵循活动 SDK query。公共协议记录和学习条目不增加 Harness 模型输入，也不承诺缓存或重启恢复。

### 顺序原生对话

#### 模型看到什么

Claude 恢复其保留的原生对话，并以原始 ID 接收一条明确的人类消息。query 禁用项目工具，不接收替代性的镜像记录。公开协议记录在发起 Y Session 中仅用于日志。

#### Token 影响

每次原生续写使用 Claude 保留的上下文并消耗原生模型 token。纯对话轮次不会为自动过程学习提供配对的项目工具观测。

#### KV Cache 影响

原生缓存行为遵循 Claude 的持久恢复与保留机制。镜像及公开协议记录都不承诺恢复隐藏上下文或缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


顺序对话不含项目工具，并要求释放完成后才能在外部恢复。无法仅凭记录元数据恢复未解决的所有权。以下子任务提供方限制说明委派何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 Claude Code 对比或任务积压。

- **每次运行均新建一个子 query 和一个进程**——不支持续接、恢复、池化、进度流或产品会话持久化。
- **直接诊断覆盖范围有限**——只有 Read、Glob、Grep、Bash、Edit、MultiEdit、Write、WebFetch 和 WebSearch 可贡献关联回执。回放、嵌套 worker、Agent/Task、MCP 与动态工具、后台任务、重复或孤立的身份，以及缺少或不匹配结果会话的回执均被排除。Bash 要求结构化的前台输出元数据；非结构化回执无法排除后台占位结果，因此被排除。诊断不证明任务成功，也不启用自动学习。
- **静态选择实例**——Profile 配置项固定提供方名称、可选模型与工具绑定；调用无法动态选择或修改提供方与模型，而且每个公开工具都需要唯一的 `toolName`。
- **宿主设置有意保持权威**——省略 `model` 时由项目与用户设置选择模型；原生设置始终保留其余工具和行为，本提供方不提供经过筛选或与宿主环境隔离的生产模式。
- **身份验证与账户状态仍由原生机制管理**——Bundle 会提供 CLI，但不会创建账户、登录或改写 Claude 设置；配置与身份验证失败会公开其生命周期阶段与安全的 `unknown` 回退，而不会增加单独的公开分类。
- **委派时必须存在 SDK 平台载荷**——省略 optional dependencies 的安装、不受支持的平台以及缺失或损坏的载荷都会在第一次 query 时失败；不会回退到宿主 CLI。
- **没有人工交互路径**——`AskUserQuestion` 被禁用，权限提示会被拒绝，MCP elicitation 会被拒绝，阻塞对话会以拒绝方式失败而不会挂起。
- **assistant 载荷仅包含最终文本**——失败运行可以额外公开独立的安全诊断；推理、中间消息、工具通信、用量信息、stderr 和工作区差异仍只保留在产品内部，通用 Job id、通知与状态来自共享作业运行时。
- **没有可选的共享能力**——对于本提供方，共享服务会拒绝 `agentOptions`、输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**——长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **载荷体积披露**——当前 darwin-arm64 平台载荷压缩后约 92 MB、解包后约 325 MB；这些是披露数字，不是安装阈值。
- **版本锁定的协议**——运行时依赖锁定为 Agent SDK 0.3.263；升级会锁定新的 SDK 版本，并需要重新运行无密钥真实产品与 loader 组合证据。

</details>

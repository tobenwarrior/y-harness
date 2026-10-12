---
description: "选择在隔离的 Harness profile 之间共享普通 provider 目录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-provider-config-sync

[English](README.md) | 中文

## 概述

在兼容且明确配对的 profile 之间共享普通 provider 名称、端点和模型目录。各应用保留自己的认证、会话历史、接收方限制和运行时 home。基础 bundle 挂载此插件，但默认不配置共享。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

两款应用都通过支持此包的代码验证后，在各已批准的 profile 中配置相同的本地绝对文件路径：

```yaml
- id: provider-config-sync
  name: '@deepseek-ai/dsh-provider-config-sync'
  config:
    sharedPath: /absolute/owner-only/provider-catalogs.json
```

未设置 `sharedPath` 时不会同步或创建文件。配对从不启用已禁用的适配器。缺少 `llm-pi-ai` namespace 的 profile 保持等待状态。特别是，仅获批使用 Sol/OpenAI 的 vault profile 保留该限制；配置其他 provider 时应使用独立限定范围的 profile。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sharedPath` | 未设置 | 已批准的本地 profile 共享的普通目录文档的明确绝对路径。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-provider-config-sync)完整列出所有接受的配置字段。

允许列表包含 `displayName`、`api`、不含凭据的 HTTP(S) `baseURL`、`models` 和 `modelOverrides`。模型字段包含 ID、名称、容量、支持的输入类型、推理选项和默认 effort。未知字段、请求头、API key 引用或值、OAuth grant 和客户端身份、cookie、vault 设置、实验控制、默认接收方和会话选择均被排除。含用户信息、任何查询参数或片段的 URL 会被拒绝，而非改写。

`ctx.providerConfigSync.synchronize()` 请求串行刷新，`status()` 报告就绪、等待配置、冲突或错误。同一 provider 的冲突保留本地和共享值。可明确编辑本地普通配置以匹配共享选择，或选择不同的共享路径来解决冲突。已有路由的协议或端点更改始终需要本地解决；同步不能静默重定向其授权。当删除会丢弃继承字段或被排除的本地字段时，删除保持冲突。重试前，应通过其所属设置界面确认并移除这些本地路由。

新的 API-key 路由获得目标应用拥有、唯一且刻意未配置的凭据引用。不创建凭据记录。需要时，通过该应用的掩码 provider 表单输入 key。新的 Nous 或已退役 ChatGPT 路由需要本地设置，因为它们不能使用这种缺失 key 保护。

### 认证同意

普通配置同步不会免除单独认证。当前支持的方式是用户在目标应用的掩码 key 表单中输入，或明确在目标应用中登录。用户选择是否在本地持久保存凭据；助手不查看或传输其值。

未来的安全传输需要单独且具体的同意，说明源和目标应用、provider/账户、准确的 key 或 grant 范围、访问是否持久以及撤销方法。交接必须直接在可信 Host 进程之间或经批准的 OS 凭据存储中进行，具备目标身份验证、仅所有者可访问的保护和 provider 范围的记录；不能经过聊天、普通共享文件、截图、日志或 Library。OAuth 传输还需要 provider 支持该目标和 grant audience。此插件不发起这种传输或新的授权 grant。让两款应用指向同一个完整凭据文件会共享无关访问，因此不属于此方式。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

每个 provider 与当前本地投影、共享记录和持久保存的共同基线比较。独立 provider 的编辑会收敛；同一 provider 的竞争更改保留双方内容并报告冲突。明确删除的 tombstone 保留在共享文档中。Namespace 消失和缺失 key 从不意味着删除。

共享文档使用版本 1 和当前 namespace schema 的指纹。未知版本、schema 不匹配、格式错误或不安全值会暂停同步，而不覆盖文件。各本地 profile 拥有的 receipt 将基线绑定到共享路径和 schema，使重启不会把过期 profile 重新发布到 tombstone 之上。已有基线但共享文件缺失时，需要恢复文件，而非自动重建。

共享写入方使用现有跨进程原子写锁和重命名提交。本地导入使用带 revision 检查的 Settings 修改，以及配置编辑器的锁定验证和协调流程。只有本地与共享 provider 投影一致后，receipt 才推进。通知合并到一个队列；销毁会关闭监听器并等待当前操作结束。文件以 `0600` 模式写入；仅支持同一主机的本地文件协调。

HMR 在其事务上下文之外启动队列和监听器。所有者取消会在调用方预期更改开始前结束排队和预检准备，包括外部 profile 协调导致的自我销毁。已经开始的 apply 会等待结束；原子替换前取消不会改变 patch，在此截止点之后取消则完成协调或已有回滚。共享文档和 receipt 在任何发布或本地导入前都限制为 1 MiB。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Settings 表单](../settings/README.zh.md)——当前 descriptor 和带 revision 的编辑。
- [配置编辑器](../../boot/config-editor/README.zh.md)——锁定持久化和回滚。
- [Pi-ai provider 配置](../../llm/llm-pi-ai/README.zh.md)——路由目录和可服务性。

<a id="model-experience"></a>
## 模型体验

### 提供方目录选择

#### 模型看到什么

插件不执行模型请求。同步目录仅在已允许且激活的 `llm-pi-ai` namespace 中可用。已有会话及其带 provider 限定的模型选择保持本地。

#### Token 影响

同步不添加提示词、工具 schema、消息或辅助模型请求。之后经用户授权的推理使用所选适配器的普通请求组装。

#### KV Cache 影响

没有直接影响。用户随后授权的模型选择保留所属适配器的缓存行为。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

共享要求兼容代码与明确配对；认证保留在本地。

- 配对需要在两款已验证的应用中明确激活。安装 Test 源码不会更新或提升 Main。
- 精确 schema 兼容性较保守；不支持的 schema 版本需要经审查的迁移。
- 认证传输、跨主机同步、冲突解决 UI，以及共享会话/默认接收方选择暂缓。
- 会丢弃被排除本地字段的远程删除或模型替换需要本地解决。Tombstone 不会自动压缩。
- 此包不提供推理使用权，也不执行实时 provider 验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

限定范围的 Main/Test 修复保留刻意分开的运行时 home 和已有 provider 接收方保护。模拟且无 key 的 fixture 负责同步验收。

</details>

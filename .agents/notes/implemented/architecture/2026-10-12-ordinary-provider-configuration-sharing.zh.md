# Agent Note: 普通提供方配置共享与本地授权

Status: implemented

[English](2026-10-12-ordinary-provider-configuration-sharing.md) | 中文

## 问题

独立应用 profile 各自保存提供方目录，因此用户反复进行普通提供方和模型设置。共享完整 Harness home 也会共享会话历史、凭据、vault 状态和实验控制。复制凭据引用可能静默绑定另一应用已有或环境中的授权，端点更改也可能将该授权发送给不同接收方。

## 决定

可选的 [provider-config-sync 包](../../../../packages/settings/provider-config-sync/README.zh.md) 仅通过明确的共享本地路径配对 profile。其严格投影包含普通路由名称、协议、不含凭据的端点和模型目录字段。会话/默认接收方选择、禁用标志、认证引用、请求头、OAuth 状态和未知字段保留在本地。缺失适配器 namespace 时等待，不改变接收方保护。

每个提供方具有共享记录和本地共同基线。三方比较合并独立提供方，将竞争更改保留为冲突，并仅通过明确 tombstone 发布删除。Namespace 消失不删除记录。Schema 指纹规范化进程内 Schemastery ID，同时保留 schema 含义；不匹配和未知版本拒绝同步。本地导入保留 revision 检查，使用现有 Settings/配置编辑器持久化所有者。一个跨进程锁覆盖共享发布、本地协调及 receipt 推进；原子写和文档大小限制保留重启及崩溃恢复能力。

新的 API-key 路由获得新的、目标拥有的缺失凭据引用，不创建凭据值或记录。这使用[凭据边界决定](2026-07-30-credential-boundaries-and-atomic-registration.zh.md)建立的封闭式查询。不能使用该保护的路由需要本地设置。已有端点/协议更改产生冲突，删除或模型替换不能丢弃被排除的目标字段。凭据输入或登录单独在目标应用中进行；安全传输需要另外的提供方/账户范围同意，以及可信 Host 或 OS 凭据存储交接。

刷新队列和监听器通过新增的 `runOutsideTransaction` 方法在 HMR 事务上下文之外启动。HMR 独占规则保留。仅 Host 的所有者 signal 在预期更改开始前取消排队工作和预检准备，包括销毁调用方的外部 profile 协调。已开始的 apply 等待完成；原子替换前取消不写入，替换开始后取消则完成协调或现有回滚。这防止销毁等待正在销毁自身的事务。[运行时刷新决定](2026-09-30-profile-package-refresh-and-manifest-invalidation.zh.md)继续负责包解析和缓存失效；两项已有决定均未被替代。

## 考虑过的替代方案

**共享完整应用 home 或凭据文件。** 这会共享无关历史和持久访问。普通配置同意不授权这种扩展。

**复制引用、省略认证字段或重复使用固定缺失引用。** 省略引用允许环境/提供方原生认证回退。复制或重用引用可能解析无关或以前保存的 key。新的目标拥有引用在明确本地设置前保持未配置。

**最后写入者获胜，或独立合并每个嵌套 key。** 两者都可能丢弃并发意图，或组合不兼容的端点/模型事实。每个提供方的冲突保留双方值，严格允许列表将目标专有字段留给所属应用。

**等待所有被取消的排队编辑操作，或提前结束活动提交。** 前者导致 HMR 自我销毁死锁；后者在持久工作仍运行时报告取消。所有者 signal 仅在预期 apply 开始前结束调用，并保留现有提交截止点。

## 验证

包的[投影](../../../../packages/settings/provider-config-sync/tests/projection.spec.ts)、[合并](../../../../packages/settings/provider-config-sync/tests/sync.spec.ts)、[真实 Loader/HMR](../../../../packages/settings/provider-config-sync/tests/plugin.spec.ts)、[生命周期](../../../../packages/settings/provider-config-sync/tests/lifecycle.spec.ts)、[提交取消](../../../../packages/settings/provider-config-sync/tests/cancellation.spec.ts)和[独立进程](../../../../packages/settings/provider-config-sync/tests/process.spec.ts) fixture 使用模拟、无 key 的 profile。它们覆盖冲突、删除、schema 兼容性、排除数据、重入、热激活/销毁、并发写入、崩溃恢复和重启持久化，不执行推理。

## 后果

兼容且明确配对的 profile 共享普通目录，同时保持独立访问和会话状态。冲突及目标专有字段需要本地解决。配对默认未配置；此源码更改不会提升另一已安装应用。跨主机协调、冲突解决 UI、凭据传输和共享默认接收方仍暂缓。仅所有者可访问的 POSIX 文件模式不能防范同一 OS 用户的进程；更强的凭据隔离由凭据提供方负责。

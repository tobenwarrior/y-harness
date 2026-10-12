---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-09-native-learning-root-protocol

[English](2026-10-09-native-learning-root-protocol.md) | 中文

## 概述

两个新增且可忽略的 Session 事件保存有上限的原生证据，不改变 Session 格式 V4。skill/native-item 保存按提供方区分的原始标识、净化动作元数据及可选的安全步骤事实。claude-code/root-protocol 独立保存有上限且所拥有的 Claude 根输入、system 文本及公共上下文帧，包括原生 home 和配置路径元数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-09-native-learning-root-protocol
baseline: false
changes:
  - root: "event:claude-code/root-protocol"
    previous: null
    after: "77e2c680b972fb40016c720849e5bea44b970eb828e1d67d64559d399483b903"
    decision: same-version
  - root: "event:skill/native-item"
    previous: null
    after: "3a2827d5603d94826b4c2bb9cebc12487b388f6e085ff8171254982f326695c6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有 Codex 原生证据保持相同的序列化提供方、连接、Session、轮次及条目字段；新不透明类型在经验证的 SDK/JSON 边界构造品牌标识。Claude 证据使用 sendId 与实际 sourceMessageId/resultMessageId，而非虚构 turnId。新增协议事件没有模型对话或表面投影，旧的可忽略事件读取器可以省略它。默认插件仍仅提供子任务，除非明确配置 rootRoute。公共 SDK 记录不能恢复隐藏原生提示、工具 schema 或私有状态。此临时根路由不支持重启、外部 CLI 续接或交替原生写入者。单独选择的既有原生会话顺序交接需要自己的适配器及验收证据；这些事件并未实现该模式。本记录仅确认这两个新增 Session 事件根。受管理维护与 coding 镜像使用独立存储域；独立 Decision 配置不引入 Session 根。公共证据或工具观察均不能证明任务完成或完整原生使用。

<a id="verification"></a>
## 验证

最终集成的纯 fixture 选择在 lint 修复后于 37 个文件中通过 499 项测试。生产 Loader、AgentLoop、Session JSONL 与 SkillLibrary 正常执行；新增路由测试使用 fixture 拥有的配置环境及路径，模拟外部 SDK 传输、原生子进程与强制隔离边界。有重叠的更广测试在 38 个文件中通过 507 项，其中八项既有测试在临时 home 中用虚拟密钥驱动已安装的 Claude SDK/CLI，并连接本地模拟 Messages 服务；它们不调用远程模型，也不读取原始原生配置。已构建的 TypeScript SDK 投影通过所选回放（一项通过；25 项不相关选择跳过）；已打包的 macOS Python 运行时投影通过回放。同一模拟投影也在仓库之外的隔离虚拟环境中使用版本匹配、非 editable 安装的 SDK 与运行时 wheel 通过。两个投影均在故意使用错误原始标识的负向对照中失败，随后精确恢复预期字节。全部五个组合浏览器验收场景在已构建的生产 UI 与仅 fixture 后端中通过。数量有重叠，不能相加。投影或浏览器验收均不能证明原生成功使用、隐藏上下文连续性或模型质量。未执行真实模型调用、原始原生会话或历史读取、身份验证操作或用户技能维护。

<a id="dev-note"></a>
## 开发备注

无。

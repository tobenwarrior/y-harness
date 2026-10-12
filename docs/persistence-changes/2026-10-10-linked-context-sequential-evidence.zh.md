---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-10-linked-context-sequential-evidence

[English](2026-10-10-linked-context-sequential-evidence.md) | 中文

## 概述

普通 Y 会话的关联导入新增仅作来源归属的历史上下文来源，以及仅日志的初始化所有权回执。原生顺序续接新增开始、原生轮次、经过清理的原生条目和结束记录，并绑定到当前已准入的一个 Y 任务。原生修改观察保留有界的新增、更新、删除与移动事实，供独立校验的学习提案使用。记录保留原始提供方、配置档、会话和轮次标识，并区分派发准入与任务正确性。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-10-linked-context-sequential-evidence
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-09-skill-learning"
    after: "88b51ccec6b454bff196b5cd956d21235e2fc971528d235530550c3cd265910d"
    decision: same-version
  - root: "event:coding-session/import-initialization"
    previous: null
    after: "3346bc09a8edab78ee6e631001882eaae8ade37e91c606068146234790297406"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-09-skill-learning"
    after: "e17a602e9d977b0f715960a4f5d9ef79a098fd7ea7096a63d30d16e0efb2a5b8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-09-skill-learning"
    after: "e1772de50c8b56961a81e637967742fbc01d998e089cba9b9092928a09059d31"
    decision: same-version
  - root: "event:skill/learning-request"
    previous: "2026-10-09-skill-learning"
    after: "177245cad7f338896d19c5d5b6d35a7650058863b984d439dac34cc3bb95d715"
    decision: same-version
  - root: "event:skill/native-item"
    previous: "2026-10-09-native-learning-root-protocol"
    after: "9ee3e528407bcaab064bebcc639624bac95aa2ab2e00b1ee26488b11d1a2bc11"
    decision: same-version
  - root: "event:skill/sequential-native-item"
    previous: null
    after: "1f68ab61681d3a55ebd0c6a333fc6450f6267913c6a01f5de72ec7074a537aae"
    decision: same-version
  - root: "event:skill/sequential-task-end"
    previous: null
    after: "4302630c0dd064feeea889e5a10f2a41725ff96e37f65bc1035145074138f70b"
    decision: same-version
  - root: "event:skill/sequential-task-native-turn"
    previous: null
    after: "42a11b7a6487a7a8db34ca28b924378a50e313a81afece69ec6872b7bba5893d"
    decision: same-version
  - root: "event:skill/sequential-task-start"
    previous: null
    after: "6259f110e38f73bf58e0afb00aa75761c705ffe7eff36c6eb446186360ec2ea9"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-09-skill-learning"
    after: "19244c1fbd3e2c980c606016437bb84109f0226fc51c4bb4dba72bb72a60c0a4"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

Session 格式仍为 V4。新增事件仅含信息，追加时使用字面值 ignorable: true；忽略这些记录不改变模型历史重建。coding-session-import 来源是带归属的引用历史用户上下文，不授予人类指令、许可、回放或工具路由权限。既有来源兼容策略保留未知归属类型。初始化使用已有的 blocked 派发屏障与空的受保护系统头；单独的所有权回执不新增轮次结束变体。原生交接日志 v2 是独立部署格式，会拒绝已有 v1 单元；此处不执行另行说明的离线转换。

<a id="verification"></a>
## 验证

最终仅模拟的特性选择通过 84 个文件中的 1,422 个测试，包括真实 Loader 导入、精确不可变事件准入、关联事务、取消、顺序学习、有界维护、原生观察解析器、核心生命周期标记和客户端／SDK 传输夹具。最终严格 Host 与 Client 类型检查、全仓库代码检查和产品构建通过。八个组合浏览器场景全部通过。双轮 TypeScript SDK 夹具通过实际记录与回放；既有记录式原生条目投影通过刷新与回放，其余 25 个用例被筛选排除。原生条目与关联上下文两个 Python 投影均对新打包的 Mac ARM 载体完成实际记录与回放，随后使用同一对新 SDK／运行时 wheel，在隔离的非可编辑环境中以 Python -I、无 PYTHONPATH 通过。这些相互重叠的检查不作数量相加。夹具覆盖完整 UTF-8 字节预检、时间戳编辑后的稳定所有权、精确来源与目标版本、预写恢复、取消和仅追加回滚。全量 GUI 验证报告 10,131 个通过、两个保留的既有品牌断言失败、一个跳过。不包含真实模型调用、原始原生会话验收、凭据变更、实时安装或真实用户技能清理；运行时初始化和原生元数据投影不能证明原生技能使用或任务正确性。

<a id="dev-note"></a>
## 开发备注

无。

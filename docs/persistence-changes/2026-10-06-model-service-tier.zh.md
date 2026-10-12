---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-model-service-tier

[English](2026-10-06-model-service-tier.md) | 中文

## 概述

为持久化的模型选择以及记录的请求头配置与适配器默认值添加可选的服务层级（处理速度）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-model-service-tier
baseline: false
changes:
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "7f460f65c6e3f83e46b1ac38db7eb243d64200ca5fc1406c9469b443926c8ae2"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "ea54488eedb946ef8492ce61969b03ffb773d77abbdcc0bb8e26213225054e05"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。该字段在所有出现处均为可选；缺失时保持原有行为，即采用适配器自身的默认层级，且没有任何读取方要求该字段。只有当模型目录声明了可选层级时，写入方才记录该字段，因此其他路由上的会话与之前完全一致。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/api/session-controller packages/core/session packages/core/agent packages/core/agent-default-model packages/llm/llm packages/llm/llm-pi-ai：169 个文件、3794 个测试通过。pnpm exec vitest run packages/client/ui-model-selection：3 个文件、81 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。

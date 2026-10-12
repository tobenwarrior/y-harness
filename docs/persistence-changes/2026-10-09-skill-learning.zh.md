---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-09-skill-learning

[English](2026-10-09-skill-learning.md) | 中文

## 概述

增加只记录日志的有界技能学习请求与响应、辅助学习消息的来源标记，以及技能目录的可选相关性元数据。 辅助请求跟踪保留可选的已捕获推理强度与处理等级。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-09-skill-learning
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "6e2b0679c9c08e55de27dd42f102f86f9ded9315a22e3a6770c33b4e050e8614"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "00f73361fda4c2b07a3deb9c81c9aea7f2908a8c35b05a374720314ebc1c88c9"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "65932af36f8385707da4033898ed6e5147c98407a29a71f3eb8cf16196fcd684"
    decision: same-version
  - root: "event:skill/learning-request"
    previous: null
    after: "21fe393b993d059b929b8738f700cf96c09611592c764d51086ee66ddd4c1401"
    decision: same-version
  - root: "event:skill/learning-response"
    previous: null
    after: "a3418efc158ae910f0469136bd4dabd29ef047795949199f900831199e132b87"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "9ba9ddf329039aa14c79eff48acf0160fff7e25a38cfb4ffc8ed496ca75afd2c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。学习跟踪以 ignorable: true 追加，不进入会话界面或任务回放。skill-learning 来源类别仅表示出处；读取方无需此生产方即可保留用户与开发者消息。已有技能目录可省略全部相关性字段。已有值类型、事件封装、头部和写入版本均不改变，无需相邻迁移。 已有跟踪记录可省略推理强度和处理等级；字段缺失不代表已确认的默认值。

<a id="verification"></a>
## 验证

在隔离工作区运行的模拟与夹具测试覆盖核心 Session、技能库与运行时、技能注册表与文件系统及工具、技能和账户界面、LLM 元数据，共 62 个文件的 1,276 个测试通过。归档引用和中断审核回归在重现三个失败后通过了 27 个测试。持久化预览仅将修改归类为可选目录属性、仅表示出处的来源增加和两个新事件根，不要求提高版本。未运行真实模型或用户技能操作。 在重现六个调用准入与控制参数失败、三个证据路由失败后，仅响应模式准入及已捕获控制参数修复通过了四组 LLM 与学习模拟测试，共 170 个测试。未调用真实提供方或原生进程。

<a id="dev-note"></a>
## 开发备注

无。

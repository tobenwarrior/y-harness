---
description: "Y Harness 内置 Compound 技能的侧边栏更新提示与更新步骤面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compound-update

## 概述

当上游发布的 Compound 技能版本比当前 Y Harness 构建内置的版本更新时，侧边栏底部会立即显示一个小徽标。打开后会说明版本差异以及带来更新的步骤：更新检出目录、重新构建、重启应用。该面板不会自行改动工作树；当版本一致、无法读取上游版本，或部署中没有对应的 Host 路由时，它保持静默。

## 目录

- [使用此包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

与 `@deepseek-ai/dsh-skill-compound` 一同挂载；后者注册本包读取的 `api/skill-compound.update` 路由。

```yaml
- name: '@deepseek-ai/dsh-client-ui-compound-update'
```

徽标注册到 `sidebar.footer.action`，更新步骤面板注册到 `shell.overlay`；两者共享同一个读取控制器，因此面板显示的状态与徽标所提示的一致。

| 读取结果 | 用户看到的内容 |
|---|---|
| 上游版本更新 | 显示带版本号的徽标；面板列出两个版本、上游仓库与更新步骤。 |
| 版本一致 | 不显示徽标；面板说明当前构建已包含该版本。 |
| 无法读取上游 | 不显示徽标；面板说明检查失败的原因，并提供再次检查。 |

## 实现说明

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 注册、字典，以及唯一一次初始读取。 |
| [`src/client/controller.ts`](src/client/controller.ts) | 路由请求、响应校验与共享的读取状态。 |
| [`src/client/UpdateBadge.tsx`](src/client/UpdateBadge.tsx) | 侧边栏底部徽标。 |
| [`src/client/UpdatePanel.tsx`](src/client/UpdatePanel.tsx) | 发布版本、上游链接与更新步骤。 |

控制器会先校验路由响应再渲染，新请求失败时保留上一次读取结果，并丢弃已被取代的响应而不是将其发布。

## 延伸阅读

- [`packages/skill/skill-compound`](../../skill/skill-compound/README.md) —— 内置技能及本包读取的路由。
- [compound-skills](https://github.com/tobenwarrior/compound-skills) —— 被报告版本的上游仓库。

## 模型体验

无。该提示属于浏览器界面：不增加提示词区段、工具或会话事件，模型不会看到其状态。

## 已知限制与后续工作

- 面板只做提示。更新检出目录、重新构建与重启仍由操作者完成，因为本 fork 的生产检出目录不应被正在运行的应用改写。
- Host 会缓存读取结果：成功后缓存六小时，失败后缓存十五分钟，因此期间发布的版本会在下一次读取时出现。
- 本包只读取一个路由，不渲染自身版本；若部署中未挂载 `@deepseek-ai/dsh-skill-compound`，则不会显示徽标，并将缺失路由报告为检查失败。

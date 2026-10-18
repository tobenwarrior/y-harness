---
description: "Y Harness Web 客户端的 Compound 代码地图面板与侧边栏入口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compound-map

## 概述

侧边栏中 **代码地图** 入口位于“技能”正下方，打开 Compound 代码地图查看器：包含目录聚类的仓库图谱、搜索、导入追踪、影响分析以及只读源码预览。查看器就是内置应用本身，由 `@deepseek-ai/dsh-skill-compound` 从本站点提供并以框架方式嵌入，其后端的回环服务也由该包负责。所有内容都留在本机：图谱、索引缓存与源码预览都不会离开本地。

## 目录

- [使用此包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

与 `@deepseek-ai/dsh-skill-compound` 一同挂载；后者提供查看器文档、其资源以及框架所用的代理调用。

```yaml
- name: '@deepseek-ai/dsh-client-ui-compound-map'
```

| 界面 | 注册位置 | 效果 |
|---|---|---|
| 侧边栏 | `sidebar.panellist`，id `code-map`，order 11 | 位于“技能”（order 10）正下方的导航入口。 |
| 主区域 | `main`，key `code-map` | 面板：工具栏、查看器框架与本机处理说明。 |

## 实现说明

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 面板与侧边栏注册、字典、面板 id。 |
| [`src/client/MapPanel.tsx`](src/client/MapPanel.tsx) | 工具栏、查看器框架与重新加载代数。 |
| [`src/client/MapPanelIcon.tsx`](src/client/MapPanelIcon.tsx) | 侧边栏渲染的依赖图谱图标。 |

面板以框架方式加载 `/api/skill-compound.map/viewer`，而不是重新实现图谱。内置服务拒绝被框架嵌入并拒绝外部来源，因此由 Host 从本站点提供同样的资源；框架因此不需要 sandbox 属性，其自身的 `connect-src 'self'` 请求会命中 Host 的代理。

## 延伸阅读

- [`packages/skill/skill-compound`](../../skill/skill-compound/README.md) —— 查看器资源、回环桥接与服务生命周期。
- [compound-skills](https://github.com/tobenwarrior/compound-skills) —— 上游查看器及其文档。

## 模型体验

无。该面板属于浏览器界面：不增加提示词区段、工具或会话事件。模型若需要地图，会通过 `map` 技能以命令行方式驱动同一服务。

## 已知限制与后续工作

- 框架加载的是 Host 在启动时为工作区映射的项目；切换到其他已注册项目需在查看器自身的项目选择器中进行。
- 若部署环境没有 Python 3.11+，服务无法启动，查看器自带的错误浮层会给出提示。
- 面板除重新加载代数外不保存状态：切换面板后再返回会重新加载框架。

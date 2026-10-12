---
description: "面向侧栏的 Y Harness 品牌填充，仅在官方构建中生效；供选择或替换品牌呈现的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

## 概述

本包向以 `official` profile 构建的客户端提供共享 Y 标志与已配置的纯文本应用名称。侧栏仅显示名称；会话首屏使用自身的共享静态 Y 回退。其他构建 profile 使用侧栏本地化的本地构建标签或已配置的显示名称。本包不保留运行时状态，也不影响模型请求。

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

将本插件挂载到浏览器插件名单，然后以 `official` profile 构建客户端，让填充得以注册。

### 选择 profile

`DSH_CLIENT_BUILD_PROFILE` 决定本包是否注册 `sidebar.brand.mark` 与 `sidebar.brand.name` 占用方。`official` 构建提供共享的 `YHarnessLogo` 与已配置的纯文本名称；没有 `DSH_CLIENT_DISPLAY_NAME` 时，名称占用方保留原有的 `BrandWordmark` 图形。其他 profile 取值保留外壳的名称回退。侧栏仅渲染名称占用方，不渲染独立标志。会话首屏无论 profile 如何都使用声明包的静态 Y 回退。两种情况下插件都会照常加载并通过校验；只有注册受 profile 门控。

### 替换品牌

修改名称时，可使用公开的[应用显示名称配置](../../../apps/desktop/README.zh.md#app-display-name)；其构建值 `DSH_CLIENT_DISPLAY_NAME` 提供纯文本名称，与共享标志独立。部署可以用另一个占据侧栏 slot 的包替换本包，也可以占据首屏 slot 以替换其回退。侧栏标志占用方不会向名称行或收起轨道添加图形。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

两个填充作为一组声明感知的注册安装：嵌套的 `ctx.slots.inject()` 调用等待侧栏声明，因此无论本行在声明者之前还是之后激活，这组注册都能工作；声明消失时两个填充一并撤回，HMR 期间也不会留下残缺的品牌混合。浏览器半部是 [`src/client/index.ts`](src/client/index.ts)；node 半部是一个空 Loader 座位。浏览器标题是构建环境的事（`DSH_CLIENT_TITLE`），不在 slot 系统之内。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当品牌面不够用时阅读以下页面。它们从本包占据的 slot 进入渲染这些 slot 的外壳。

- [ui-sidebar](../ui-sidebar/README.zh.md)——声明 `sidebar.brand.mark` 与 `sidebar.brand.name` 并仅渲染名称行。
- [ui-conversation](../ui-conversation/README.zh.md)——在首屏声明 `conversation.hero.brand.mark`。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了品牌呈现的供给方式。它们是当前包约束，不是品牌设计对比或任务积压。

- **只有一组填充**——替代呈现属于占据相同 slot 的另一个 Cordis 包。
- **浏览器标题独立**——`DSH_CLIENT_TITLE` 在构建时选择标题文本，而非通过 UI slot。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

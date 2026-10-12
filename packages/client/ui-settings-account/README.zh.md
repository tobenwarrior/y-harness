---
description: "Desktop 模型设置提供可选的 DeepSeek 提供方连接、浏览器授权、用量、余额和明确确认的断开操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)。模型连接弹窗不发送认证埋点事件。

服务端判定凭据失效后清空提供方详情。账号状态不改变应用身份，也不限制进入工作区。

## 概述

设置 → 模型包含可选的 DeepSeek 连接卡片，提供浏览器授权、取消和确认断开；已连接的用户可以查看余额、用量与充值。侧边栏与设置导航独立于此提供方。

登录弹窗仅对 `no-response` 失败提示检查网络。HTTP、业务、响应校验、存储和账号状态流失败仍显示通用重试提示。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

账号认证与额度错误保留现有任务失败路径。计费操作位于模型设置；此插件不挂载全局账号或额度弹窗。

<a id="use-this-package"></a>
## 使用此包

客户端仅在 preload 桥接存在的 Desktop 中启用。普通 Web 保留标准设置入口和 API Key 引导，不订阅账号状态，也不显示账号连接卡片。

提供方卡片显示 32px 圆形资料图片；URL 缺失或加载失败时使用账号图标。昵称和脱敏联系方式仅显示在模型设置中。

卡片通过 `settings.models.footer` 注册，独立于已认证的账号模型目录。未连接时模型行虽然隐藏，连接入口仍可发现。插件持有一条账号 Remote 流，通过共享监督器跨连接恢复。API Key 与账号授权分别保存。

账号操作会把本界面的客户端身份传给 Host：构建版本、当前语言，以及发起操作时采样的当前 UTC 偏移（秒）。

余额沿用 Platform Web 的金额格式：两位小数和千分位分组，正金额截断至分，小于一分的正金额显示为 <0.01，负金额按舍入规则处理且显示绝对值至少为 0.01。Host 返回的原始余额字符串保持不变。

用量与充值通过现有返回栏下的隔离原生 Platform 视图打开。共享的 `shell.overlay` host 与 `PlatformPages` 通道保留单一所有者替换、焦点恢复、加载错误和重试。充值返回会等待已有账号读取并刷新资料、余额和未通知赠金；用量返回、替换与释放不读取。渲染器投影不接收 token。

插件不向 `shell.quota-notice` 注册。通用 Chat 失败提示及后端认证、额度检查保留；用量和充值通过连接卡片进入。

注入的 contactUs 操作在系统浏览器中打开飞书问卷。每次调用都按当时的上下文取值：profile ready 且带 id 时的账号 UID、以 harness_version 表示的构建版本，以及 device_info。device_info 以 screen_resolution=宽x高 包含屏幕物理分辨率，尺寸乘以 devicePixelRatio 后四舍五入；屏幕尺寸不可用时省略此项。所有上下文字段同时设置 hide_*=1，配置的表单 URL 中这些字段的 stale prefill 参数先被清除，uid、device_info 与 harness_version 的隐藏参数不依赖配置 URL 的取值。URL 不携带 os_version、device_brand、app_locale 或独立的 screen_resolution 参数；配置 URL 中这些字段的 prefill 与 hide 参数会被移除。不传 token 或脱敏联系方式；未登录、profile 仍在加载或读取失败时都不填写 prefill_uid。Desktop 桥接没有 deviceInfo 读取器时，打开的表单以 navigator.userAgent 作为 device_info。Desktop 端暴露可选的 dshDesktop.deviceInfo 读取器，其字段格式由 [Desktop README](../../../apps/desktop/README.zh.md) 负责；该读取器的结果取代 user-agent，读取失败时仍打开表单，device_info 保留可获取的屏幕分辨率，而 device_info 描述的是上报的环境而非硬件型号。可在 ui-settings-account 插件配置 contactFormUrl，切换到另一个 HTTPS 问卷；问卷支持 Harness 来源选项前，contactSource 默认为空。

账号资料与余额卡片共用[设置卡片材质与圆角](../../../docs/web-styling.zh.md#corner-radii-and-settings-cards)。用量与充值链接与标准 Button 尺寸一致；授权操作使用公共 Button。

应用使用设置外壳提供的中性设置入口。账号插件不注册 `settings.launcher` 或顶层 `settings.section`。

账号卡片的“更多账号信息”链接不带下划线，通过系统浏览器打开 Host 提供的 Platform 用量 URL 的根路径，遵循 `platformOrigin` 配置。

断开连接前先查询使用账号 token 的运行任务，并显示既有确认弹窗。已知或未知的任务影响均提示中断风险。仅确认后调用 Host 退出登录；取消、关闭和 Escape 保留授权。凭据提供方负责删除本地账号授权和有界远程撤销；其它凭据、资料与会话保持不变。

服务端提供的赠金通知仅在已连接的提供方卡片挂载时显示。账号进入有效状态仍读取待通知信息；进入模型设置或从充值返回时刷新，无定时轮询。进入其它设置页不会刷新账号详情。

只有通知完成一帧显示或用户关闭通知后才确认订单。未显示的通知不确认，读取成功或打开应用不代表已展示。现有有上限的确认重试与账号变化时的失效处理保留。

<a id="desktop-onboarding"></a>
### Desktop 引导

不再注册桌面介绍覆盖层。首次及已保存的额度、用途、过程或完成进度保持不变，工作过程、用量及代码工作工具偏好也不变。连接账号不会启动产品欢迎流程。

<a id="understand-the-implementation"></a>
## 理解实现

插件持有一条脱敏 Host 快照流。`AccountSection` 通过模型设置页脚渲染，挂载时订阅，并使用既有明确连接、取消和断开操作，不维护单独的凭据存储。

为保留上游兼容性，既有介绍组件及 `ui-settings-account` schema 仍保留，但当前组合不创建介绍控制器。因此启动、打开设置和连接提供方均不写入完成标记或介绍偏好。[仅提供方界面决策](../../../.agents/notes/implemented/architecture/2026-10-11-provider-only-desktop-ui.zh.md)定义此职责划分。

<a id="further-exploration"></a>
## 深入探索

[凭证子系统](../../../docs/subsystems/credentials.zh.md)定义存储接口；[架构](../../../docs/architecture.zh.md)说明应用组合。

连接操作打开可关闭的提供方弹窗。等待时可复制携带当前主题的授权链接；失败与超时需明确重试。剪贴板失败为短暂反馈，不中断授权。待授权尝试被识别后即可取消；关闭等待弹窗会取消对应 Host 流程。API Key 编辑器仍是模型设置中的独立提供方控件。

账号流的终止错误在提供方卡片或其登录弹窗中显示。插件卸载后不再报告延迟错误。

余额卡片分行展示充值余额与赠金余额。登录态下，赠金行在加载中、余额读取失败以及存在正额赠金时显示；读取成功但没有正额赠金时不显示该行。余额或赠金读取失败时，沿用既有的不可用文案并改为指向 Platform 的链接，目标与行为同“查询用量”一致：Desktop 打开内嵌页面，其它环境新开标签页；加载中仍为纯文本。不同币种分别显示；日期只在服务端自己的消息中出现。


可选登录完成后，[Session 默认模型初始化](../../api/session-controller/README.zh.md)仅在没有提供方配置 API Key 引用、也没有保存默认模型覆盖值时，才可能将 `deepseek-account` 的第一个可用模型设为默认值。已保存的选择与并发设置更改保持不变，包括不可用的提供方或模型选择，以及仅包含推理配置的覆盖值。会话内的显式选择保持不变。

<a id="model-experience"></a>
## 模型体验

无，因为账号凭证只影响 HTTP 认证，不进入模型提示、Session 日志或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 资料与余额查询保留服务端脱敏联系方式，并分别显示错误，不虚构零余额。Host 派生的 Platform 链接不携带 DSH token。
- 使用本地应用不代表获得推理权限。已连接的账号模型仍需有效授权和可用的赠金或充值余额。

- 通知文案按客户端读取时的界面语言由服务端本地化。切换语言本身不会重新读取未通知赠金，因此已在屏幕上的通知会沿用服务端先前语言下发的文案，直到用户手动刷新或登录生命周期重新开始。

- Platform 视图的弹窗会把文档内其它子节点设为 inert，其中包括 Desktop 拥有的顶栏菜单 host，因此 Application 和 Edit 菜单保持可见，但在视图关闭前无法操作。放行该 host 需要 Desktop 侧提供 inert 契约。

<a id="dev-note"></a>
### 开发备注

[桌面登录决策](../../../.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.zh.md)记录取消和存储的职责。

用量和充值在原生页面加载完成前显示居中的 24px 加载图标，不显示加载文字；返回操作始终可用。加载 SVG 从 Figma 节点 2957:72553 内嵌到本地样式。

默认模型初始化在登录帧发布并确认接收后运行，不延迟后续账号帧。初始化失败会记录诊断日志，不会将已登录账号标记为失败。

设置只读、账号读取失败或传输错误时工作区仍可使用。关闭模型设置会释放卡片和原生页面请求，不会断开提供方。

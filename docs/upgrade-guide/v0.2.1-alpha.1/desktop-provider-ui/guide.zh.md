---
kind: upgrade-guide
description: Desktop 账号控件从侧边栏和账号分类移至模型设置，已保存的欢迎步骤停止显示。
---

# Desktop 提供方连接控件

[English](guide.md) | 中文

## 变更

首次及现有资料均使用中性设置入口。移除侧边栏账号菜单和账号设置分类。可选 DeepSeek 连接、确认断开、用量与余额位于设置 → 模型。账号登录不再位于独立 API Key 编辑器之前。已保存欢迎步骤不再显示。

`AccountSectionProps` 改为使用 `settings.models.footer` 所有者属性，而非 `settings.section`。既有凭据记录、设置键、会话和介绍进度保留 schema 与内容。

## 迁移

1. 打开设置 → 模型，管理可选 DeepSeek 连接或 API Key 提供方。取消或关闭页面保留已有授权。
2. 自定义客户端挂载 `AccountSection` 时应改用模型页脚席位，不再传入分类导航属性。需要其它登录展示的客户端应注册自己的明确贡献。
3. 确认工作区无需账号弹窗即可打开，设置导航不包含账号分类，且此前配置的提供方仍可用。无需迁移用户资料或删除凭据。

# y-session-tools（本地插件组合包）

[English](README.md) | 中文

这是为此 fork 的 Web UI 提供功能的 profile 插件。它**不是** workspace 包：`pnpm-workspace.yaml` 的 glob 不包含 `local-plugins/`，因此此目录不会随仓库一起构建、测试或发布。它通过路径安装到 `desktop` profile 中。

## 添加的功能

在每个会话行的菜单（`sidebar.workspaces.session.menu.item`）中添加四项，并在 `shell.overlay` 中添加一个确认对话框：

| 菜单项 | 顺序 | 效果 |
|---|---|---|
| 复制会话 ID | 500 | 复制原始会话 id。 |
| 复制会话引用 | 510 | 复制标准的 `@[title](dsh-session:…)` 提及格式，可粘贴到另一个会话的输入框中，作为模型上下文。 |
| 复制会话路径 | 520 | 复制会话保存产物的目录。 |
| 删除会话… | 900 | 经确认后，永久删除会话保存的日志和目录。 |

Host 配置项还会启用 `@deepseek-ai/dsh-tool-session-query`，为模型提供 `session_search`、`session_event_search`、`session_trace`、`session_event_trace` 和 `session_event_read`，以读取其他会话的历史记录。

两个搜索工具还需要 SQLite 索引；两个随产品提供的配置层都将其设为 `openAt: never`，而侧边栏自身的搜索仅匹配标题和工作区名称。因此，组合包的补丁将 `session-query-sqlite` 覆盖为 `openAt: first-search`，即基础补丁中记载的启用选项：它保留临时内存索引，并将 `node:sqlite` 的导入和句柄创建推迟到首次搜索。没有这个覆盖时，两个搜索工具虽然已注册，但会以 *"session search is disabled in this deployment"* 拒绝执行；三个追踪和读取工具则不受影响。

此 fork 的 `packages/client/ui-workspace` 也会在右键点击时打开同一菜单，因此右键点击会话行即可使用上述所有菜单项。

## 工作方式

`index.js` 在共享 API 通道上注册一个需要身份验证的路由：

- `GET /api/y-session-tools.session?sessionId=&label=` 返回 `{ sessionId, path, mention }`。
- `POST /api/y-session-tools.session` 接收 `{ sessionId }`，并删除该会话。

产品没有提供删除操作的 Host 入口（`workspaceRegistry` 负责归档和固定；`sessionPersistence` 仅追加），因此该路由自行解析产物目录，先归档会话以将其从所有浏览入口隐藏，再删除目录、取消归档以将归档集合恢复为原来的状态，最后为该会话发布 `api-session/removed`。发布的删除事件会移除侧边栏中的会话行：Workspace 成员关系会持久保存，不随产物变化，因此若仅隐藏会话，恢复归档集合后仍会留下该行。活动会话会以 `session/live` 拒绝删除。

`client.js` 是一个动态浏览器 bundle：它注册菜单项和对话框，并且仅从模块表导入 React、`react-dom` 和 `client-store`。

## 验证

```sh
node local-plugins/y-session-tools/verify-host-route.mjs
```

此检查使用真实的临时会话目录树驱动已注册的 fetch 处理函数，验证路径发现、引用提及格式（检出目录构建完成后会与产品中的 `formatSessionReferenceMention` 比较）、活动会话拒绝删除、归档／删除／取消归档／移除的顺序，以及 400／404 响应路径。

## 已知限制

- 删除会移除会话日志及其目录。日志引用的附件 blob、搜索索引行和投影缓存项由各自机制负责后续协调。
- 拒绝删除**活动**会话；请先停止它。
- `tool-session-query` 依赖固定为运行时的版本。升级 DSH 后，请重新检查该版本固定值。

## 安装／移除

```sh
# install (from a session in this profile)
#   plugin_manager install_bundle /abs/path/to/local-plugins/y-session-tools
# remove
#   plugin_manager remove_bundle @local/y-session-tools
```

更新已安装组合包的 Host 部分后，需要重启应用以加载新的 JavaScript 模块版本；浏览器部分从组合包目录提供。

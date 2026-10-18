# 上游限定范围同步

[English](README.md) | 中文

Y Harness 以“本仓库优先”的方式跟随官方 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)：[`config.json`](config.json) 中列出的路径跟随上游，其余内容属于本仓库自身的工作（提供方、品牌、启动器、bundle）。`master` 是一次压缩导入，与 `upstream/master` 没有共同祖先，因此无法用一次合并表达这种划分——本工具改用路径允许列表来表达。

## 工具做什么

1. 拉取 `upstream` 远端。
2. 只在 `include` 范围内、并排除 `exclude` 之后，对 `baseline..target` 取差集。
3. 把该差集写成单个补丁，并用 `git apply --3way` 应用，即针对已拉取的上游 blob 逐文件做三方合并。
4. 当目标是 `dsh-v*` 标签时，使用本仓库自带的 `pnpm run release:dsh` 将工作区版本对齐到该发布版本。
5. 在**准备好的分支里**重写 `config.json` 的 `baseline`，因此只有合并该分支才会推进这个标记。

它从不向 `master` 提交、从不合并、也从不推送。

## 使用

```sh
# See what a sync would bring; writes .artifacts/upstream-sync/<baseline>-<target>.patch
node scripts/upstream-sync/sync.mjs --to dsh-v0.2.1-rc.2

# Prepare the branch, apply, align the version
node scripts/upstream-sync/sync.mjs --to dsh-v0.2.1-rc.2 --apply

# Resolve reported conflicts, install, then run the configured checks
pnpm install --no-frozen-lockfile
node scripts/upstream-sync/sync.mjs --check
```

`--json <path>` 写出机器可读报告（文件、提交、冲突、新包、检查结果）。退出码：`0` 干净，`2` 已应用但存在冲突，`3` 检查失败，`1` 错误。

在本机上请通过仓库包装器运行 pnpm：追加 `--pnpm .local-setup/run-pnpm`。

## 调整同步范围

编辑 `config.json` 中的 `include` / `exclude`。请只保留本仓库确实想要其上游行为的包；每增加一个路径，都意味着与该仓库自身改动之间长期存在的冲突面。新包会出现在报告的 `newPackages` 中——它们通常还需要 bundle 行，因为 `packages/bundle/**` 被有意排除在同步之外（本仓库的装配由人工维护）。

## 前置依赖

同步进来的包经常需要本仓库**不**同步的清单中的某个条目。上游会在清单之间移动依赖条目——共享工具包、工作区根目录——随后被同步的包会引用本仓库从未安装的东西。补丁里看不到这一点：它稍后表现为类型检查失败，或者同一个库出现两份副本、彼此的类型不再匹配。

`prerequisites.manifests` 声明这些清单。工具**只**合并它们的依赖段（`dependencies`、`devDependencies`、`peerDependencies`）：上游新增或改动的范围会被应用，仅本仓库声明的条目会保留，其余发生变化的字段——`version`、`scripts`、`engines`——只列在 `untouchedFields` 中，不予应用。依赖一旦变化，还会清除包级 `tsbuildinfo` 缓存并刷新锁文件，否则 `tsc -b` 会继续报告它在改动前解析出的模块身份。

`prerequisites.sources` 用于前置的源码树。它当前为空：`packages/client/ui-slots` 是所有 UI 包共享的 slot 运行时，纳入它属于一次需要评审的改动，而不是添加一个路径条目。

## 定时运行

[`.github/workflows/upstream-scoped-sync.yml`](../../.github/workflows/upstream-scoped-sync.yml) 每周及按需运行：准备分支、安装依赖、运行检查、推送分支，并创建（或更新）pull request。不会自动合并。要让 pull request 出现，需要两项仓库设置：

- Actions → General → Workflow permissions：**Read and write**。
- Actions → General：**Allow GitHub Actions to create and approve pull requests**。

如果没有这两项设置，任务仍会把补丁和报告作为 artifact 上传。

## 前提

- `upstream` 远端必须存在（`git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git`）。
- `--apply` 要求工作区干净。

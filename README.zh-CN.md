# Crewvane｜协航

**交代目标，团队交付。**

本地桌面 Agent 团队工作台。人把目标交给船长，船长安排临时队长，队长按可配置工序组织工人。
问题先由直属上级解决，再逐级升级，只有船长无法解决的决定才找人。

支持扫描 OMP、Codex、DeepSeek Harness、Cursor、Qoder。首版调度前三种，后两种只发现。
角色、工序与任务可分别配置运行时和实际模型。每个需求使用独立分支和 worktree，
执行后必须经过独立验证；项目授权内自主推进至 PR，合并与部署由人决定。
Herdr 是推荐的可选终端底座，可在设置中检测并一键安装；安装后终端优先使用
Herdr，未安装时回退到 Shell 或已发现的 runtime CLI。Crewvane 的调度与
Agent 通信不依赖它。

当前为 macOS arm64 内测版。CLI 已更名为 `crewvane`，与桌面共享同一份记录。

[下载安装包（GitHub Releases）](https://github.com/gdli6177/crewvane/releases)：版本正式发布后，在 Assets 下载 `.dmg`，打开后将 Crewvane 拖入“应用程序”。也提供 `.zip` 和 SHA-256 校验文件。[安装与发布说明](docs/releases.md)。

```sh
pnpm install
pnpm desktop:dev
pnpm desktop:package
```

[完整使用说明](docs/crewvane.md) · [产品方案与里程碑](docs/product/crewvane-v0.1.md) · [架构](docs/ARCHITECTURE.md)

旧版迁移与卸载均提供 dry-run、归属检查和记录保留，请按使用说明操作。

## 优先复用开源组件

Crewvane 自研并拥有持久任务、派工、分级升级、决定账本、工序版本、证据和授权；
以下能力优先复用成熟开源项目：

| 需求 | 复用组件 |
| --- | --- |
| 桌面外壳 | Electron |
| 界面基础组件 | React、Radix UI Themes / Dialog |
| 图标 | Lucide |
| 终端界面 | xterm.js |
| PTY 执行 | node-pty |
| Agent 执行协议 | ACP、Codex App Server |
| 可选终端会话 | Herdr |
| 桌面端到端测试 | Playwright |

ACP 与 Codex App Server 当前使用经过测试的 JSON-RPC 子集。没有仅为增加依赖数量
引入 `@agentclientprotocol/sdk`，它在当前范围内不会减少需要理解和维护的产品逻辑。

# Crewvane｜协航

**把所有事，交给一位管家。**

Crewvane 是一个本地桌面注意力中心。你把项目目标和个人事项放进同一个地方，再交给整个工作区唯一的 Herdr 管家统筹。目标、下一步、等待对象、真实交付和需要你决定的事情集中在同一处；进行中的普通工作不会持续打扰你。

- 一个工作区只有一位 `concierge` 管家，所有项目都找它。
- 工作区打开真实的 Herdr Session，已有 Codex、Claude、OMP、Cursor、Qoder 等 CLI Agent 都可在终端中自然使用。
- 工序只是每步“名称 + 提示词”的说明书，创建目标时保存快照。
- 负责人通过 Herdr 汇报，管家逐层协调；只有管家无法决定或成果可以验收时才找你。
- 注意力只由明确决定、验收、到期跟进和 Herdr 介入产生，终端 `idle` / `done` 不代表完成。
- 桌面与 `crewvane` CLI 共用同一份加锁、原子写入的本地记录。

支持 macOS Apple Silicon。启动时自动检测并准备最新 Herdr CLI，无需 Homebrew；Crewvane 创建并管理按工作区隔离的命名 Session。关闭应用窗口不会终止 Agent 会话；Herdr 暂时不可用时，记录、提醒、手工更新和验收仍可使用。

[下载 macOS 安装包](https://github.com/gdli6177/crewvane/releases) · [使用说明](docs/crewvane.md) · [安装与发布](docs/releases.md) · [开发基线](docs/product/attention-center-development.md) · [架构](docs/ARCHITECTURE.md)

```sh
pnpm install
pnpm desktop:dev
pnpm desktop:dist
pnpm test:desktop
pnpm test:installers
```

## 核心过程

```text
你记录目标 → 管家读取目标与工序 → 负责人在 Herdr 中推进
            → 有进展通过 crewvane 写回
            → 需要你时进入注意力 → 查看真实证据 → 验收
```

验收通过只结束 Crewvane 目标，不会合并代码、部署服务或发送外部消息。完整检查命令与结果必须随交付提交；`goal review` 不接受没有检查记录的验收。

## 技术复用

| 需求 | 复用 |
| --- | --- |
| 桌面外壳 | Electron |
| UI | React、Radix Dialog、Lucide |
| 构建 | esbuild、Vite |
| 持久 Session 与 Agent 通信 | Herdr（应用内安装和管理） |
| 桌面端到端测试 | Playwright |
| macOS 安装附件 | `@electron/packager`、`hdiutil`、`ditto` |

Crewvane 自研的是目标记录、注意力派生、工序快照、Herdr 管家协议、证据与验收边界。它不重做 Agent 运行时、模型网关或终端。

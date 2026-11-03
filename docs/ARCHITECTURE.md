# Crewvane 架构

产品基线见 [全局管家与注意力中心开发说明](product/attention-center-development.md)。

## 边界

```text
Electron 主进程      可信文件选择、Herdr、系统通知、受约束 IPC
React 渲染进程       注意力、目标、工序、设置；无 Node 或任意命令能力
packages/core        记录类型、注意力派生、工序快照、校验、锁与原子存储
cli                  人和 Agent 共用的薄命令层，调用同一个 core 服务
Herdr                Session、Tab、Pane、Agent 生命周期与消息
```

Crewvane 不运行模型，不扫描或适配 Agent 协议，不管理模型凭据。应用内用 xterm.js 显示 Herdr 的 TUI，用独立 Electron utility process 中的 node-pty 提供真实 TTY；会话、Agent 管理与通信由 Herdr 负责。任意已经能在 Herdr 中运行的 CLI Agent 都可以使用。

## 状态

工作区由用户选择，状态位于 `<workspace>/.crewvane/`。`state.json` 是完整快照，`events.jsonl` 是追加事件记录，`.crewvane-lock/` 串行化桌面和 CLI 的并发写入。每次修改先写临时文件，再原子替换快照。

`WorkspaceState.version = 2` 当前包含项目、工序、目标与唯一管家引用。旧版没有迁移路径，打开会明确报不支持。

注意力是独立派生：

| 来源 | 进入注意力 |
| --- | --- |
| 人工或管家请求决定 | 是 |
| 提交了带真实检查的交付 | 是，等待验收 |
| 等待事项到达提醒时间 | 是 |
| Herdr Agent 为 `blocked` / 不可达，或目标长期无进展 | 先请管家核查；联系失败或未恢复再提示人介入 |
| Herdr `idle` / `done` / `unknown` 或普通进展 | 否 |

`done` 只是 Agent 空闲，Crewvane 只有在交付检查记录通过且人验收后才把目标设为完成。

## Herdr 管家

应用打开工作区后使用按路径派生的命名 Session，也可以通过 `CREWVANE_HERDR_SESSION` 固定名称。准备管家会检查 CLI 和 Server，优先复用实时 `concierge`，检查登记的 Pane，再显式设置工作区、Session 和 CLI `PATH`，最后启动默认的 Codex 管家。Session 未运行时，应用内 PTY 启动 `herdr session attach <session>` 并等待 Server 就绪，不打开系统 Terminal。同一工作区复用一个连接；收起面板不终止会话，重启应用重新 attach。输入和尺寸 IPC 只允许访问当前工作区的连接，不接受渲染器指定的可执行文件。

管家通过 `crewvane` 读取和写回目标。负责人使用 Herdr Tab、Pane 和 Agent 消息，但 Crewvane 不预设任务图、分配算法或固定层级拓扑。

## 桌面 IPC

渲染进程通过 preload 暴露的有限接口选择工作区与项目、执行目标命令、管理 Herdr 和 CLI、打开 HTTPS 链接。`BrowserWindow` 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，拒绝窗口跳转和权限请求。IPC 校验发送方 URL，项目路径必须先由文件选择器选中。

应用内 CLI 使用随包分发的独立 Node 可执行文件，CLI bundle 位于 ASAR unpack 目录，脚本和 Node runtime 都在 `.app` 内。`~/.local/bin/crewvane` 只是启动器的符号链接，因此移动应用后 CLI 会失败并提示重新安装，可避免悄悄执行旧版本。

## 安装和签名

发布产物包含 DMG、ZIP 和 SHA256SUMS。构建后按 Electron 嵌套代码顺序完成 ad-hoc 或 Developer ID 签名，再制作附件；测试在 ZIP 解压和 DMG 复制后验证严格签名，然后启动安装应用、安装 CLI 并真实创建目标。

代码签名证明包内完整性，不等于 Apple 公证。没有 Developer ID 时仍可能出现“无法验证开发者”；只有已核对 GitHub 来源与 SHA-256 的应用才应按系统提示打开。

# Crewvane｜协航

**把所有事，交给一位管家。**

Crewvane 是一个本地桌面注意力中心。你把项目目标和个人事项放进同一个地方，再交给整个工作区唯一的 Herdr 管家统筹。目标、下一步、等待对象、真实交付和需要你决定的事情集中在同一处；进行中的普通工作不会持续打扰你。

- 一个工作区只有一位 `concierge` 管家，所有项目都找它。
- 工作区打开真实的 Herdr Session，已有 Codex、Claude、OMP、Cursor、Qoder 等 CLI Agent 都可在终端中自然使用。
- 人只需用自然语言补充背景和意见；原始消息、附件与 Agent 的具体答复都按目标隔离保存，不从文本猜状态或授权。
- 负责人通过 Herdr 汇报，管家逐层协调；只有管家无法决定或成果可以验收时才找你。
- 每个项目配置三档上线策略，默认 `external-approval`；决定写入共享账本，同类问题不会反复打扰。
- 删除数据、停服、花钱、外部发消息、改变产品方向、新建或轮换密钥、修改权限始终需要人确认，自动上线策略也不能跳过。
- “新目标”支持粘贴截图、拖入图片或从本机选择；状态只保存附件元数据，不保存 Base64。目标可逐张删除图片，结束 30 天后自动清理，已结束目标也可永久删除。
- 注意力只由明确决定、验收、到期跟进和 Herdr 介入产生，终端 `idle` / `done` 不代表完成。
- 目标详情首屏直接给出当前情况、下一步、负责人、等待对象和最近 Agent 交接；原始目标说明可见，完整消息记录默认展开且最新在上。
- 目标状态变化和注意力首次需要你时可分别订阅 HTTPS Webhook；飞书、Lark 与企业微信机器人开箱兼容，失败退避、跨重启去重。
- Herdr 插件随应用自动安装，可在 Herdr 内打开注意力面板、给 Crewvane 一句话新建目标，或直接回到全局管家。
- 插件订阅 Herdr 原生 Agent 状态、Pane 移动 / 退出和关闭事件，负责人阻塞或现场消失会即时写回；桌面轮询保留为断线兜底。
- 在 Herdr 管家终端直聊时，管家会通过 `crewvane direct` 把原话写回当前案卷或新目标；未经写回的终端聊天不会进入 App。
- 桌面与 `crewvane` CLI 共用同一份加锁、原子写入的本地记录。
- 目标完成、放弃或永久删除时，应用会自动关闭对应负责人 Tab；Herdr 暂时不可达时保留引用，恢复后自动重试。

支持 macOS Apple Silicon。安装包内置经验证的 Herdr CLI，首次启动无需 Homebrew 或额外下载；联网时检查官方最新版并在需要时更新。Crewvane 创建并管理按工作区隔离的命名 Session。关闭应用窗口不会终止 Agent 会话；Herdr 暂时不可用时，记录、提醒、手工更新和验收仍可使用。

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
你记录目标 → 管家读取完整原文与项目规则 → 负责人在 Herdr 中推进
            → 有进展通过 crewvane 写回
            → 需要你时进入注意力 → 查看真实证据 → 验收
```

验收通过只结束 Crewvane 目标。合并与部署按目标所属项目的上线策略放行，默认等待外部审批；Crewvane 自身不执行 Git、部署或外部消息。完整检查命令与结果必须随交付提交；`goal review` 不接受没有检查记录的验收。

## 技术复用

| 需求 | 复用 |
| --- | --- |
| 桌面外壳与系统通知 | Electron |
| 外部消息通知 | 可配置 HTTPS Webhook、Bearer 认证 |
| UI | React、Radix Dialog、Lucide |
| 构建 | esbuild、Vite |
| 持久 Session 与 Agent 通信 | Herdr（应用内安装和管理） |
| 桌面端到端测试 | Playwright |
| macOS 安装附件 | `@electron/packager`、`hdiutil`、`ditto` |

Crewvane 自研的是目标记录、注意力派生、消息与附件、Herdr 管家协议、证据与验收边界。开发、设计、发布等领域流程由任务原文、项目规则或 Agent skill 提供；未来若要可视化，只作为可选流程插件。它不重做 Agent 运行时、模型网关或终端。

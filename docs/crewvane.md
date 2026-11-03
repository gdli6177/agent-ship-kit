# Crewvane｜协航 内测使用说明

交代目标，团队交付。

## 安装与启动

从 [GitHub Releases](https://github.com/gdli6177/crewvane/releases) 下载已发布版本的 `.dmg`，
打开后将 Crewvane 拖入“应用程序”；也可解压 `.zip` 安装。[详细说明](releases.md)。

需要 macOS arm64，已有 Git，以及想接入的 OMP、Codex 或 DeepSeek Harness。
模型登录仍由各运行时管理，协航不会复制账号凭据。

Herdr 是本版推荐的**可选**终端底座。应用会在「设置」中检测 CLI 与 Homebrew：
已安装时显示版本，终端默认使用 Herdr；未安装时显示一次确认的「安装 Herdr」
按钮并执行固定的 `brew install herdr` argv，不需要复制命令。安装失败会显示
Homebrew 输出和可操作错误。应用不会静默安装，也不会因为 Herdr 缺失阻止派工。
Herdr 提供持久工作区、标签页、窗格、多 Agent 状态识别和会话接管；Crewvane
自己的追加事件状态与服务端派工仍是 Agent 之间的通信与升级依据。没有 Herdr 时，
ACP / Codex App Server 会话照常运行，嵌入式终端回退到 Shell 或已发现的 CLI。

从源码启动：

```sh
pnpm install
pnpm desktop:dev
```

生成应用：`pnpm desktop:package`。产物位于
`apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app`。
生成下载附件：`pnpm desktop:dist`，输出 `.dmg`、`.zip` 和 SHA-256 校验文件。
GitHub 发布流程见[安装与发布说明](releases.md)。本内测构建未进行 Developer ID 签名与公证；
自动更新服务留到后续版本。

关闭窗口会保留托盘与后台任务；菜单「停止任务并退出」取消会话后退出。
重新打开时中断需求显示「需要核对」，确认旧会话停止、分支检查点一致后可恢复，
不会直接把中断任务当完成。

## 第一次使用

1. 打开工作区。这个目录保存共享记录，源项目可以在别处。
2. 到「运行时」扫描本机程序，执行连接测试。前三种运行时返回真实模型目录后可配置；Cursor、Qoder 本版只发现，不派工。
3. 保存执行配置。可选择实际模型、推理强度、已有配置作为回退。模型目录不保证每个提供方都已登录或有额度；真实回合若失败会如实记录。
4. 选择 Git 项目根目录、基准分支及完整分支检查命令，配置各角色。
5. 配置并确认项目授权：路径、运行配置、并发、时限和可选 PR 发布权限。
6. 创建需求，选择功能开发、缺陷修复或自定义工序。普通请求立即排队；「先沟通方案」先停留在讨论状态，确认方案后才开工。也可以直接打开「船长」，在同一对话中连续交代 A/B 需求、补充信息或查询进度。船长会实际创建或转交，不把模型说的话冒充进度；归属不确定时保留待澄清选项，重启后仍可继续选择。

默认整个工作区工人容量 3，项目并发只能收紧；每级内部问题最多尝试两次，
独立审查最多三轮。执行配置优先级：任务覆盖 → 工序 → 项目角色 → 工作区默认。
修改已获授权的执行配置或项目设置前需撤销相关授权；撤销会停止相关在途需求。

「运行时」页给出协议、启动参数和流式、取消、恢复、模型发现、交互终端等能力，
用来说明“发现了程序”和“可以安全派工”不是同一状态。工作区根目录可用
`crewvane.runtimes.json` 增加自定义 ACP 或 Codex App Server CLI；清单只接受
可执行文件名和 argv 数组，不执行 shell 字符串，也不保存凭据。

## 工序和交付

工序模板可增删、排序，配置目标、输入、输出、角色、执行配置、完成标准、并行数、
重试和返工位置。输入必须引用 request 或前序输出，最后必须有独立验证员。
新版本不改变已经启动的需求。返工会使后续结果失效并重新验证。

每需求独立集成分支，各工人独立 worktree。宿主收集并检查允许路径后提交、集成；
验证员使用独立会话只读检查，宿主再执行项目配置的完整分支验证命令。
有 PR 权限才推送需求分支并创建 PR；使用固定分支查询既有 PR，重试不会盲目重复创建。
本版固定 external-approval，不合并、不部署。

问题先交直属队长，再交船长；只有真实人工升级进入「待我决定」与系统通知。
人工决定可按项目及相同根因记入账本，后续命中时引用已有来源。
改变范围、权限、上线策略，删数据、停服、花钱、对外消息、密钥等动作不能靠模型同意来扩大授权。

验证报告保存在 `.crewvane/evidence/<task-id>/report.md`，详情页可定位文件。
任务、实例、决定、消息和模板版本从同一个追加事件日志重建；桌面和 CLI 不各存一份任务数据库。

## 团队知识

「知识」页可连接项目现有团队手册与其他必读 Markdown。手册和显式规则合计最多
64 KB 注入正文；自动读取的 `AGENTS.md` 只生成流式摘要回执，不因其大小阻断
派发。工人在同一运行时会话内最多检索三次，不能只凭模型自述声称读过材料。

通过独立验证的交付可以提炼经验候选，候选绑定真实任务和验证提交。人工检查
适用条件、执行方法与证据后才能纳入，审核人不能是候选作者。已纳入经验才可被
后续任务召回；停用过期经验不会继续作为行动建议。手册原文不会被自动改写，
同一套 lesson 卡片继续兼容手工 CLI。

每个工序目前启动独立工人，独立验证员与工人会话隔离。同一个有连续身份的
工人跨工序执行按当前产品决定暂不实现。

## 测试密码本

「密码本」用 Electron safeStorage 和 macOS 系统钥匙串保存测试账号、密码或 key。
先给凭据命名，选择 `E2E_` 环境变量和它唯一服务的项目验证命令；保存后不能查看
明文。再到「项目 → 配置并授权」明确允许这项凭据，未授权时不会注入。

独立验证员只请求宿主执行指定检查，宿主将值短暂交给该测试进程，不把明文交给
模型、工人或界面。事件和「最近使用记录」只含引用、命令与时间；输出及证据会
脱敏，包括分块输出和常见编码形式。删除已授权凭据前需要先撤销项目授权。

这是应用层的授权与脱敏边界，不是面向同一 OS 用户的沙箱。只给可信测试命令
授权，命令本身仍能把传入的环境变量用于它具备的系统权限。

## 开源复用边界

| 需求 | 复用 |
| --- | --- |
| 桌面外壳 | Electron |
| UI 基础组件 | React、Radix UI Themes / Dialog |
| 图标 | Lucide |
| 终端 UI | xterm.js |
| PTY | node-pty |
| Agent 协议 | ACP、Codex App Server |
| 终端会话 | Herdr（可选，默认推荐） |
| 端到端测试 | Playwright |

协作状态机、层级升级、工序、授权、验证和证据归属 Crewvane。ACP 与 Codex
App Server 的 JSON-RPC 子集已有协议测试和真实运行时试用，本版不额外引入
`@agentclientprotocol/sdk`。

## CLI

安装命令现在是 `crewvane`，不提供旧别名：

```sh
curl -fsSL https://raw.githubusercontent.com/gdli6177/crewvane/main/install.sh | bash
crewvane workspace scan --probe all --root /path/to/workspace
crewvane workspace status --root /path/to/workspace
crewvane workspace apply --input command.json --root /path/to/workspace
crewvane workspace run --until-idle --root /path/to/workspace
```

`workspace apply` 接收与桌面相同的结构化业务命令，类型定义见
`packages/orchestrator/src/service.ts`。例如：

```json
{"type":"task.submit","projectId":"my-project","request":"修复搜索分页并增加回归测试","workflowId":"bugfix"}
```

只能有一个工作区调度器；已有 CLI 调度器时，桌面仍可查看和提交共享记录。
旧的手工合同 CLI（setup、intake、slice、inbox 等）保留，但使用新命令名、状态目录与环境变量。
它与桌面项目授权模式分别执行各自的授权门禁，不将旧合同当新项目授权。

## 旧版迁移与卸载

先用旧版收集或停止尚未结束的任务，再在桌面打开状态目录之前迁移：

```sh
crewvane migrate --project /path/to/project --dry-run
crewvane migrate --project /path/to/project
crewvane legacy uninstall --project /path/to/project --dry-run
crewvane legacy uninstall --project /path/to/project
```

迁移保留原目录，并在项目内创建 `.crewvane-backup-<digest>` 备份；校验后切换。
同一内容重复迁移无副作用；新状态已存在或旧状态已改变时拒绝覆盖。
失败时原目录仍保留，检查备份和 staging 后再重试。旧 authority 不导入新授权。
历史手工合同记录继续通过手工 CLI 查询，不自动变成桌面队列中的执行需求。

卸载根据旧安装 manifest 和管理标记删除确认归属的 shim、未修改技能、项目 hook、
对应定时器，恢复 owner hook。未知或修改过的技能、安装源码档案和业务资料保留并列出原因。
`--home DIR` 可对指定用户目录执行检查；不指定项目时只处理已确认的用户级安装入口。

## 验证

```sh
pnpm typecheck
pnpm test
pnpm test:desktop
pnpm test:crewvane
```

普通测试使用协议 fixture 与真实 Git/worktree；`test:crewvane` 先探测本机模型目录，
再跑实际可用的 OMP、Codex、DSH，并在报告中列出真实执行过的运行时。该试用脚本中的
模型来自开发机实测目录，其他机器按本机情况调整。
协议连接不读取或输出凭据。运行时自身的插件、hook、sandbox 行为仍由运行时管理；
应用授权守卫不是面向同一 OS 用户的安全隔离边界。

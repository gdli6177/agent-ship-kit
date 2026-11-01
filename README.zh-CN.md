[English](README.md) | **简体中文**

# agent-ship-kit

第一次使用，从 [Quick Start](#quick-start) 开始。配置细节见[团队手册与经验回流](docs/team-and-learning.md)，并行工作目录见[多仓库与 worktree](docs/workspace-parallel.md)。

agent-ship-kit 是并行 AI 编程交付的验收与注意力层。人从需求进入到交付，只和一位船长（captain）对话。工人（worker）没有事先排好的花名册，而是在合同冻结之后，按切片按需生成。它可以接在 Herdr、Orca、Multica 或任何别的编排器上面，用一层薄适配器接进去；没有编排器时也可以用。它不负责任务调度，不会自动合并到 main，也不会部署到生产。船长起草方案，人冻结合同，工人交回证据，人接受证据之后，事情才算可以往下走。

状态：v0。包含技能、模板、事件 schema、适配器说明，以及本地收件箱和通知 CLI。

## Quick Start

下面用“给任务列表增加筛选按钮”走完一次交付。你主要向 Agent 发送消息；每个文本框都是一条可复制的示例消息。方案、合同和任务编号以船长实际返回的为准。

流程：安装 → 指定船长 → 初始化项目 → 提出需求 → 冻结方案 → 派工 → 看证据并决定。

### 1. 让你正在使用的 Agent 安装工具

准备一个能使用的 Agent 宿主，以及 Node.js 20+、npm 和已有的 Git 项目。macOS、Linux 可直接安装；Windows 使用 WSL。把下面的话发给当前 Agent：

```text
请阅读 https://github.com/gdli6177/agent-ship-kit 的安装说明，帮我安装这套工具。
先检查 Node.js 20+ 和 npm，读取安装脚本后再运行。
按我当前使用的宿主明确选择 --agent codex、--agent claude 或 --agent cursor；
如果不能确认宿主，先问我，不要安装到另一款 Agent 的目录。
这一步只安装工具和技能，不初始化项目，不改业务代码。
完成后运行 agent-ship --help，告诉我技能安装路径，以及是否需要重新载入会话。
```

你应该看到 CLI 检查成功，以及当前宿主对应的技能目录。若当前会话还未识别新技能，按宿主要求重新载入或新开会话。想手动安装，见下方[安装](#安装)。

### 2. 在项目里指定一个“船长”主对话

本项目把团队的队长称为船长（captain）。它是你指定的 Agent 角色，不是安装后自动出现的另一个程序。在目标项目中打开一个主对话，可以把它命名为“任务列表 · 船长”，然后发送：

```text
你担任这个项目的 agent-ship-kit 船长，我以后在这个主对话里提出需求和验收。
先读取项目已有规则，以及已安装的 ship-setup、ship-contract、ship-dispatch、ship-inbox 技能。
请说明你能否创建独立工人会话、查询状态并收回结果，以及准备使用哪种执行方式。
先不要改业务代码，也不要派工。
```

预期结果：这个主对话负责方案、派工、收件箱和与你沟通；工人按任务创建。CLI 安装成功只说明工具可用，实际工人还依赖宿主的子代理能力或已接通的编排器。相关接口见[适配器](adapters/README.md)。

### 3. 让船长初始化当前项目

想采用共享团队手册时，在同一主对话发送：

```text
/ship-setup
请对当前项目执行共享初始化（agent-ship setup --shared）。
已有团队手册就引用，没有才创建初版。保留已有规则和钩子，列出实际改动的文件。
```

你应该看到成功的 setup 报告、`agent-ship.team.json`，以及创建或引用的团队手册。它们可以纳入版本管理；运行记录保存在本地 `.agent-ship/`。审阅新增共享文件后，再按项目习惯提交。

如果只是自己先试用，把消息中的共享初始化换成普通 `agent-ship setup`：它只建立本地接入，不创建共享手册。已有 Git hook 配置发生冲突时，先让船长说明冲突，处理后再继续。

### 4. 提出第一条需求，先看方案

```text
/ship-contract
给当前项目的任务列表增加“只看未完成”筛选。
关闭筛选时保持原列表行为，不改登录、支付或部署。
请先检查现有实现，提出修改范围、验收方式和切片建议，暂时不要开工。
```

船长应返回一张方案卡，说明目标、不做什么、允许/禁止路径、验收项及切片。项目规则和相关经验由船长按需读取。此时你可以继续修改要求，例如“刷新页面后不用记住筛选状态”。

### 5. 确认范围后，明确冻结方案

假设船长返回的方案编号是 `proposal_todo_filter`，你发送：

```text
冻结方案 proposal_todo_filter。按当前文字生成合同，不扩大范围。
```

预期结果：生成带编号、冻结人、冻结时间和验收条件的合同。冻结前不派工；冻结后要扩大范围，就产生修订方案并重新确认。不要只说“差不多”，也不要把这里的示例编号当成自己的真实编号。

### 6. 让船长开始执行

假设合同编号是 `contract_todo_filter`：

```text
/ship-dispatch
开始执行合同 contract_todo_filter。
确认执行方式可用，准备独立分支或 worktree，通过派工门禁后再启动工人。
告诉我实际启动的任务、工人引用和分支。完成后先独立核验，再放进收件箱。
```

你应该看到真实任务和执行位置，之后可以在主对话询问进度。`slice start` 只是登记与预留名额，不能把这条命令成功当成工人已经启动。

如果当前宿主不能创建和收集独立会话，先停在“待接入执行方式”，按[通用适配器](adapters/generic.md) 接通执行方式再继续。没有编排器账号也能使用宿主原生会话能力；若需要人工转交任务包，应明确这是手动流程，不声称自动并行已经可用。

### 7. 中途有问题，仍在主对话处理

工人需要拍板时，船长会整理为 blocked 或 needs_approval。例如要修改原范围以外的公共组件，你可以回复：

```text
先说明影响和替代方案。需要扩大范围时，给我修订方案，等我重新冻结再继续。
```

原范围内的问题决定后，由船长恢复同一个任务；范围变化则回到方案确认。普通待审默认留在收件箱，离开电脑前不要假设已经配置推送。你回来后可以主动问进度或打开收件箱。

### 8. 看证据，再接受或退回

```text
/ship-inbox
```

船长逐条呈现短卡片：改了什么、合同和分支、验证证据、未验证项及风险。需要时说“展开测试报告”或“给我看界面截图”（有该项证据时）。然后选择：

| 你回复 | 后续动作 |
| --- | --- |
| `通过` | 记录 accept，关闭这一条待审。 |
| `要改：筛选打开后，完成一条任务应立即从列表消失。` | 记录修改意见，回原任务修正、重新核验和送审。 |
| `拒绝：这条需求取消。` | 结束该任务。 |

送审前的经验检查由船长和核验者完成。常规改动可以为 none，不要求你每次维护一篇经验；候选经验也不会自动变成团队规则。接受证据之后，合并和发布仍由你按项目流程操作。

### 接下来每天怎么用

**再开一个需求：** 在同一主对话重新从 `/ship-contract` 开始。前一个任务执行期间，可以讨论下一份方案；符合条件的独立任务才并行，超出并行上限时先不启动。

```text
另起一个需求：给任务列表增加 CSV 导出。请先单独出方案，
检查它与筛选功能是否改动相同模块，明确如何隔离或安排顺序。
```

**换项目：** 在新项目指定主对话并单独 setup。一个船长管理多个仓库时，共享状态和执行仓库要明确区分，按[多仓库与 worktree 指南](docs/workspace-parallel.md) 接入。

**对话重开：** 在原项目的新主对话指定船长，要求“读取已有合同、运行记录和收件箱，核对真实工人状态，恢复进度视图，不要重复派工”。记录存在不代表旧工人仍在运行。

**命令不识别：** 请 Agent 检查安装的技能目录。不能路由斜杠命令时，让它读取 `~/.agent-ship-kit/current/skills/<技能名>/SKILL.md` 后按流程执行；CLI 不在 PATH 时可用 `node "$HOME/.agent-ship-kit/current/cli/bin/agent-ship.js" --help` 检查。

**版本不一致：** 默认安装 main，只包含已合并功能；从功能分支评审本文时，安装对应的 `--ref`，不要期待旧版本具备新命令。

## 你得到什么

| 部分 | 作用 |
| --- | --- |
| [skills/](skills/) | 一条斜杠命令对应一份技能。技能名就是命令名：`/ship-inbox` 加载 `ship-inbox`。 |
| [templates/](templates/) | 方案卡、合同、待审包、交付流程、登录索引、通知策略 |
| [adapters/](adapters/) | `spawn` / `status` / `collect`，以及 Herdr、Orca、Multica 的说明 |
| [events/schema.json](events/schema.json) | `needs_review`、`blocked`、`needs_approval` 以及相关事件 |
| [cli/](cli/) | `setup`、`check`、inbox、`notify dry-run`、`notify run` |

产品边界的中文说明在 [docs/PRODUCT.md](docs/PRODUCT.md)。事件、适配器和通知的行为在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 边界

船长是路由器，不是执行器。它和人说话、起草合同、派工、路由事件、记下决定。它不改产品代码，也不自己跑长任务，包括看起来很小的改动。它也不卡住等工人：切片还在跑的时候，下一条请求照样接收。

只靠提示词说「别自己动手」不可靠，所以边界写在冻结合同上。工人执行。船长回到人这边。

已订阅线程（`thread_refs`：PR、issue、聊天）上的后续消息直接给对应工人。船长只处理新的、还没有主人的事件，以及跨切片的协调。

推测草稿默认关闭。只有 `.agent-ship/limits.json` 里 `"speculative": true` 时，船长才可以根据进来的信号预先起草方案卡或只读的复现，而且必须已经有证据才给人看。没有冻结合同，仍然不能派工，也不能改代码。

常驻云运行时、算力与状态分离、设备守护进程是编排器的事。适配器只做映射，本工具不重做这些。

人仍然要做三件事：冻结合同、审证据、自己合并或发布。`accept` 不是合并。

## 安装

一条命令。不克隆仓库，不用 sudo，也不改任何项目。它把工具下载到 `~/.agent-ship-kit/<ref>`（默认 `main`），并用符号链接 `~/.agent-ship-kit/current` 指向这一版。它在 `~/.local/bin` 放上 `agent-ship` 命令，并把七份技能拷进它找到的代理 skill 目录（`~/.cursor/skills`、`~/.claude/skills`、`~/.codex/skills`）。技能和命令垫片都走 `current`，之后换 `--ref` 也不用改这些路径。

```bash
curl -fsSL https://raw.githubusercontent.com/gdli6177/agent-ship-kit/main/install.sh | bash
```

需要 Node.js 20 或更新。不需要 API 密钥。如果 `~/.local/bin` 不在 `PATH` 里，安装脚本会打印要加的那一行。再跑一次同一条命令就是升级。用 `--ref` 或 `AGENT_SHIP_REF` 固定某个标签：

```bash
curl -fsSL https://raw.githubusercontent.com/gdli6177/agent-ship-kit/main/install.sh | bash -s -- --ref v0.1.0
```

`--agent cursor|claude|codex|all` 选择 skill 目录。`--target <目录>` 只拷到那个目录。分支名可以带斜杠（`feature/foo`），目录名会写成 `feature__foo`。换一个 ref 安装时，会删掉上一个 ref 的目录。卸载会删掉命令垫片、安装脚本自己拷进去的技能目录，以及整个 `~/.agent-ship-kit`（所有 ref 和 `current`）：

```bash
curl -fsSL https://raw.githubusercontent.com/gdli6177/agent-ship-kit/main/install.sh | bash -s -- --uninstall
```

Windows 用 WSL（Ubuntu），在里面跑上面的命令。Git Bash 和 MSYS 会被拒绝。

安装后，按 [Quick Start](#quick-start) 在项目中指定船长主对话，再进行 `/ship-setup`。

### 手动克隆

不能用安装脚本时，自己克隆并拷贝技能：

```bash
git clone https://github.com/gdli6177/agent-ship-kit.git
cd agent-ship-kit
npm install
mkdir -p ~/.cursor/skills
cp -R skills/ship-setup skills/ship-watchdog skills/ship-contract skills/ship-dispatch skills/ship-inbox skills/ship-notify skills/ship-e2e ~/.cursor/skills/
```

在这份检出里，`npx agent-ship` 可以跑 CLI。把 `agent-ship` 放进 `PATH` 的是安装脚本。

## 斜杠命令

这些名字用在船长对话里，不依赖某家代码托管。

| 命令 | 船长做什么 |
| --- | --- |
| `/ship-setup` | 只初始化当前这份克隆。钩子写在 `.git/hooks`，已有钩子会串起来，不覆盖。忽略规则写在 `.git/info/exclude`，不改共享的 `.gitignore`。`--shared` 才写入共享忽略块、规则入口，并创建或引用团队手册与经验配置。`--uninstall` 卸掉钩子和规则块，但继续排除 `.agent-ship/`。`--uninstall --purge` 连这个目录一起删。从不设置 `core.hooksPath`。 |
| `/ship-contract` | 起草一张方案。人明确冻结之后，才写成合同。 |
| `/ship-dispatch` | 按冻结合同派工。船长自己不改代码。 |
| `/ship-inbox` | 按优先级列出未决项，然后一次审一条（合同、证据、风险）。人回复 `pass`、`changes` 加原因，或 `reject`。 |
| `/ship-inbox <id>` | 直接跳到这一条。通知里的深链就是这个形式。先看一张短卡片：摘要不超过 280 字，加上回溯链。 |
| `/ship-notify` | 按允许列表演练或发出通知。 |
| `/ship-e2e` | 共享登录和冒烟。生产环境只读。 |
| `/ship-watchdog` | 不是船长。`watchdog install` 会真正登记用户级定时器：Linux / WSL 用带标记的一行写入 crontab；macOS 把 plist 写到 `~/Library/LaunchAgents` 并执行 `launchctl bootstrap`。检查看心跳、切片自己那条分支上的提交，以及 `check`。只有真的有问题才写入 `blocked`。没有在跑的切片时立刻退出，并卸掉这个定时器。 |

## 斜杠命令怎么跑

一条命令对应一份技能。技能文件里的 `name` 就是去掉斜杠的命令名，所以在 Cursor、Claude Code 以及其他会把斜杠命令交给技能的宿主上，`/ship-inbox` 会打开 `skills/ship-inbox/SKILL.md`。技能说明该做什么，确定性的步骤调用 `agent-ship` CLI（收件箱、检查、通知、看门狗）。CLI 的子命令仍然叫 `inbox`、`notify`、`check`、`setup`、`watchdog`、`slice`。输入 `/ship-inbox` 不会把这些子命令改名。

**没有技能支持。** `agent-ship setup` 写进 `AGENTS.md` 的常驻规则块把每条命令指到一个文件。照着那个文件做：

| 命令 | 跟着做 |
| --- | --- |
| `/ship-setup` | `skills/ship-setup/SKILL.md` |
| `/ship-contract` | `skills/ship-contract/SKILL.md` |
| `/ship-dispatch` | `skills/ship-dispatch/SKILL.md` |
| `/ship-inbox` | `skills/ship-inbox/SKILL.md` |
| `/ship-notify` | `skills/ship-notify/SKILL.md` |
| `/ship-e2e` | `skills/ship-e2e/SKILL.md` |
| `/ship-watchdog` | `skills/ship-watchdog/SKILL.md` |

**纯终端。** 安装之后，在项目目录里跑 `agent-ship`。命令不在 `PATH` 上时，用 `node $HOME/.agent-ship-kit/current/cli/bin/agent-ship.js`。

| 命令 | CLI |
| --- | --- |
| `/ship-setup` | `agent-ship setup` |
| `/ship-dispatch` | `agent-ship slice start --contract <id> --slice <id> --source-task-id <task> --title "..." --summary "..."` |
| `/ship-inbox` | `agent-ship inbox list --sort priority` |
| `/ship-inbox <id>` | `agent-ship inbox decide <id> accept\|changes_requested\|reject` |
| `/ship-notify` | `agent-ship notify dry-run --latest --policy .agent-ship/notify.policy.md --allowlist .agent-ship/notify.allowlist.json` |
| `/ship-watchdog` | `agent-ship watchdog` |

`/ship-contract` 和 `/ship-e2e` 是技能里的流程，没有单独的子命令。派工或审阅时的路径检查是 `agent-ship check --contract <id>`。`/ship-setup` 会把通知策略和允许列表写进 `.agent-ship/`。在那之前，把 `--policy` 和 `--allowlist` 指到 `$HOME/.agent-ship-kit/current/templates/`。

`agent-ship check --contract <id>` 用普通 git 把工作分支和基线分支做 diff。改动的路径落在禁止列表里，或不在允许列表里，检查就失败。本地 pre-commit 对 `.agent-ship/active-contract` 里的合同做暂存区检查。pre-push 拒绝推到 `main` 和 `master`，除非人自己设置 `AGENT_SHIP_ALLOW_PROTECTED_PUSH=1`。CI 也可以跑同一条 `check`，那是附加的，钩子不依赖它。

## 交付流程

完整步骤在 [templates/workflow.md](templates/workflow.md)。压缩起来是：

1. 讨论时只维持一张方案卡，每轮写明改了什么。
2. 人冻结之后才有合同。合同写明允许路径和禁止路径。
3. 在合同自己的并行上限和全局上限（默认同时 3 个工人）之内派工。`slice start` 把切片记下来。分支必须已经存在，默认名是 `ship/<合同>/<切片>`。合同还必须有真实的 `Frozen by`、可解析的 `Frozen at`、非空 Forbidden paths，并且切片写在 Slices 表里。对应错误是 `contract must record Frozen by`、`contract must record a valid Frozen at`、`contract needs non-empty Forbidden paths`、`slice <id> is not in the Slices table`，以及 `branch <name> does not exist in <repo>; create it first (git branch <name> <base>)`。先 `git branch` 再登记。第一条切片会登记看门狗定时器。`.agent-ship/sequence` 是同一毫秒内事件的序号，命令持有状态锁时不要改它。锁目录 `.agent-ship-lock` 记下 `pid`、`hostname`、`started_at`、`cmd`。本机 pid 已退出就自动收回；否则错误里会写出拥有者。确认进程退出后，手工恢复是 `rm -rf` 那个锁目录。详见 [docs/workspace-parallel.md](docs/workspace-parallel.md)。
4. 工人卡住或需要中途拍板时，只回给船长，收件箱用 `blocked` 或 `needs_approval`。人不要打开工人会话。
5. 工人说做完之后，另开一个只读核验，只给冻结合同和分支，不给工人对话。核验重跑验收、`agent-ship check` 和相关冒烟。不一致就退回工人。
6. 一致之后才写成待审包并 `inbox add`。`/ship-inbox` 先看短卡片，主人要求再展开。
7. 人用 `pass` / `changes` 加原因 / `reject` 决定。船长用 `inbox decide` 记下。`accept` 不是合并。
8. 改冻结合同不是改原文件。停掉受影响的切片，新开合同号并指向旧号，等人重新冻结。没被新文本影响、已经做完的切片保留。
9. 合并和发布由人用自己的工具完成。

## 通知

普通待审默认拉取：留在收件箱里，不推送。推送只针对带证据的高优先级 `needs_review`，以及 `blocked` / `needs_approval`。高优先级但 `evidence_urls` 为空时，不会呼叫。

有两层过滤。快路径是 CLI 里的规则和允许列表，不调用模型。慢路径是船长阅读策略里的说明文字，可以用 `--action` 提出一条 argv，允许列表和「没有证据不许呼叫」仍然生效。

推送不超过 100 词，要说清需要什么决定，并带上 `/ship-inbox <id>`（中间是空格，不是路径）。待审包和 PR 正文才是完整、结构化的长文，不要塞进推送。

`notify dry-run` 只打印计划。`notify run` 是可选的：只有 `allow` 为 true 时，才用不经 shell 的 argv 执行。示例允许列表是 `multica issue create --assignee me *` 和一条发往 `hooks.example` 的 curl，没有真实密钥。

## 看门狗

`agent-ship watchdog` 是确定性检查，里面没有模型。它读 `.agent-ship/events.jsonl` 里的 `worker_progress` 心跳、切片自己那条分支上的最近一次提交，以及 `agent-ship check`。别的分支上的新提交不算进展。只有超时（`stalled`）或路径越界（`drift`）才写入一条 `blocked`。船长看到这条收件箱之后才介入。

没有 `queued` 或 `running` 的切片时，它立刻退出，并卸掉定时器，不跑检查，也不写收件箱。

`slice start` 在第一条切片打开时登记定时器。Linux 和 WSL 上，`watchdog install` 用 `crontab -l | … | crontab -` 写入一块带标记的内容，可以重复执行，其他 crontab 行保留。macOS 上把 plist 写到 `~/Library/LaunchAgents`，并执行 `launchctl bootstrap gui/$UID`；卸载时 `bootout` 并删掉这个 plist。`--dry-run` 只打印将要登记的内容，不真的登记。登记失败，或者系统既不是 Linux 也不是 macOS，命令会打印警告。之后只要还有切片在跑而定时器没有生效，`watchdog` 和 `inbox list` 也会警告。

`~/.config/agent-ship/` 里会留一份 cron 行和 plist 的副本，方便查看，那不是登记本身，也不进仓库。编排器的调度器或人自己的助手例程也可以直接跑 `watchdog`，代替这个定时器。窗口默认 30 分钟，可在 `.agent-ship/limits.json` 里用 `stale_minutes` 修改。

## 端到端与登录

登录和冒烟的索引在 [templates/e2e.md](templates/e2e.md)，做法在 [templates/e2e-testing.md](templates/e2e-testing.md)，船长步骤在 `skills/ship-e2e/SKILL.md`。

每个项目一份 Playwright `auth.setup.ts`，登录后把 `storageState` 存到 gitignore 的路径，短冒烟复用它，不再登录。项目之间、环境之间不共用这个文件。

测试环境需要：专用测试账号、可脚本化的登录或验证码/短信的测试环境旁路、够跑完冒烟的会话时长。做不到就写入 `blocked`，不要为了测试关掉生产环境的校验。

生产只读。人在浏览器里登录一次，把短命的 `storageState` 导出到索引里那一行。只告诉船长文件已经放好，不要把文件、cookie 或密码贴进对话。会话过期就请人再导出一次。密码留在密码管理器或本机环境变量里，不进 git、技能或聊天。

冒烟结果写成待审包里的证据行，指针是报告，不是 storageState。

## 适配器

本工具不是编排器。适配器只翻译三件事：`spawn`（按冻结合同的一个切片开工）、`status`、`collect`。规范在 [adapters/generic.md](adapters/generic.md)。Herdr、Orca、Multica 各有一篇短说明，不伪造它们的 HTTP 路径。

已订阅的 `thread_refs` 上的后续事件交给那个工人。看门狗由 cron、编排器调度或人的助手例程定时跑，适配器在有真实进展时追加 `worker_progress`。

不要把合并、打标签、生产部署、常驻云运行时、算力与状态分离或设备守护进程映射进这三调用。没有编排器时，`spawn` 就是为每个切片另开一个代理会话。人仍然只待在船长线程里。

## 收件箱与通知演练（不启动工人）

不需要编排器账号，不需要 `multica` 可执行文件，也不需要 webhook。收件箱是一个 JSONL 文件。演练只打印计划，不执行。普通优先级是拉取：留在 `inbox list` 里，没有对应的推送规则。下面这条高优先级示例带了证据 URL，所以计划允许执行，但 `executed` 仍是 false。

```bash
agent-ship inbox add \
  --title "Auth middleware ready" \
  --summary "Contract checks passed on the slice branch." \
  --priority high \
  --source-task-id task_auth_mw \
  --evidence https://ci.example/runs/1001 \
  --pr https://example.com/pull/12 \
  --path .agent-ship/packets/task_auth_mw.md

agent-ship inbox list

agent-ship notify dry-run --latest \
  --policy "$HOME/.agent-ship-kit/current/templates/notify.policy.example.md" \
  --allowlist "$HOME/.agent-ship-kit/current/templates/notify.allowlist.example.json"
```

在项目目录里跑。`agent-ship` 不在 `PATH` 上时，改用 `node $HOME/.agent-ship-kit/current/cli/bin/agent-ship.js`。

预期得到一条 `needs_review`，然后计划的 `matched_rule` 是 `high priority page`，`allow` 为 true，`executed` 为 false。去掉 `--evidence` 之后，同样的高优先级项不会被呼叫。`notify run` 是可选的，只启动允许列表里的 argv，不经过 shell。`inbox decide <id> accept` 写入 `review_decided`，之后 `inbox list` 不再显示这一条。

做到一半的问题用 `inbox add --type blocked` 或 `--type needs_approval`。人在这个收件箱里回答，不要打开工人会话。

不用 CLI、只要船长时，按 [templates/workflow.md](templates/workflow.md) 和 [adapters/generic.md](adapters/generic.md)。`spawn` 是每个冻结合同切片一个新的代理会话。登录和冒烟见 [templates/e2e.md](templates/e2e.md)。人留在船长线程里。

## 常见问题

**它是编排器吗？** 不是。它不管工人进程怎么跑。Herdr、Orca、Multica 或一个额外的代理会话都接在适配器后面。

**会自动合并或上线吗？** 不会。接受证据只表示证据符合冻结合同。合并和发布由人完成。

**没有技能支持怎么办？** 看 `AGENTS.md` 里的规则块，按上表打开对应的 `SKILL.md`。

**只有终端怎么办？** 用上表里的 `agent-ship` 命令。审一条的决定是 `inbox decide`，不是另一个子命令。

**看门狗为什么没在跑？** `watchdog install` 才会登记 crontab 或 launchd。只在磁盘上留一份片段不算登记。有切片在跑但定时器没生效时，`watchdog` 和 `inbox list` 会警告。`--dry-run` 可以先看将要写入的内容。

**别的分支刚提交，切片还算卡住吗？** 算。进展只看这条切片自己的分支，加上明确的 `worker_progress` 事件。

**密码放哪？** 密码管理器或本机环境变量。不进 git、技能、合同、收件箱或对话。

## 测试

```bash
cd cli
npm test
npm run typecheck
```

## 目录

```text
README.md
README.zh-CN.md
LICENSE
install.sh
package.json
docs/PRODUCT.md
docs/ARCHITECTURE.md
skills/ship-contract/SKILL.md
skills/ship-dispatch/SKILL.md
skills/ship-inbox/SKILL.md
skills/ship-notify/SKILL.md
skills/ship-e2e/SKILL.md
skills/ship-setup/SKILL.md
skills/ship-watchdog/SKILL.md
templates/limits.example.json
templates/proposal-card.md
templates/verifier-prompt.md
templates/contract-card.md
templates/review-packet.md
templates/workflow.md
templates/e2e.md
templates/e2e-testing.md
templates/notify.policy.example.md
templates/notify.allowlist.example.json
adapters/README.md
adapters/generic.md
adapters/herdr.md
adapters/orca.md
adapters/multica.md
events/schema.json
cli/package.json
cli/bin/agent-ship.js
cli/README.md
cli/src/cli.ts
cli/src/inbox.ts
cli/src/notify.ts
cli/src/run.ts
cli/src/check.ts
cli/src/paths.ts
cli/src/setup.ts
cli/src/watchdog.ts
cli/src/types.ts
cli/test/
.agent-ship/.gitkeep
```

## 许可

[MIT](LICENSE)

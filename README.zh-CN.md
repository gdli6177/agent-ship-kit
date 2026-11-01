[English](README.md) | **简体中文**

# agent-ship-kit

第一次使用，从 [Quick Start](#quick-start) 开始。配置细节见[团队手册与经验回流](docs/team-and-learning.md)，并行工作目录见[多仓库与 worktree](docs/workspace-parallel.md)。

agent-ship-kit 是并行 AI 编程交付的验收与注意力层。人从需求进入到交付，只和一位船长（captain）对话。工人（worker）没有事先排好的花名册，而是在合同冻结之后，按切片按需生成。它可以接在 Herdr、Orca、Multica 或任何别的编排器上面，用一层薄适配器接进去；没有编排器时也可以用。它不负责任务调度，不会自动合并到 main，也不会部署到生产。船长起草方案，人冻结合同，工人交回证据，人接受证据之后，事情才算可以往下走。

状态：v0。包含技能、模板、事件 schema、适配器说明，以及本地收件箱和通知 CLI。

## Quick Start

**你只管说目标、确认方案、看结果。步骤和编号交给船长，不需要记斜杠命令。**

### 第一次：把项目交给当前 Agent 接入

在目标 Git 项目里打开你平时使用的 Agent，发送一次：

```text
帮我安装并接入 https://github.com/gdli6177/agent-ship-kit。
你就作为这个项目的船长，后面由你管理流程，我直接说需求。
请创建或复用共享团队手册，保留项目已有规则。
检查当前宿主和执行能力，完成后告诉我是否能开始。
```

Agent 应读取安装说明和脚本、检查 Node.js 20+ 与 npm、选择当前宿主的技能目录，执行共享初始化，并确认能否创建、查询和收集独立工人与核验者。macOS、Linux 和 Windows WSL 可安装。安装与初始化不改业务代码、不启动需求任务；共享文件会列给你审阅。

**你不用另找“队长”。** 当前主对话就是船长。它应简短报告“已就绪，直接告诉我想做什么”，或指出真实阻塞及下一步。若宿主需要重载技能，按提示重开会话即可；新会话先恢复项目记录并核对真实状态，不重复派工。

工具安装成功不代表工人运行能力已经接通。船长应在接入时查明这一点；不能自动执行时明确说明，不把配置流程留到开工后才让你处理。安装细节见[安装](#安装)，执行接入见[适配器](adapters/README.md)。

### 平时：直接说你要做什么

```text
给任务列表加一个“只看未完成”的筛选，其他行为保持不变。
```

船长自己检查实现、读取相关规则和有限经验、提出验收办法。只向你展示一份简短方案：做什么、影响什么、怎么判断完成；能自行查明的技术细节不反问你。需要你决定的关键问题才会提出。

你可以继续改要求；确认刚展示的方案后，直接回复：

```text
按这个方案开始。
```

船长把这次明确确认记录为冻结合同，接着安排隔离分支和真实工人，独立核验后再交给你验收。你不用输入方案编号、合同编号或再发派工命令。若同时有多个可能指向的方案，船长先问清是哪一项；沉默、随口“好的”或最初提需求都不算开工确认。

任务执行中，你仍在同一对话说话：

| 你直接说 | 船长负责 |
| --- | --- |
| `做到哪了？` | 查询真实状态，简报进度、阻塞和待审项。 |
| `再加一个 CSV 导出的需求。` | 单独出方案，检查与现有任务的重叠，决定可否并行。 |
| `刚才那项先停下。` | 确认目标，按执行能力停工并记录状态。 |

### 完成后：看结果，给判断

说“看看结果”，船长给你一张短卡：改了什么、可打开的证据、核验结果和剩余风险。你按结果回复即可：

```text
通过。
```

或者：

```text
要改：筛选打开后，完成一条任务应立即从列表消失。
```

船长记录决定，把修改交回原任务并重新核验；若要求扩大原范围，它会先给修订方案。内部检查、核验退回和常规经验检查由团队处理，不要求你每次维护文档。合并和发布仍由你按项目流程操作。

普通待审默认留在收件箱；你回来问进度或看结果即可。后台持续运行和主动推送取决于已接通的宿主及通知配置，工具不会凭空提供这些能力。

### 需要细节时再展开

`/ship-*` 是可选快捷方式，下面的命令表供排查和进阶使用。团队手册和经验预算见[配置指南](docs/team-and-learning.md)，跨项目及同项目并行见[多仓库与 worktree](docs/workspace-parallel.md)。默认安装 main；评审尚未合并的功能时，让 Agent 安装对应 `--ref`。

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

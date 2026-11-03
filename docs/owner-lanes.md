# 单一 captain 与临时 owner lanes

人始终只面对一个 captain。每个独立需求由临时 **owner** 持有一个 lane；owner 协调 scout、worker、独立 verifier，把结论与证据交回 inbox/packet。Captain 接收新需求、安排容量、压缩决策清单。仓库阅读、代码调查、测试、Git 操作交给下游角色。本 CLI 不提供常驻花名册、后台 owner 调度器或工人运行时。

## 先建立身份边界

由可信操作员为共享状态根初始化：

```sh
crewvane authority init --human human-session --captain captain-session --root /state
```

宿主根据已认证会话绑定 `CREWVANE_ACTOR`，模型不能自行选择 actor、改写 policy/limits 或绕开 hook。人类批准处理器必须先得到人的真实决定，再以已登记 human 调用 `contract freeze` / `inbox decide`。Bootstrap 不能替换已登记身份，也不能把已有 owner/worker 注册成人。Policy 只保存公开身份引用和摘要，不保存 token。

**这是应用层守卫，不是 OS 沙箱或密码学认证。** 同一系统用户下能任意写文件、改环境的进程仍能篡改本地记录。可信宿主必须保护身份绑定、policy、批准回执和工具执行，并提供自己的权限/沙箱。让 agent 在 shell 自填环境变量不构成人类认证。未接入可信身份的宿主可以试用旧单 lane 流程，但不能声称已实现人类身份校验。

兼容规则：旧 `intake --text ...`、没有 Lane 的合同仍使用 `default` 和原来的无后缀指针。命名 lane 派发前必须初始化 authority。未配置 authority 时保留明确授权的旧 `--direct`；配置后必须走草稿与 human freeze，不能自签。真正执行 `notify run` 始终需要已登记 captain；dry-run 和被策略拒绝的计划仍然只读。

## 队列、认领与独立方案

```sh
crewvane intake add --id request-A --text 'Request A' --project app --by human-session --channel chat
crewvane intake add --id request-B --text 'Request B' --project app --by im-adapter --channel im
crewvane intake list --state open
crewvane intake claim request-A --by owner-A --lane A
crewvane intake claim request-B --by owner-B --lane B
crewvane status --brief
crewvane status decisions
```

Chat/IM/CI 等入口只追加队列，不替 captain 回复，也不冻结、派发或验收。`.crewvane/intake.jsonl` 在状态锁下追加，状态为 `open → claimed → done|dropped`。相同 id/内容重试幂等，内容冲突或竞争认领失败。Captain 分配临时 owner；每个 owner ref 仅用于一个 lane，需求关闭后退役。实际会话由编排器创建/停止，认领记录不证明 owner 已运行。

认领生成带 `Lane`、`Owner` 的草稿。后续方案使用 `intake --lane A --owner owner-A --id <new-id> --text ...`。**每个 lane 只有一个当前方案**：`active-proposal.A` 和 `active-proposal.B` 各自维护；默认 lane 仍用 `active-proposal`。B 的新草稿不淘汰 A。执行 checkout 的 `active-lane` 为提交 hook 选择 `active-contract.<lane>`；`guard --lane A --contract ... --repo ...` 只比较 A 的方案。不同 lane 必须使用独立执行 checkout。

从 `templates/contract-card.md` 准备 `Status: draft`，保留方案的 Lane/Owner/id、路径和验收。只有登记的人类通道调用：

```sh
crewvane contract freeze --contract contract-A --by human-session --accepted-text 'Exact accepted plan'
```

CLI 检查认领归属、路径、切片、角色，记录人/时间和整个合同的批准摘要。Owner 自填 `Accepted by`/`Frozen by`、未登记姓名、缺回执或冻结后修改都不能通过检查。冻结后文件不可修改，包括 dispatch-log 表；状态追加到事件流。变更应新建合同 id。人可用 `limits set --global-max-parallel 3 --by human-session` 调整上限；直接改文件会破坏批准指纹。派发和恢复都检查跨 lane 全局并发，默认 3。

## 确定性准备与真实派发分开

```sh
crewvane slice open --contract contract-A --slice code --lane A --worker worker-A \
  --source-task-id task-A --repo /worktrees/A --branch ship/contract-A/code \
  --title 'Request A' --summary 'Execute the approved slice.'
```

`slice open` 先只读预检，再创建/复用明确的 Git worktree、安装共享状态 hook、保留并发名额、创建待核验 packet、运行路径检查。准备后在状态锁内再次检查准入，避免竞争超发。返回 `spawn_required: true`，适配器仍须使用返回的 role/context 启动真实 worker，并记录真实运行时引用。它不声称工人已执行或 verifier 已验收。准入后准备失败将标记 failed，保留 checkout 供排查；不会 reset 已有 checkout。已准备好的仓库仍可用 `slice start`。

派发前 owner 提供 scout 卡：**结论、影响路径、验收命令、风险/待决定事项、证据指针**。Scout 可在冻结前只读调查。容量、宿主能否启动工人、watchdog 健康是不同的准入条件。

## 可移植角色卡

内置 `owner`、`scout`、`generic-worker`、`verifier`。项目在 `.agents/team/roles/<id>.md` 覆盖/新增，或用 `crewvane.team.json` 的 `roles` 配置目录。`role list`、`role show <id>`、`team context --role <id>` 只读查看。卡片使用扁平 YAML 标量/列表；未知字段、runtime/model、非法 frontmatter、文件名/id 不符都失败。

```yaml
---
id: fullstack-dev
purpose: Implement an approved application slice
may_see: [contract_slice, acceptance, repo, branch, hard_rules, lessons]
default_allowed_paths: []
forbidden_paths: [.env*, production/**]
must_produce:
  - command + exit code
  - evidence pointer
  - acceptance matrix
lesson_tags: [fullstack]
out_of_scope: [merge, deploy, freeze_contract, decide_inbox]
---
Return evidence to this lane's owner. Do not contact the human.
```

Slices 表的可选 `role` 列缺省/空白时使用 `generic-worker`。派发校验选中卡片，返回正文、能力字段、来源、经验标签和有界上下文；事件保存 `lane_id`、`owner_ref`、`role_id` 与来源摘要。角色禁止路径与合同禁止路径取并集。`default_allowed_paths` 只是起草建议，不能扩大冻结范围。`may_see`、`out_of_scope` 是适配器应落实的能力约定，不是文件 ACL。角色卡不含会话历史、凭据或活跃实例状态；实例按需生成，任务结束后退役。

## Captain 响应预算与可执行 hook

每轮经过认证的人类对话开始时，由**宿主在模型工具之外**调用 `captain heartbeat [--busy-until <future-ISO>]`。忙碌时间到期自动恢复可用。Hook 将 captain 每轮限制为 12 次工具调用 / 120 秒；heartbeat 故意不在模型命令白名单里，防止自己重置预算。预算用尽应交回简短决策清单，把调查委托下去。

`scripts/host-pre-tool.mjs --root /state [--repo /checkout]` 从 stdin 读取标准化 JSON，允许退出 0，拒绝/故障退出 2：

```json
{"tool":"shell","argv":["crewvane","intake","list"]}
```

文件事件为 `{"tool":"read","path":"..."}` 或 `{"tool":"write","path":"...","content":"..."}`。`guard tool --input -`、`guard command --argv '["git","diff"]'` 也调用同一守卫。宿主必须把原生工具格式转换为直接 argv/路径、非零即阻断、调用可信安装的 runner，不能执行 shell 字符串/eval。工人执行仍需要宿主沙箱。**此通用 hook 不会自动安装到所有宿主，也不声称原生 payload 可直接通用。**

Captain 白名单允许队列/status/context/role 路由、确定性 slice 准备、inbox 创建/查看、检查和通知；拒绝仓库 Git/测试/构建/源码阅读、受保护写入和伪装 CLI 路径。Owner 只写自己的 lane 工件/inbox；worker 文件工具只写其记录的活跃 checkout 和合同/角色允许路径；scout/verifier 只读。只有 captain 真正发通知，只有 human 冻结/决策/改 limits。通过 hook 的 CLI 调用仍须通过子命令本身的 lane/批准校验。Captain 的通知必须使用状态根受保护的 `.crewvane/notify.policy.md` 和 `notify.allowlist.json`，不能把 packet 伪装成执行策略或换用自制 allowlist；这些文件由可信操作员维护。

## 状态、决策与只停 B

`status --brief` 显示 captain 可用性，以及每 lane 的 owner、阶段、空闲分钟、待处理数。`pending_human` 严格等于 **未认领 intake + 没有匹配冻结合同的 draft proposal + open inbox**。这是待处理记录数，同一个需求可贡献多个记录；关闭需求的草稿不再计入。`status decisions` 最多返回 20 项和省略数量。Captain 将其改写为**结论 / 取舍 / 证据 / 建议 / id**，不粘贴 owner 长对话；原始 lane 卡片、inbox 证据仍可查。

收到“B 先停”，用 `inbox list --lane B --json` 定位 B 的 owner/task，先让适配器停掉真实运行时，再 `slice update --lane B --source-task-id <B-task> --status cancelled`。CLI 校验 task 所属 lane 并拒绝 owner 跨 lane 操作；CLI 自己不杀进程。收齐活跃工人后用 `intake update request-B --state dropped` 关闭需求，A 保持原状态。只有 human 通道可 `inbox decide <id> ... --lane B`。

Worker 向 owner 交证据，独立 verifier 不读工人对话重新核验，owner 通过 inbox 交简短 packet，captain 统一面向人。没有自动冻结、最终验收、merge、deploy 或跨 lane 停工。

# 团队手册与受控经验回流

这套流程适用于单仓库、Monorepo 和多个独立仓库。工具提供流程、模板和本地 CLI；
团队继续拥有规范、项目规则、验证方式与经验资料。它不要求某个特定的工作空间、知识平台或编排器。

## Setup 的行为

```sh
agent-ship setup
agent-ship setup --shared
```

普通 setup 只在 `.agent-ship/team.json` 建立本地引用，不创建共享手册或修改已有资料。
`--shared` 会创建可版本管理的 `agent-ship.team.json`，并在没有手册时创建
`docs/agent-team/handbook.md`。默认经验目录只放说明索引，不预填“经验”。

已有配置优先；没有配置时依次发现默认手册、`TEAM.md`、`docs/TEAM.md`、`docs/team/handbook.md`。
也可明确引用已有来源：

```sh
agent-ship setup --shared --handbook docs/engineering/team.md --lessons docs/engineering/lessons
```

显式手册必须已经存在。重复 setup 不覆盖手册、配置或经验；配置存在时传入不同来源会报冲突，
交由维护者明确修改配置。升级工具也不自动重写团队约定。卸载/清除运行数据保留版本管理中的手册和经验。
规则入口只增加通用使用要求，正文通过配置引用；项目已有权威规则仍优先。

默认共享配置：

```json
{
  "version": 1,
  "handbook": "docs/agent-team/handbook.md",
  "rules": [],
  "lessons": "docs/agent-team/lessons",
  "learning_required": true,
  "max_lessons": 3,
  "summary_chars": 1200
}
```

`rules` 可引用项目已有的 Markdown 规范。当前执行仓库的 `AGENTS.md` 也会进入必读引用。
受管团队的 learning_required 固定为 true，不能通过配置悄悄跳过交付检查；没有新发现时使用 none。
`handbook` 可为 null，供只做本地接入、尚未采用共享手册的团队使用。
共享状态根目录和执行仓库都可以提供规范；全局经验来源由共享状态根目录的配置指定。

本版支持本地路径。外部目录可以被显式引用和读取；CLI 不向项目外写入或复制资料，
外部知识源的修订使用该来源所有者原有的工作流。经验目录使用结构化 JSON 索引卡，
卡中的 evidence 可引用已有文档、报告或 PR，不要求复制原文。

## 开工时：检索不等于加载全部资料

```sh
agent-ship team context --tag git --tag parallel --project api-service
```

输出必读规范的路径、相关 active 经验的短摘要、需要复核的编号和预算信息。
它不展开手册正文或全部历史。标签由船长按任务选择；没有标签或没有可靠匹配时返回零条经验。
带 project 的经验只匹配同一个项目标识，团队通用经验可以跨项目匹配。
当前检索是确定性的标签匹配，不调用模型或外部检索服务。

默认最多 3 条摘要，摘要 JSON 合计不超过 1200 字符（不是 token 计数），可在配置中调整。
必读项目规则不受经验预算裁剪。候选、退役条目不进入摘要；过期或 needs_review 条目只提示编号，
不能直接作为执行要求。需要更多细节时显式展开一条：

```sh
agent-ship lesson show --id isolated-repositories
```

`slice start` 支持相同的 `--tag`、`--project`，返回工人应加载的 context。
派工事件记录 required source 引用、标签、项目标识和采用的经验编号，便于检查“经验是否曾被检索到”。
工人仍需要实际读取适用规范，并判断经验的条件是否符合当前版本；路径回执不证明模型已经理解内容。
经验不能扩大合同范围或授予新的操作权限；与权威规则冲突时报告具体条款，暂停受影响工作。

## 收尾时：每次检查，按需形成候选

完成独立代码核验后，核验者返回经验影响结论，船长负责记录：

```sh
agent-ship lesson check --source-task-id task_upload \
  --outcome none --reason '常规改动，已有规范和测试已覆盖，没有新的复用结论。' \
  --reviewed-by verifier_run_123
```

none 只追加一条运行审计事件，不创建经验文件，也不默认通知用户。
用户纠正、核验退回、问题复发、发现重要约束时，先在任务内保留短线索，根因确认后再分类。
`--trigger` 可记录 user_correction、verifier_return、recurrence、scope_discovery；人的退回修改会自动补充纠正信号。

准入条件：可复用、适用边界明确、有具体动作、有可靠证据、现有资料尚未充分覆盖。
普通流水账、一次性故障和未经证实的猜测留在任务中。

候选示例在 `templates/lesson.example.json`，先替换证据和任务占位符，再执行：

```sh
agent-ship lesson add --input /path/to/verified-finding.json
agent-ship lesson check --source-task-id task_upload \
  --outcome candidate --candidate-id isolated-repositories \
  --reason '跨仓库验收的遗漏已复现，证据与适用条件完整。' \
  --reviewed-by verifier_run_123 --trigger verifier_return
```

add 校验字段、字数和证据指针，创建 candidate。同条件、动作、项目和标签的精确重复返回已有编号，
保留原文，不再创建卡片；语义相似性仍由核验者判断。现有条目需要补证据或修订时，
使用该来源的正常评审方式，CLI 不自动合并或改写旧经验。

新 setup 后派发的受管任务，会记录 learning_required。进入 `needs_review` 前必须有本轮工作之后的
有效 none/candidate 检查、原因和核验者引用。恢复执行或收到退回修改后，旧回执不能继续用于交付。
该门禁同时用于 inbox add 和 slice update 的 needs_review 状态。已有未受管任务保留原交付约定。

安全停工、failed/cancelled 或人的拒绝不会因为缺少文档而被阻止。船长在收尾时检查遗留项：

```sh
agent-ship lesson pending
agent-ship lesson pending --source-task-id task_upload
```

pending 默认最多返回 20 个任务编号与状态，并报告总量；不会把历史报告全部带入上下文。
检查这些结束任务，补上 none 或有证据的候选，不自动重启工人。

## 候选到活动经验

只有完成来源、适用性、复用价值和语义查重核验后，才能激活：

```sh
agent-ship lesson review --id isolated-repositories --status active \
  --reviewed-by maintainer_review_456 --note '已复跑证据并检查相关条目，适用边界清楚。'
```

可以给出 `--review-after` 指定未来的 ISO 时间；到期后检索只提示复核，不返回执行摘要。
来源版本、配置或实现变化时，维护者标为 needs_review，确认失效则标为 retired。
状态改变保留原结论、证据与来源。团队手册/代码门禁的修订走独立的正常评审，不从候选自动生成新强制规则。

CLI 能校验结构完整性、精确重复、预算和状态，不能证明证据真实、结论新颖或核验者身份。
这些语义责任由独立核验与维护者评审承担。不要用勾选字段代替真实核验。

## 复发时先修已有机制

结合派工中的经验编号检查：是否未检索到、条件写错、动作含糊、未执行，或应由程序防止。
优先改进检索标签、已有经验、测试或门禁。一次复发不直接生成一条新规则。
本地运行日志可以增长，但不会整体注入提示；长期资料只保留筛选后的结论。

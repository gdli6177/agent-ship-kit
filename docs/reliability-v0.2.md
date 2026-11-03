# v0.2：接入、开工、经验与监控闭环

本版本一起处理 #11、#12、#13、#14。开发使用 pnpm workspace 和单一 lock；
面向最终用户的安装器仍只要求 Node.js 20+ 与自带的 npm。

## 接入必须看实际可见性

安装器支持 `--agent cursor|claude|codex|qoder|kiro|omp|agents|all` 和任意 `--target`。
自动探测只覆盖这些已知目录，不代表支持主机上任意 Agent。OMP 使用
`~/.omp/agent/skills`，共享目录为 `~/.agents/skills`。

默认 setup 保留 tracked `AGENTS.md`；规则写在 `.crewvane/AGENTS.local.md` 时，
输出 `rules_auto_loaded: false` 和 warnings。当前会话显式读取该文件；下一会话
需配置宿主加载入口，或在共享 adoption 获授权后使用 `setup --shared`。
CLI 的 required_sources 也包含这份本地规则，但这不能证明宿主模型已经读过。

## 先登记，再在授权范围内执行

```sh
crewvane intake --text '给任务列表增加仅未完成过滤'
crewvane doctor
crewvane guard
```

intake 创建幂等的 draft，保留原始请求；只读调查可以完善方案。没有匹配冻结
合同时 guard 返回非零。setup 安装的 pre-commit 调用同一 guard，不能再无合同
直接提交。共享初始化文件也需要明确范围授权后提交。

普通 CLI 无法阻止宿主直接调用文件写入或运行测试；要拦截每次工具调用，宿主
必须在 pre-tool 边界执行 guard。本版本不把 Git hook 宣称为操作系统沙箱。
新请求不能借用旧 proposal 的 active-contract。

人明确要求直接执行时，可记录一个轻量但完整的冻结范围：

```sh
crewvane intake --direct --id direct_filter --text '完成过滤功能并通过验收' \
  --allowed 'src/tasks/**' --forbidden '.env*' \
  --accepted-by '项目负责人' --accepted-text '明确授权直接完成上述范围'
```

这是人的授权记录，不是模型自行跳过确认的开关；不修改 hard-rules。CLI 无法
认证输入字符串是否真由人提供，宿主仍须保留真实接受来源。

## 纠正可追，经验有界，手册不被自动改写

`correction add` 在派工前也能使用。一次性事实选 event；行为纠偏选 lesson；
领域定义选 handbook。后两者要求显式 project/team、when/action。proposal 追加
resolved_by_human 注记而保留历史，船长必须按注记修订当前风险与问题。

`learning extract` 确定性聚合有证据的事件，只创建 candidate；未知项目返回
deferred，疑似秘密拒绝落盘。它不调用 LLM，不从任意聊天自动推断经验。
新候选只经维护者审核才能 active；单次定义纠正可以进入手册候选队列。

`team context --auto --project ID` 在无标签时也返回有界 active 经验；手册片段
与经验合计遵守 summary_chars。required_sources 保持字符串数组兼容旧调用方，
source_details 增加 read_required 与内容 digest。必读正文不会被摘要替代。

slice start、check、待审输出提供相关经验并记录 lesson_used。注入后仍复发可
降为 needs_review；最近使用时间参与排序，不自动删除或升级硬规则。
`learning review` 要求为未收尾纠正记录 none/candidate；`handbook propose` 只
给可审 diff，写入与合并仍走 owner 流程。

## 定时器注册与运行健康分别检查

```sh
crewvane watchdog status
crewvane watchdog doctor
crewvane watchdog uninstall
```

slice start 在注册失败或已知运行失败时拒绝派工，失败不消耗 task id。显式
`--allow-untimed` 才允许人工监督，并在事件中记录。恢复 running 同样检查。
registered_unverified 表示已注册但尚无成功执行证据，不能报告成已验证健康。

launchd status 读取实际 job 的 runs 与 last exit code；完成回执提供运行与成功
时间。cron 缺少回执时健康为 unknown。超过 15 分钟没有完成记录、CLI/node/tsx
缺失或 plist 与当前安装不一致均可见。备份模板仅成功注册后写入，不作注册证据。
无切片时保持 noop 和已装定时器；离开项目显式 uninstall，避免两次派工间空窗。

## 验证与试用

已完成的系统调度与独立工人/核验者证据见[真实试用记录](testing/v0.2-dogfood.md)。

`scripts/workspace-verify full` 执行类型检查与全部自动测试。
`pnpm test:dogfood` 是显式真实试用：从当前源码打包安装，在临时 Git 项目中
检查 hook、授权、纠正与经验，并通过真实 launchd 和独立 OMP 工人/核验者走完
工作流。它会调用模型并创建临时系统定时任务，结束后卸载定时器，保留临时报告。
它不推送、不合并、不部署、不触碰现有业务项目。Linux cron 用回归测试覆盖，
不把 macOS 的试用结果外推为 Linux 实测。

# 多仓库与 worktree 并行交付

工作空间可以在一个入口管理多项需求，同时保留成员仓库各自的 Git 历史。
`--root` 指向共享状态根目录，保存合同、运行事件、并行预算和收件箱；
`--repo` 指向本次切片实际执行的成员仓库或 worktree。省略 `--repo` 时，单仓库用法保持兼容。

工具仍不启动模型、不创建 worktree、不合并分支，也不发布产品。工人进程由适配器管理。

## 准备工作

以下命令从本工具的 `cli/` 运行。`/work/workspace` 是控制仓库，
`repos/alpha`、`repos/beta` 是两个独立 Git 仓库。

```sh
pnpm install
pnpm agent-ship setup --root /work/workspace
pnpm agent-ship setup --root /work/workspace/repos/alpha --state-root /work/workspace
pnpm agent-ship setup --root /work/workspace/repos/beta --state-root /work/workspace
```

根目录的 hooks 不会传播到独立成员，必须分别安装。默认安装仍保留既有规则和忽略文件；
如果设置了 `core.hooksPath`，安装在写入任何项目文件前返回冲突，交由 hooks 所有者组合，
不会静默安装一组 Git 不执行的 hooks。

`setup` 通过 `git rev-parse --git-path` 定位 hooks，支持 `.git` 为文件的 worktree。
每个 checkout 的 `.agent-ship/state-root` 和 `active-contract` 独立保存。
共享 hooks 保留既有 hook 的串联；卸载一个 checkout 时，如果还有其他已安装 checkout，
保留共享 hooks 和忽略规则。所有 checkout 都卸载后才恢复原 hook。

## 冻结合同与预留并行名额

合同放在共享根目录 `.agent-ship/contracts/<id>.md`，必须记录：

- `Status: frozen`、真实的 `Frozen by`、有效的 `Frozen at` 时间；
- 非空 Allowed paths 和 Forbidden paths；
- Slices 表格中的切片 ID，以及正整数 `max_parallel`（缺省为 3）。

路径相对于实际执行仓库，例如 `src/**`。不要写 `repos/alpha/src/**` 来要求父仓库检查成员。
Git diff 不进入独立仓库，CLI 会拒绝这种跨 Git 边界的路径检查。

先由适配器准备独立 checkout 和分支，选定稳定的任务 ID，再调用 `slice start` **预留名额**。
返回成功后才能启动工人；失败时不得启动。不同进程共享同一状态锁，因此两个并行登记也不能突破预算。

```sh
pnpm agent-ship slice start --root /work/workspace \
  --repo /work/workspace/repos/alpha \
  --contract auth --slice middleware --source-task-id task_auth_middleware \
  --branch ship/auth/middleware --base main \
  --title 'Auth middleware' --summary 'Reserve the frozen middleware slice.'
```

登记会检查冻结状态、切片是否存在、重复任务和切片、合同上限及共享根目录全局上限。
执行 checkout 必须存在，分支必须能解析为提交；`base_ref` 固定为登记时的基线提交 SHA，
不随后续 main 更新漂移。所有成员使用同一 `--root`，才能共用全局并行预算。

随后调用适配器 spawn，使用同一个稳定任务 ID 映射平台 run ID，并记录 worker 引用：

```sh
pnpm agent-ship slice update --root /work/workspace \
  --source-task-id task_auth_middleware --status running --worker platform_run_123 \
  --summary 'Worker started on the prepared checkout.'
```

适配器启动失败时，写 `--status failed` 释放名额。要替换 failed/cancelled 切片，
仍须人授权，然后用新的任务 ID 和 `slice start --replace`。不能重复使用旧任务 ID。
注意：本工具只校验记录和合同字段，不能证明字段背后的人的身份；人工冻结仍由宿主流程负责。

## 同一仓库的多项需求

每条需求使用独立 worktree 和分支，分别执行 setup；把 `--state-root` 都指到同一工作空间。
不要让两个工人在同一个 checkout 里切换分支或共享暂存区。

```sh
git -C /work/workspace/repos/alpha worktree add -b ship/auth/middleware /work/trees/auth main
git -C /work/workspace/repos/alpha worktree add -b ship/billing/webhook /work/trees/billing main
pnpm agent-ship setup --root /work/trees/auth --state-root /work/workspace
pnpm agent-ship setup --root /work/trees/billing --state-root /work/workspace
```

在每个 checkout 的 `.agent-ship/active-contract` 写入它负责的合同 ID，
再按上面的方式登记，并将 `--repo` 指到对应 worktree。pre-commit 会读取该工作树的指针，
从共享根目录加载合同，检查当前工作树的暂存区。

## 核验、收件箱与状态闭环

```sh
pnpm agent-ship check --root /work/workspace --contract auth --slice middleware
pnpm agent-ship watchdog --root /work/workspace
pnpm agent-ship inbox list --root /work/workspace --sort priority
```

`check` 从登记记录确定实际 checkout、分支和固定基线。合同跨多个仓库或分支时，
必须给出 `--slice`，或明确 `--repo` / `--head`，避免检查了错误的分支却显示通过。
尚未登记的单仓库合同仍可用 `check --repo <checkout> --head <branch>` 检查。

watchdog 的提交进展与路径越界检查使用同一条切片的 checkout 和分支。
合同、仓库、基线或分支无法读取时也会生成 blocked，不能按“没有越界”处理。

独立核验通过后，船长使用 `inbox add --type needs_review` 汇总证据。运行视图同时折叠
events 和 inbox，因此待审、阻塞和中途审批都会暂停 running/queued 状态；接受待审包后
不会再把已交付任务判为停滞。相同毫秒写入的本地事件用状态锁内生成的 sequence 排序。

人的 `changes_requested` 不自动重启工人。记录决定后，船长调用
`slice update --status running` 恢复同一任务；恢复也检查冻结合同和两层并行预算。
`accept` 不合并，`reject` 取消任务。`needs_approval` 或 blocked 的接受只表示问题已经决定，
同样要显式恢复。适配器的真实进展与 failed/cancelled 状态通过 `slice update` 回传。

## 工作空间规则的归属

本工具不替代工作空间的上下文解析和验证入口。例如 gd-workspace 的船长仍先运行
`gdw context`，向工人提供根规则、成员规则和相关领域资料；核验时在每个成员独立执行
`gdw verify --member <id>`，再把结果写入统一证据包。不同成员不共享一个提交或合并动作。

## 验证范围

`cli/test/workspace.test.ts` 覆盖跨仓库路由、真实 CLI 进程同时登记、合同与全局上限、
worktree hooks、人工决定后的状态闭环、显式恢复与替换、无法检查时的告警。
测试使用临时 Git 仓库和工人进程夹具，不代表已完成 Herdr/Orca/Multica 的真实模型接入验收。

状态锁在异常退出后可能保留。CLI 会报告锁路径并停止；先检查拥有者进程再手工移除，
不会自动抢占可能仍在使用的锁。共享状态应放在本机文件系统；跨机器/网络文件系统不在本次保证范围。

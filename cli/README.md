# Crewvane CLI

Crewvane 桌面应用在“设置”中安装自包含 CLI，管家和负责人通过它读取目标、写回进展并提交交付。CLI 与桌面使用同一个 `packages/core` 状态服务，不需要单独运行后台服务。

```sh
crewvane --help
crewvane status --json
crewvane attention --json
crewvane workflow list --json
crewvane goal list --json
crewvane goal show <ID> --json
```

指定工作区：

```sh
crewvane goal list --root /path/to/workspace --json
# 或
CREWVANE_WORKSPACE=/path/to/workspace crewvane goal list --json
```

## 写回目标

```sh
crewvane goal progress <ID> --summary "已完成方案" --next "开始实现" --stage build
crewvane goal wait <ID> --reason "等待审批" --owner YR --remind-at 2026-11-05T10:00:00+08:00
crewvane goal decide <ID> --question "是否保留旧接口？" --next "等待你的决定"
crewvane goal review <ID> --summary "功能已实现" \
  --location /path/to/result \
  --check "单元测试::pnpm test::passed::全部通过"
crewvane goal rework <ID> --note "补充边界场景"
crewvane goal accept <ID> --note "已查看实际成果"
crewvane goal resolve <ID> --note "已处理"
crewvane goal drop <ID> --reason "不再需要"
```

`goal review` 至少接受一项真实检查记录，且检查结果必须为 `passed`。验收不会合并代码、部署服务或发送外部消息。

Herdr 现场由 Agent 使用真实 ID 关联：

```sh
crewvane session set <ID> --session "$HERDR_SESSION" --workspace <实际ID> --tab <实际ID> --pane <实际ID> --agent <实际名称>
```

默认输出简洁中文，追加 `--json` 输出结构化记录。所有写入使用工作区锁和原子快照；桌面和 CLI 可以并发操作不同目标。

## 本地构建

```sh
pnpm --dir cli test
pnpm --dir cli typecheck
pnpm --dir cli build
node cli/bin/crewvane.js --help
```

桌面打包会把同一份 CLI bundle 和独立 Node runtime 嵌入应用；发布用户不需要安装 Node，也不需要保持桌面窗口打开。

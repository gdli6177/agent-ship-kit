# 桌面内测交付验收

日期：2026-11-03，macOS arm64，桌面版本 0.3.0。

- 类型检查通过；CLI 122/122、Core 6/6、Orchestrator 18/18。
- 源码桌面冒烟 17/17，包含真实 Shell 输出、OMP 连接、授权、讨论不启动工人、
  CLI/桌面共享任务与取消；无渲染错误。
- 真实多运行时试用：00:39:42–00:43:15 UTC，五个需求全部完成，工人/验证员峰值 3。
  实际运行组合为 OMP `minimax-code-cn/MiniMax-M3.1-Flash`、Codex `group/group`、
  DSH `["magpie","opencode-go/minimax-m3.1-flash"]`；真实文件写入、测试、独立验证、范围检查和宿主提交均执行。
- 深浅主题、四种任务状态、设置、运行时、工序、终端和窄窗口检查见
  [设计验收](../../design-qa.md)与[截图](design-qa/)。
- `pnpm desktop:dist` 生成 DMG（约 145 MB）、ZIP（约 129 MB）与 SHA-256。
  `pnpm test:installers` 检查校验值与磁盘映像，分别从 ZIP 解压、从挂载的 DMG
  复制安装，两份应用均通过启动、版本、渲染隔离、真实 Shell/PTY 输出验收。
- 试装发现并修复：部署收录历史构建导致体积膨胀；复制到 DMG 时重写 Framework
  相对符号链接导致启动失败。现只收录 dist，并保留符号链接原文。
- 错误版本标签被打包脚本拒绝；工作流 YAML 解析通过。GitHub 云端工作流及正式
  发布后的远程下载尚未执行，不能视为已验收；Apple Developer ID 签名与公证尚未完成。

成员 `scripts/workspace-verify fast` 通过。工作区总验证曾被 recovery snapshot 中旧
agent-ship-kit 地址阻断；运行 `gdw sync` 后更新为当前 crewvane 地址，再次验证通过。
控制仓库的快照更新保留在本地，不混入成员提交；其他成员仍有缺少上下文/知识路由/
验证入口的非阻塞警告，未改动它们。

飞书文档覆盖度见[逐项对照](../product/document-coverage.md)。其中缺失能力未计入通过项。

# agent-ship-kit 开发约定

本仓库拥有 CLI、技能、模板与薄适配器；不拥有使用方的团队规则或业务代码。
先读 `CONTEXT.md`、`docs/ARCHITECTURE.md` 和相关技能/测试。使用方执行
`setup` 生成的规则不是开发本工具的执行协议。

- 保留 owner 规则与现有 hook；不得自动合并、部署、发送通知或激活经验。
- 文件写入局限于显式 owner 根目录；外部手册只读，不读取凭据或登录状态。
- 使用 pnpm。验证入口：`scripts/workspace-verify fast|full`。
- 修改 CLI 行为时增加真实调用层的回归测试；修改技能时同步说明和 eval。
- issue 在 https://github.com/gdli6177/agent-ship-kit/issues；领域定义见
  `CONTEXT.md`，架构见 `docs/ARCHITECTURE.md`。
- 新增文档以中文为主，公开命令和协议字段保持英文。

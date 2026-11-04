# Crewvane 消息通知

状态：0.5.0 实现

## 目标

通知模块只把真正需要人处理的注意力变化送到人所在的工作流，不推送普通聊天、Agent 忙碌或过程日志。内置系统通知继续使用；Webhook 是第一个可配置外部渠道。

## 触发边界

以下事项首次进入注意力时发送一次：

- `decision`：需要人决定；
- `review`：成果等待验收；
- `follow_up`：等待事项到达跟进时间；
- `intervention`：会话或审查轮次已经升级到人。

同一注意力不因 10 秒巡检、应用重启或重复渲染再次发送。事项处理完成、转入其他状态或生成新的注意力时间后，下一次注意力使用新的去重键。

## 配置

入口：`设置 → 需要你时，主动通知 → 配置 Webhook`。

配置保存在应用数据目录的 `notification-webhooks.json`，权限为 `0600`。界面不会把已保存的完整 URL 或 Bearer 令牌回传给渲染进程。

- 远程 Webhook 必须使用 HTTPS；
- `localhost`、`127.0.0.1` 和 `::1` 可使用 HTTP，便于本机自动化；
- 可选 Bearer 令牌通过 `Authorization: Bearer …` 发送；
- 地址和令牌都有长度与控制字符校验。

## 请求

Crewvane 使用 `POST`，`Content-Type: application/json`，并发送：

- `X-Crewvane-Event: attention.required`
- `X-Crewvane-Delivery: <stable-delivery-id>`
- `User-Agent: Crewvane/<version>`
- 配置令牌时发送 `Authorization`

示例：

```json
{
  "schema": "crewvane.notification.v1",
  "event": "attention.required",
  "deliveryId": "sha256:…",
  "occurredAt": "2026-11-04T10:15:00.000Z",
  "workspace": {
    "name": "产品工作区"
  },
  "app": {
    "name": "Crewvane",
    "version": "0.5.0"
  },
  "goal": {
    "id": "goal_…",
    "title": "确认年度价格",
    "status": "review",
    "next": "选择方案 A 或 B",
    "kind": "review",
    "summary": "定价负责人提交了两档方案"
  },
  "action": {
    "type": "open-goal",
    "goalId": "goal_…"
  }
}
```

`goal` 内可能附带 `waitingFor` 或 `remindAt`。通知不包含聊天历史、附件内容、本机路径或 Agent 凭据。

## 投递与重试

只有 HTTP 2xx 才算送达。成功记录和失败退避记录保存在应用数据目录，最多保留 90 天和 500 条：

- 成功事件跨重启去重；
- 失败后 5 分钟再试，避免每 10 秒巡检反复请求；
- 更换 Webhook 地址会形成新的投递目标；
- “测试当前配置”发送独立的 `notification.test`，不写入注意力去重账本；
- Webhook 失败不会回滚目标状态，也不会阻止系统通知、收件箱和人工操作。

通知依赖 Crewvane 主进程运行。关闭窗口只会隐藏应用，菜单栏进程仍会继续同步；显式“退出 Crewvane”后不会在后台投递。

## 模块边界

`apps/desktop/electron/webhook-notifications.ts` 负责配置校验、请求构造、持久化去重、超时和退避。它接收 core 的只读 `Goal` 与 `AttentionKind`，不修改目标状态，也不读取其他目标。

后续飞书、企业微信、Slack 或邮件渠道应复用同一份“注意力事件 → 路由 → 渠道适配器 → 投递结果”协议。渠道失败只影响该渠道；目标、消息、等待和验收仍由 core 保存。

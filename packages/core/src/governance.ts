import type {
  DecisionOutcome,
  DecisionRecord,
  HighRiskCategory,
  ProjectPolicy,
  ShipPolicy,
  WorkspaceState,
} from "./types.js";
import { defaultProjectPolicy } from "./model.js";

export const HIGH_RISK_CATEGORIES = [
  "delete-data",
  "stop-service",
  "spend-money",
  "external-message",
  "product-direction",
  "create-secret",
  "rotate-secret",
  "change-permissions",
  "change-ship-policy",
] as const satisfies readonly HighRiskCategory[];

const riskLabels: Record<HighRiskCategory, string> = {
  "delete-data": "删除数据或文件",
  "stop-service": "停止服务",
  "spend-money": "花钱或产生费用",
  "external-message": "向外部人员发送消息",
  "product-direction": "改变产品方向",
  "create-secret": "新建密钥或凭据",
  "rotate-secret": "轮换密钥或凭据",
  "change-permissions": "修改权限",
  "change-ship-policy": "修改项目上线策略",
};

const riskPatterns: Array<[HighRiskCategory, RegExp]> = [
  ["delete-data", /(?:删除|清空|销毁).{0,24}(?:数据|数据库|文件|目录)|drop\s+table|rm\s+-rf|delete.{0,20}(?:data|database|file)/i],
  ["stop-service", /(?:停止|停掉|下线|关闭).{0,20}(?:服务|服务器|生产环境)|stop.{0,20}(?:service|server)|shut\s*down/i],
  ["spend-money", /(?:花钱|付款|付费|购买|采购|产生费用|扣费)|spend|purchase|pay.{0,20}(?:money|fee)|charge/i],
  ["external-message", /(?:发送|发出|发布|通知|回复).{0,24}(?:客户|用户|外部|邮件|消息|朋友圈|公众号|社交)|send.{0,20}(?:email|message)|post.{0,20}publicly/i],
  ["product-direction", /(?:改变|调整|转向).{0,20}(?:产品方向|产品定位|核心范围)|change.{0,20}product.{0,20}direction/i],
  ["create-secret", /(?:新建|创建|生成).{0,20}(?:密钥|凭据|token|secret|password)|create.{0,20}(?:key|token|secret|credential)/i],
  ["rotate-secret", /(?:轮换|重置|更换).{0,20}(?:密钥|凭据|token|secret|password)|rotate.{0,20}(?:key|token|secret|credential)/i],
  ["change-permissions", /(?:修改|调整|提升|降低).{0,20}(?:权限|角色|访问控制)|change.{0,20}(?:permission|role|access)/i],
  ["change-ship-policy", /(?:修改|调整|更改).{0,20}(?:上线策略|发布策略|ship\s*policy)|change.{0,20}ship.{0,10}policy/i],
];

export function normalizeDecisionKey(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function isShipPolicy(value: unknown): value is ShipPolicy {
  return value === "auto" || value === "auto-merge-manual-deploy" || value === "external-approval";
}

export function isHighRiskCategory(value: unknown): value is HighRiskCategory {
  return HIGH_RISK_CATEGORIES.includes(value as HighRiskCategory);
}

export function riskCategoryForText(value: string): HighRiskCategory | undefined {
  return riskPatterns.find(([, pattern]) => pattern.test(value))?.[0];
}

export function riskSummary(category: HighRiskCategory, summary: string) {
  return `高风险动作必须由你确认：${riskLabels[category]}。${summary}`;
}

export function projectPolicy(state: WorkspaceState, projectId: string): ProjectPolicy {
  return state.projects.find(project => project.id === projectId)?.policy ?? defaultProjectPolicy();
}

export function latestDecision(
  state: WorkspaceState,
  projectId: string,
  actionKey: string,
): DecisionRecord | undefined {
  const normalized = normalizeDecisionKey(actionKey);
  return [...state.decisions].reverse().find(record =>
    record.projectId === projectId &&
    normalizeDecisionKey(record.actionKey) === normalized);
}

export function outcomeLabel(outcome: DecisionOutcome) {
  return outcome === "approved" ? "批准" : "拒绝";
}

export function decisionMarkdown(records: DecisionRecord[], outcome: DecisionOutcome) {
  const title = outcome === "approved" ? "批准决定账本" : "拒绝决定账本";
  const body = records.filter(record => record.outcome === outcome).map(record => [
    `- 日期：${record.decidedAt}`,
    `  - 项目：${record.projectId}`,
    `  - 动作键：${record.actionKey}`,
    `  - 原话：${record.quote}`,
    `  - 来源：${record.source}`,
    ...(record.goalId ? [`  - 目标：${record.goalId}`] : []),
  ].join("\n"));
  return `# ${title}\n\n${body.length ? body.join("\n\n") : "暂无记录。"}\n`;
}

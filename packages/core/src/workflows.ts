import type { Workflow } from "./types.js";
export const defaultWorkflows = (): Workflow[] => [
  { id: "feature", name: "功能开发", steps: [
    { id: "discover", name: "理解与方案", prompt: "先读项目规则，理解目标、现状和约束。信息足够时直接制定并执行方案，不因常规选择反复向人确认。" },
    { id: "build", name: "实现", prompt: "按方案完成实际改动，保持范围聚焦。需要分工时通过 Herdr 协调；遇到问题先自行解决，再交给管家。" },
    { id: "verify", name: "验证与交付", prompt: "只读核对实现并运行相关检查，只报告会导致错误的问题，不报风格建议。同一审查最多三轮；需要第四轮时交给人决定。记录真实命令与结果，交付实际成果、可查看的位置和证据，再提交给人验收。" },
  ] },
  { id: "bugfix", name: "缺陷修复", steps: [
    { id: "reproduce", name: "定位", prompt: "先稳定复现并缩小原因，保留可验证的证据。不要只凭猜测修改。" },
    { id: "fix", name: "修复与回归", prompt: "完成最小范围修复并运行相关回归验证，向管家汇报真实结果。" },
  ] },
  { id: "personal", name: "个人事项", steps: [{ id: "next", name: "下一步", prompt: "明确这一件事的下一步和需要等待的对象。到了该跟进的时候提醒我。" }] },
];

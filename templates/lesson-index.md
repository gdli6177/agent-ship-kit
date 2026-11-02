# 团队经验

本目录保存可版本管理的结构化经验卡，不保存任务流水账。每个 `<id>.json` 对应一个结论。
`lesson add --input <file>` 检查字段并创建 candidate；`lesson review` 记录评审结果。
只有 active 且未到复核日期的匹配经验进入默认摘要；空查询不加载经验。

经验卡字段：id、title、summary、when、action、tags、可选 project、evidence、source_task_id、reuse_reason。
证据只放可追溯指针，不能包含密钥、cookie、登录态或私密导出。
相同根因先检索并查重。语义相近条目由核验者判断，不自动合并或覆盖。

活动经验需要 reviewed_by 和 review_note。来源变化后标为 needs_review；不再适用时标为 retired。
状态转换保留结论、证据和来源。团队原有资料的所有权与评审流程继续有效。

`auto/` 存放尚未晋升的自动候选。检索不把这些卡片当作执行摘要。
同一结论跨第二个不同需求出现时，卡片标上 `handbook_review_suggested`；
用 `lesson pending --handbook` 查看队列。工具不自动改写手册或规则。
维护者用 `lesson review --status active` 评审通过后，卡片才移出 `auto/`。

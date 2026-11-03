export const statusText: Record<string, string> = {
  queued: "排队中",
  planning: "安排中",
  running: "执行中",
  waiting_human: "等待你决定",
  needs_reconcile: "需要核对",
  failed: "执行失败",
  cancelled: "已停止",
  completed: "已交付",
  missing: "未发现",
  detected: "待连接测试",
  ready: "可调度",
  unavailable: "连接异常",
  discovery_only: "仅发现",
  reserved: "准备中",
};

export const shortTime = (at: string) =>
  new Date(at).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export const relativeTime = (at: string) => {
  const delta = Date.now() - Date.parse(at);
  if (!Number.isFinite(delta) || delta < 0) return shortTime(at);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return shortTime(at);
};

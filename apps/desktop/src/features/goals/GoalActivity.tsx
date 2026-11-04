import {
  ImagePlus,
  MessageCircle,
} from "lucide-react";
import type {
  Goal,
  GoalAttachment,
} from "../../../../../packages/core/src/types.js";
import {
  activityKindLabel,
  time,
} from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";

export function GoalActivityFeed({
  goal,
  excludeId,
  service,
}: {
  goal: Goal;
  excludeId?: string;
  service: GoalDetailService;
}) {
  const activities = goal.activities.filter((item) => item.id !== excludeId);
  return (
    <section className="conversation" aria-label="当前目标的消息历史">
      <div className="conversation-feed">
        {activities.length ? (
          activities.map((item) => {
            const mine = item.actor.startsWith("你");
            const system = item.actor === "系统" || item.actor === "巡检";
            const attachments = (item.attachmentIds ?? [])
              .map((id) => goal.attachments?.find((attachment) => attachment.id === id))
              .filter((attachment): attachment is GoalAttachment => Boolean(attachment));
            return (
              <article
                className={`conversation-entry ${mine ? "mine" : system ? "system" : ""}`}
                key={item.id}
              >
                <header>
                  <strong>{item.actor}</strong>
                  <span>{activityKindLabel[item.kind]}</span>
                  <time>{time(item.at)}</time>
                </header>
                <p>{item.text}</p>
                {!!attachments.length && (
                  <div className="history-attachments">
                    {attachments.map((attachment) => (
                      <button
                        key={attachment.id}
                        type="button"
                        onClick={() => void service.openAttachment(goal.id, attachment.id)}
                      >
                        <ImagePlus size={12} />
                        {attachment.name}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            );
          })
        ) : (
          <p className="history-empty">没有更早的消息。</p>
        )}
      </div>
    </section>
  );
}

export function GoalHistory({
  goal,
  latestId,
  service,
}: {
  goal: Goal;
  latestId?: string;
  service: GoalDetailService;
}) {
  return (
    <details className="goal-history">
      <summary>
        <MessageCircle size={14} />
        <span>目标消息与交接记录</span>
        <small>{Math.max(0, goal.activities.length - 1)} 条</small>
      </summary>
      <GoalActivityFeed goal={goal} excludeId={latestId} service={service} />
    </details>
  );
}

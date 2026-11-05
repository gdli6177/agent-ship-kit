import { useState } from "react";
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
  excludeIds = [],
  service,
}: {
  goal: Goal;
  excludeIds?: string[];
  service: GoalDetailService;
}) {
  const excluded = new Set(excludeIds);
  const activities = [...goal.activities]
    .filter((item) => !excluded.has(item.id))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return (
    <section className="conversation" aria-label="当前目标的消息与交接记录，最新在上">
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
  latestIds = [],
  service,
}: {
  goal: Goal;
  latestIds?: string[];
  service: GoalDetailService;
}) {
  const [open, setOpen] = useState(true);
  const count = goal.activities.filter(activity => !latestIds.includes(activity.id)).length;
  return (
    <details
      className="goal-history"
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary>
        <MessageCircle size={14} />
        <span>消息与交接记录</span>
        <small>{count} 条 · 最新在上</small>
      </summary>
      <GoalActivityFeed goal={goal} excludeIds={latestIds} service={service} />
    </details>
  );
}

import {
  ChevronDown,
  ImagePlus,
  MessageCircle,
} from "lucide-react";
import type {
  Goal,
  GoalAttachment,
} from "../../../../../packages/core/src/types.js";
import {
  activityKindLabel,
  goalConversationActivities,
  goalSystemActivities,
  time,
} from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";

export function GoalActivityFeed({
  goal,
  excludeIds = [],
  activities: suppliedActivities,
  service,
}: {
  goal: Goal;
  excludeIds?: string[];
  activities?: Goal["activities"];
  service: GoalDetailService;
}) {
  const excluded = new Set(excludeIds);
  const activities = [...(suppliedActivities ?? goal.activities)]
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
  const conversation = goalConversationActivities(goal, latestIds);
  const system = goalSystemActivities(goal);
  return (
    <section className="goal-history" aria-label="对话与交接">
      <header>
        <MessageCircle size={14} />
        <div>
          <strong>对话与交接</strong>
          <small>{conversation.length} 条 · 最新在上</small>
        </div>
      </header>
      <GoalActivityFeed
        goal={goal}
        excludeIds={latestIds}
        activities={conversation}
        service={service}
      />
      {system.length > 0 && (
        <details className="goal-system-events">
          <summary>
            系统记录 {system.length} 条
            <ChevronDown size={13} />
          </summary>
          <GoalActivityFeed
            goal={goal}
            activities={system}
            service={service}
          />
        </details>
      )}
    </section>
  );
}

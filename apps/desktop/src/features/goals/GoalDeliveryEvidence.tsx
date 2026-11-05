import { ArrowUpRight, Check } from "lucide-react";
import type { Goal } from "../../../../../packages/core/src/types.js";
import { time } from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";

export function GoalDeliveryEvidence({ goal, service }: {
  goal: Goal;
  service: GoalDetailService;
}) {
  if (!goal.delivery) return null;
  const delivery = goal.delivery;
  return (
    <section className="delivery goal-delivery" aria-label="交付与证据">
      <div className="section-heading">
        <div>
          <small className="goal-section-kicker">交付</small>
          <h3>成果与证据</h3>
        </div>
        <small>{time(delivery.submittedAt)} · {delivery.submittedBy}</small>
      </div>
      <p className="delivery-summary">{delivery.summary}</p>
      {delivery.location && delivery.location !== delivery.url && <code>{delivery.location}</code>}
      {delivery.url && (
        <button type="button" className="text-link" onClick={() => void service.openUrl(delivery.url!)}>
          打开交付链接
          <ArrowUpRight size={13} />
        </button>
      )}
      <div className="checks">
        {delivery.checks.length ? delivery.checks.map((check, index) => (
          <div key={`${check.name}-${index}`}>
            <Check size={14} />
            <div>
              <strong>{check.name}</strong>
              <code>{check.command}</code>
              {check.note && <span>{check.note}</span>}
            </div>
            <small className={check.result}>{check.result}</small>
          </div>
        )) : <p className="checks-empty">没有附加检查记录。</p>}
      </div>
    </section>
  );
}

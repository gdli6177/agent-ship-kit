import { useState } from "react";
import {
  Bot,
  Check,
  CircleAlert,
  Clock3,
  SquareTerminal,
  UserRound,
} from "lucide-react";
import type { CrewvaneCommand, Goal } from "../../../../../packages/core/src/types.js";
import {
  GoalReplyComposer,
  type GoalReplyMode,
} from "./GoalReplyComposer.js";
import type { GoalPresentation } from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";

export function GoalActionDock({
  goal,
  view,
  service,
  busy,
  error,
  replyMode,
  setReplyMode,
  notify,
}: {
  goal: Goal;
  view: GoalPresentation;
  service: GoalDetailService;
  busy: boolean;
  error: string;
  replyMode: GoalReplyMode | null;
  setReplyMode: (mode: GoalReplyMode | null) => void;
  notify: (text: string) => void;
}) {
  const [decisionText, setDecisionText] = useState("");

  async function act(command: CrewvaneCommand, receipt?: string) {
    try {
      await service.command(command);
      if (receipt) notify(receipt);
      return true;
    } catch {
      return false;
    }
  }

  if (replyMode) {
    return (
      <GoalReplyComposer
        goal={goal}
        mode={replyMode}
        busy={busy}
        error={error}
        service={service}
        onClose={() => setReplyMode(null)}
        onComplete={(receipt) => {
          setReplyMode(null);
          notify(receipt);
        }}
      />
    );
  }

  if (view.needsDecision) {
    return (
      <form
        className="goal-decision-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await act(
              {
                type: "goal.resolve",
                goalId: goal.id,
                note: decisionText,
                actor: "你",
                outcome: "approved",
                source: "desktop",
              },
              "已记入批准账本，正在通知管家",
            )
          ) {
            setDecisionText("");
          }
        }}
      >
        <div className="goal-action-copy">
          <span>记录你的决定</span>
          <strong>写下你的原话；批准或拒绝都会记入决定账本。</strong>
        </div>
        <textarea
          aria-label="你的决定"
          value={decisionText}
          onChange={(event) => setDecisionText(event.target.value)}
          placeholder="写下你的原话；批准或拒绝都会进入决定账本。"
        />
        <div className="goal-action-buttons">
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("message")}
          >
            补充意见
          </button>
          <button
            type="button"
            className="secondary danger-action"
            disabled={busy || !decisionText.trim()}
            onClick={() =>
              void act(
                {
                  type: "goal.resolve",
                  goalId: goal.id,
                  note: decisionText,
                  actor: "你",
                  outcome: "rejected",
                  source: "desktop",
                },
                "已记入拒绝账本，正在通知管家",
              )
            }
          >
            拒绝
          </button>
          <button className="primary" disabled={busy || !decisionText.trim()}>
            批准并继续
          </button>
        </div>
      </form>
    );
  }

  if (goal.status === "review") {
    return (
      <div className="goal-decision-row">
        <div className="goal-action-copy">
          <span>明确验收</span>
          <strong>通过后目标结束；需要修改就退回并说明。</strong>
        </div>
        <div className="goal-action-buttons">
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("message")}
          >
            问管家
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("return")}
          >
            退回修改
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              void act(
                {
                  type: "goal.accept",
                  goalId: goal.id,
                  note: "已查看成果与检查记录，验收通过。",
                },
                "验收完成，这件事可以放下了",
              )
            }
          >
            <Check size={15} />
            验收通过
          </button>
        </div>
      </div>
    );
  }

  if (view.dispatchFailed) {
    return (
      <div className="goal-quiet-row blocked">
        <span>
          <CircleAlert size={18} />
        </span>
        <div>
          <strong>还没有联系上管家</strong>
          <small>目标已经安全保存，恢复连接后可以直接重试。</small>
        </div>
        <div className="goal-action-buttons">
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("message")}
          >
            先留言
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={async () => {
              try {
                await service.retryDispatch(goal.id);
                notify("正在重新联系管家");
              } catch {
                // The application-level command surface reports the real error.
              }
            }}
          >
            重试联系管家
          </button>
        </div>
      </div>
    );
  }

  if (view.needsIntervention) {
    return (
      <div className="goal-quiet-row blocked">
        <span>
          <CircleAlert size={18} />
        </span>
        <div>
          <strong>负责人现场需要你处理</strong>
          <small>{goal.attention?.summary || goal.next}</small>
        </div>
        <div className="goal-action-buttons">
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("message")}
          >
            告诉管家
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void service.openHerdr(goal.id)}
          >
            <SquareTerminal size={15} />
            {goal.herdr ? "打开工作现场" : "找管家"}
          </button>
        </div>
      </div>
    );
  }

  if (view.dueFollowUp) {
    return (
      <div className="goal-followup-dock waiting">
        <div className="goal-followup-heading">
          <Clock3 size={18} />
          <div>
            <span>到点跟进</span>
            <strong>
              {goal.waitingFor
                ? `仍在等 ${goal.waitingFor}，还是已经有结果？`
                : "等待有结果了吗？"}
            </strong>
          </div>
        </div>
        <div className="goal-action-buttons">
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("message")}
          >
            补充情况
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || goal.dispatch?.status === "pending"}
            onClick={() =>
              void act(
                { type: "goal.followup", goalId: goal.id },
                "跟进请求已交给管家，目标仍保持等待",
              )
            }
          >
            让管家跟进
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("resume")}
          >
            有结果，继续推进
          </button>
          <button
            type="button"
            className="quiet-action"
            disabled={busy}
            onClick={() =>
              void act(
                {
                  type: "goal.remind",
                  goalId: goal.id,
                  at: new Date(Date.now() + 3_600_000).toISOString(),
                  note: goal.next,
                },
                "1 小时后再提醒你",
              )
            }
          >
            1 小时后再提醒
          </button>
        </div>
      </div>
    );
  }

  if (goal.status === "waiting") {
    return (
      <div className="goal-quiet-row waiting">
        <span>
          <Clock3 size={18} />
        </span>
        <div>
          <strong>现在不用处理</strong>
          <small>
            {goal.waitingFor ? `正在等待 ${goal.waitingFor}。` : "正在等待外部结果。"}
            {goal.next ? ` ${goal.next}` : ""}
          </small>
        </div>
        <div className="goal-action-buttons">
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("message")}
          >
            补充情况
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || goal.dispatch?.status === "pending"}
            onClick={() =>
              void act(
                { type: "goal.followup", goalId: goal.id },
                "跟进请求已交给管家，目标仍保持等待",
              )
            }
          >
            让管家跟进
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(
                {
                  type: "goal.remind",
                  goalId: goal.id,
                  at: new Date(Date.now() + 3_600_000).toISOString(),
                  note: goal.next,
                },
                "1 小时后提醒你继续关注",
              )
            }
          >
            1 小时后提醒
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => setReplyMode("resume")}
          >
            有结果，继续推进
          </button>
        </div>
      </div>
    );
  }

  if (view.ended) {
    return (
      <div className="goal-quiet-row done">
        <span>
          <Check size={18} />
        </span>
        <div>
          <strong>{view.label}</strong>
          <small>目标记录和附件仍可回看。</small>
        </div>
      </div>
    );
  }

  return (
    <div className="goal-quiet-row">
      <span>
        {goal.mode === "concierge" ? <Bot size={18} /> : <UserRound size={18} />}
      </span>
      <div>
        <strong>{goal.mode === "concierge" ? "管家正在处理" : "由你继续处理"}</strong>
        <small>
          {goal.mode === "concierge"
            ? "注意力面板只显示真正需要你的改变。"
            : "补充进展、更新安排，完成后再提交验收。"}
        </small>
      </div>
      <div className="goal-action-buttons">
        <button
          type="button"
          className="secondary"
          onClick={() => setReplyMode("message")}
        >
          {goal.mode === "concierge" ? "给管家留言" : "补充说明"}
        </button>
      </div>
    </div>
  );
}

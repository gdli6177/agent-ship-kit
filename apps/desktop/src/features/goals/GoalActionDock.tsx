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
          <span>需要你的明确决定</span>
          <strong>{goal.attention?.summary}</strong>
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
            仅留言给管家
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
          <span>下一步</span>
          <strong>验收通过后由管家收尾；有问题就退回修改。</strong>
        </div>
        <div className="goal-action-buttons">
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("message")}
          >
            有疑问，问管家
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
          <small>{goal.dispatch?.detail || "目标已经安全保存，可以直接重试。"}</small>
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
          <small>处理完成后直接告诉管家，不需要回来重新填表。</small>
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
      <div className="goal-quiet-row waiting">
        <span>
          <Clock3 size={18} />
        </span>
        <div>
          <strong>到点跟进了</strong>
          <small>等待事项还没有结束；可以请管家继续核实。</small>
        </div>
        <div className="goal-action-buttons">
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("message")}
          >
            有进展，告诉管家
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
            请管家跟进
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("resume")}
          >
            有结果了，继续推进
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              void act(
                {
                  type: "goal.resolve",
                  goalId: goal.id,
                  actor: "你",
                },
                "这次跟进已处理",
              )
            }
          >
            完成这次跟进
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
          <small>管家会在有新结果时把这件事带回来。</small>
        </div>
        <div className="goal-action-buttons">
          <button
            type="button"
            className="secondary"
            onClick={() => setReplyMode("message")}
          >
            有进展，告诉管家
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
            请管家跟进
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
            有结果了，继续推进
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

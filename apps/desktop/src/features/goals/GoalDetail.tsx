import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  ImagePlus,
  Sparkles,
  SquareTerminal,
  UserRound,
  X,
} from "lucide-react";
import type {
  Activity,
  Goal,
  GoalAttachment,
  WorkspaceState,
} from "../../../../../packages/core/src/types.js";
import { GoalActionDock } from "./GoalActionDock.js";
import { GoalAttachments } from "./GoalAttachments.js";
import { GoalHistory } from "./GoalActivity.js";
import type { GoalReplyMode } from "./GoalReplyComposer.js";
import { presentGoal, time } from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";

function ContextAttachments({
  goal,
  activity,
  attachments,
  service,
}: {
  goal: Goal;
  activity?: Activity;
  attachments: GoalAttachment[];
  service: GoalDetailService;
}) {
  if (!activity || !attachments.length) return null;
  return (
    <div className="context-attachments">
      {attachments.map((attachment) => (
        <button
          type="button"
          key={attachment.id}
          onClick={() => void service.openAttachment(goal.id, attachment.id)}
        >
          <ImagePlus size={13} />
          {attachment.name}
        </button>
      ))}
    </div>
  );
}

export function GoalDetail({
  goal,
  state,
  onClose,
  service,
  busy,
  removeAttachment,
  deleteGoal,
  edit,
  notify,
  error,
  submit,
}: {
  goal: Goal;
  state: WorkspaceState;
  onClose: () => void;
  service: GoalDetailService;
  busy: boolean;
  removeAttachment: (attachmentId: string) => void;
  deleteGoal: () => void;
  edit: () => void;
  notify: (text: string) => void;
  error: string;
  submit: () => void;
}) {
  const [replyMode, setReplyMode] = useState<GoalReplyMode | null>(null);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const view = presentGoal(goal, state);
  const descriptionCanCollapse = goal.description.trim().length > 240;
  const focusTitle = view.needsDecision
    ? goal.attention?.summary || goal.next
    : goal.status === "review"
      ? "检查成果与证据后完成验收"
      : view.dueFollowUp
        ? goal.waitingFor
          ? `确认 ${goal.waitingFor} 是否已有结果`
          : "确认等待事项是否已有结果"
        : view.needsIntervention || view.dispatchFailed
          ? goal.attention?.summary || goal.next
          : view.brief;
  const showContext =
    !!view.contextActivity &&
    !view.needsIntervention &&
    !view.dispatchFailed &&
    goal.status !== "review";
  const runtimeError =
    goal.dispatch?.status === "failed"
      ? goal.dispatch.detail
      : goal.watchdog?.lastError;
  const deliveryActivityId = goal.delivery
    ? [...goal.activities]
        .reverse()
        .find((activity) => activity.kind === "delivery")?.id
    : undefined;
  const conversationExcludeIds = [
    ...(showContext ? [view.contextActivity!.id] : []),
    ...(deliveryActivityId ? [deliveryActivityId] : []),
  ];

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className="goal-detail-modal"
          onFocusOutside={(event) => event.preventDefault()}
        >
          <header className="goal-detail-header">
            <div className="goal-detail-origin">
              <span>
                <Sparkles size={15} />
              </span>
              <p>
                <small>{goal.mode === "concierge" ? "管家协同" : "个人推进"}</small>
                <strong>{view.projectName}</strong>
              </p>
            </div>
            <div className="goal-detail-header-actions">
              {!view.ended && (
                <button
                  type="button"
                  className="goal-scene-button"
                  disabled={busy}
                  title={
                    goal.herdr
                      ? `打开 ${goal.owner} 的 Herdr 工作现场`
                      : "打开当前工作区的管家现场"
                  }
                  onClick={() => void service.openHerdr(goal.id)}
                >
                  <SquareTerminal size={15} />
                  <span>{goal.herdr ? "回到现场" : "找管家"}</span>
                </button>
              )}
              <span className={`goal-state-pill ${view.tone}`}>
                <i />
                {view.label}
              </span>
              <Dialog.Close className="icon-button" aria-label="关闭">
                <X size={18} />
              </Dialog.Close>
            </div>
          </header>
          <Dialog.Title className="visually-hidden">
            目标详情：{goal.title}
          </Dialog.Title>
          <Dialog.Description className="visually-hidden">
            当前目标结论、待办、交付证据、对话记录、附件和状态操作。
          </Dialog.Description>

          <div className="goal-detail-body">
            <article className="goal-detail-content">
              <header className="goal-detail-title">
                <h2>{goal.title}</h2>
                <div className="goal-detail-meta">
                  <span>
                    <UserRound size={12} />
                    {goal.owner}
                  </span>
                  {goal.waitingFor && (
                    <span>
                      <Clock3 size={12} />
                      等待 {goal.waitingFor}
                    </span>
                  )}
                  {goal.remindAt && (
                    <span>
                      <Clock3 size={12} />
                      {time(goal.remindAt)} 跟进
                    </span>
                  )}
                  {goal.status === "review" && (
                    <span>第 {goal.reviewRounds ?? 1} 轮审查</span>
                  )}
                  <time>{time(goal.updatedAt)} 更新</time>
                </div>
              </header>

              <section
                className={`goal-focus ${view.tone}`}
                aria-label="现在需要你关注的事"
              >
                <div className="goal-focus-copy">
                  <span>{view.label}</span>
                  <h3>{focusTitle}</h3>
                  <p>{view.detail}</p>
                </div>
                <div className="goal-focus-next">
                  <small>{view.nextLabel}</small>
                  <p>{goal.next || "暂无记录，等待管家更新。"}</p>
                </div>
              </section>

              {showContext && (
                <section className="goal-handoff" aria-label="最近一次交接">
                  <header>
                    <span>
                      <Bot size={14} />
                    </span>
                    <div>
                      <strong>{view.contextActivity!.actor}</strong>
                      <small>
                        最近交接 · {time(view.contextActivity!.at)}
                      </small>
                    </div>
                  </header>
                  <p>{view.contextActivity!.text}</p>
                  <ContextAttachments
                    goal={goal}
                    activity={view.contextActivity}
                    attachments={view.contextAttachments}
                    service={service}
                  />
                </section>
              )}

              {goal.delivery && (
                <section className="delivery goal-delivery" aria-label="交付与证据">
                  <div className="section-heading">
                    <div>
                      <small className="goal-section-kicker">交付</small>
                      <h3>成果与证据</h3>
                    </div>
                    <small>
                      {time(goal.delivery.submittedAt)} ·{" "}
                      {goal.delivery.submittedBy}
                    </small>
                  </div>
                  <p className="delivery-summary">{goal.delivery.summary}</p>
                  {goal.delivery.location &&
                    goal.delivery.location !== goal.delivery.url && (
                      <code>{goal.delivery.location}</code>
                    )}
                  {goal.delivery.url && (
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => void service.openUrl(goal.delivery!.url!)}
                    >
                      打开交付链接
                      <ArrowUpRight size={13} />
                    </button>
                  )}
                  <div className="checks">
                    {goal.delivery.checks.length ? (
                      goal.delivery.checks.map((check, index) => (
                        <div key={`${check.name}-${index}`}>
                          <Check size={14} />
                          <div>
                            <strong>{check.name}</strong>
                            <code>{check.command}</code>
                            {check.note && <span>{check.note}</span>}
                          </div>
                          <small className={check.result}>{check.result}</small>
                        </div>
                      ))
                    ) : (
                      <p className="checks-empty">没有附加检查记录。</p>
                    )}
                  </div>
                </section>
              )}

              <section className="goal-original">
                <header>
                  <span>
                    <FileText size={14} />
                    目标说明
                  </span>
                  {descriptionCanCollapse && (
                    <button
                      type="button"
                      onClick={() => setDescriptionOpen((open) => !open)}
                    >
                      {descriptionOpen ? "收起" : "展开全文"}
                    </button>
                  )}
                </header>
                <p className={descriptionOpen ? "" : "clamped"}>
                  {goal.description || "创建目标时没有附加说明。"}
                </p>
              </section>

              {!!goal.attachments?.length && (
                <GoalAttachments
                  goalId={goal.id}
                  attachments={goal.attachments}
                  service={service}
                  remove={removeAttachment}
                />
              )}

              {runtimeError && (
                <details className="goal-runtime-note">
                  <summary>
                    运行时连接有问题
                    <ChevronDown size={14} />
                  </summary>
                  <p>{runtimeError}</p>
                </details>
              )}

              <details className="manual-tools goal-detail-advanced">
                <summary>
                  目标管理
                  <ChevronDown size={14} />
                </summary>
                <p>用于人工接管、纠正记录或结束目标。日常推进优先使用底部操作。</p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={edit}
                  >
                    编辑目标
                  </button>
                  {goal.status !== "review" && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={submit}
                    >
                      提交成果
                    </button>
                  )}
                  {!view.ended && goal.mode === "concierge" && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          await service.command({
                            type: "goal.takeover",
                            goalId: goal.id,
                          });
                          notify("已由你接管，不会再向管家发送后续更新");
                        } catch {
                          // The application-level command surface reports the real error.
                        }
                      }}
                    >
                      我来处理
                    </button>
                  )}
                  {!view.ended && goal.mode === "manual" && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          await service.command({
                            type: "goal.delegate",
                            goalId: goal.id,
                          });
                          notify("已重新交给管家");
                        } catch {
                          // The application-level command surface reports the real error.
                        }
                      }}
                    >
                      交给管家
                    </button>
                  )}
                  {view.ended ? (
                    <button
                      type="button"
                      className="secondary danger-action"
                      disabled={busy}
                      onClick={deleteGoal}
                    >
                      永久删除目标
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary danger-action"
                      disabled={busy}
                      onClick={async () => {
                        const note = window.prompt("为什么放弃这个目标？");
                        if (!note?.trim()) return;
                        try {
                          await service.command({
                            type: "goal.drop",
                            goalId: goal.id,
                            note,
                          });
                          notify("目标已放弃，记录仍可查看");
                        } catch {
                          // The application-level command surface reports the real error.
                        }
                      }}
                    >
                      放弃目标
                    </button>
                  )}
                </div>
              </details>
            </article>

            <aside className="goal-detail-context">
              <GoalHistory
                goal={goal}
                latestIds={conversationExcludeIds}
                service={service}
              />
            </aside>
          </div>

          <footer className={`goal-action-dock ${view.tone}`}>
            <GoalActionDock
              goal={goal}
              view={view}
              service={service}
              busy={busy}
              error={error}
              replyMode={replyMode}
              setReplyMode={setReplyMode}
              notify={notify}
            />
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

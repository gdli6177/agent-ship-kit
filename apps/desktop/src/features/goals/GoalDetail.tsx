import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ImagePlus,
  MessageCircle,
  Sparkles,
  X,
} from "lucide-react";
import type {
  Goal,
  WorkspaceState,
} from "../../../../../packages/core/src/types.js";
import { GoalActionDock } from "./GoalActionDock.js";
import { GoalAttachments } from "./GoalAttachments.js";
import { GoalHistory } from "./GoalActivity.js";
import type { GoalReplyMode } from "./GoalReplyComposer.js";
import {
  presentGoal,
  time,
} from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";

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
  const view = presentGoal(goal, state);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="goal-detail-modal">
          <header className="goal-detail-header">
            <div className="goal-detail-origin">
              <span>
                <Sparkles size={15} />
              </span>
              <p>
                <small>管家交接</small>
                <strong>{view.projectName}</strong>
              </p>
            </div>
            <div className="goal-detail-header-actions">
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
            当前目标原文、状态、附件、历史操作和与你管家的消息记录。
          </Dialog.Description>
          <div className="goal-detail-scroll">
            <article className="goal-detail-content">
              <header className="goal-detail-title">
                <span className={`goal-detail-state-copy ${view.tone}`}>
                  {view.detail}
                </span>
                <h2>{goal.title}</h2>
                <div className="goal-detail-meta">
                  <span>{goal.owner}</span>
                  <span>
                    {goal.live?.state === "blocked"
                      ? "现场阻塞"
                      : goal.live?.state === "working"
                        ? "负责人工作中"
                        : goal.live?.reachable === false
                          ? "现场不可达"
                          : goal.status === "review"
                            ? `第 ${goal.reviewRounds ?? 1} 轮审查`
                            : "状态由 Crewvane 维护"}
                  </span>
                  <time>{time(goal.updatedAt)} 更新</time>
                </div>
              </header>
              <section
                className="goal-latest-message"
                aria-label="最新消息原文"
              >
                <div className="goal-message-meta">
                  <span>
                    {view.latest?.actor.startsWith("你") ? (
                      <MessageCircle size={15} />
                    ) : (
                      <Bot size={15} />
                    )}
                  </span>
                  <strong>{view.latest?.actor ?? "目标原文"}</strong>
                  <small>
                    {view.latest ? time(view.latest.at) : "创建目标时"}
                  </small>
                </div>
                <div className="goal-raw-message">
                  {view.latest?.text || goal.description}
                </div>
                {!!view.latestAttachments.length && (
                  <div className="latest-message-attachments">
                    {view.latestAttachments.map((attachment) => (
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
                )}
              </section>
              <section className="goal-next-record">
                <span>管家记录的下一步</span>
                <p>{goal.next}</p>
                {goal.remindAt && <small>{time(goal.remindAt)} 跟进</small>}
              </section>
              {!!goal.attachments?.length && (
                <GoalAttachments
                  goalId={goal.id}
                  attachments={goal.attachments}
                  service={service}
                  remove={removeAttachment}
                />
              )}
              {goal.delivery && (
                <section className="delivery goal-delivery">
                  <div className="section-heading">
                    <h3>交付与证据</h3>
                    <small>
                      {time(goal.delivery.submittedAt)} ·{" "}
                      {goal.delivery.submittedBy}
                    </small>
                  </div>
                  <p>{goal.delivery.summary}</p>
                  {goal.delivery.location && goal.delivery.location !== goal.delivery.url && (
                    <code>{goal.delivery.location}</code>
                  )}
                  {goal.delivery.url && (
                    <button
                      className="text-link"
                      onClick={() => void service.openUrl(goal.delivery!.url!)}
                    >
                      打开交付链接
                      <ArrowUpRight size={13} />
                    </button>
                  )}
                  <div className="checks">
                    {goal.delivery.checks.map((check, index) => (
                      <div key={`${check.name}-${index}`}>
                        <Check size={14} />
                        <strong>{check.name}</strong>
                        <code>{check.command}</code>
                        {check.note && <span>{check.note}</span>}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {goal.dispatch && (
                <p
                  className={`dispatch-note ${goal.dispatch.status}`}
                  role="status"
                >
                  {goal.dispatch.status === "pending"
                    ? "消息正在交给管家。"
                    : goal.dispatch.status === "failed"
                      ? goal.dispatch.detail
                      : `已送达管家 · ${time(goal.dispatch.at)}`}
                </p>
              )}
              {goal.watchdog && !goal.attention && (
                <p className="dispatch-note">
                  {goal.watchdog.contactedAt
                    ? "管家正在核查这个目标的现场。"
                    : "巡检正在确认下一步。"}
                </p>
              )}
              <GoalHistory
                goal={goal}
                latestId={view.latest?.id}
                service={service}
              />
              <details className="manual-tools goal-detail-advanced">
                <summary>
                  更多操作
                  <ChevronDown size={14} />
                </summary>
                <p>
                  这些操作用于人工接管或纠正记录。正常协调请直接回复上方管家。
                </p>
                <div className="modal-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={edit}
                  >
                    编辑目标
                  </button>
                  {goal.status !== "review" && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={submit}
                    >
                      提交成果
                    </button>
                  )}
                  {!view.ended && goal.mode === "concierge" && (
                    <button
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
                      className="secondary danger-action"
                      disabled={busy}
                      onClick={deleteGoal}
                    >
                      永久删除目标
                    </button>
                  ) : (
                    <button
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

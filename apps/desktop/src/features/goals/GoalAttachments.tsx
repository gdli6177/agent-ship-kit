import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ImagePlus,
  Trash2,
} from "lucide-react";
import type { GoalAttachment } from "../../../../../packages/core/src/types.js";
import { formatBytes } from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";

function GoalAttachmentTile({
  goalId,
  attachment,
  service,
  remove,
}: {
  goalId: string;
  attachment: GoalAttachment;
  service: GoalDetailService;
  remove?: () => void;
}) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    let active = true;
    void service
      .previewAttachment(goalId, attachment.id)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [goalId, attachment.id, service]);

  return (
    <div className="goal-attachment">
      <button
        type="button"
        className="goal-attachment-open"
        onClick={() => void service.openAttachment(goalId, attachment.id)}
      >
        <span className="goal-attachment-preview">
          {preview ? <img src={preview} alt="" /> : <ImagePlus size={18} />}
        </span>
        <span>
          <strong>{attachment.name}</strong>
          <small>{formatBytes(attachment.size)} · 点击打开原图</small>
        </span>
        <ArrowUpRight size={13} />
      </button>
      {remove && (
        <button
          type="button"
          className="goal-attachment-remove"
          aria-label={`删除图片 ${attachment.name}`}
          title="永久删除这张图片"
          onClick={() => {
            if (window.confirm(`永久删除图片「${attachment.name}」？`)) remove();
          }}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

export function GoalAttachments({
  goalId,
  attachments,
  service,
  remove,
  readOnly = false,
}: {
  goalId: string;
  attachments: GoalAttachment[];
  service: GoalDetailService;
  remove?: (attachmentId: string) => void;
  readOnly?: boolean;
}) {
  return (
    <section className="goal-attachments">
      <div className="section-heading">
        <h3>图片附件</h3>
        <small>{attachments.length} 张 · 原图保存在本机</small>
      </div>
      <div>
        {attachments.map((attachment) => (
          <GoalAttachmentTile
            key={attachment.id}
            goalId={goalId}
            attachment={attachment}
            service={service}
            remove={!readOnly && remove ? () => remove(attachment.id) : undefined}
          />
        ))}
      </div>
      {!readOnly && (
        <p className="attachment-retention">
          目标结束后保留 30 天；也可以逐张删除或随目标永久删除。
        </p>
      )}
    </section>
  );
}

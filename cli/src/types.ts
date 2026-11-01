export const PRIORITIES = ["normal", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const DECISIONS = ["accept", "changes_requested", "reject"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Inbox items the human still has to see. `review_decided` closes one of these. */
export const ATTENTION_TYPES = ["needs_review", "blocked", "needs_approval"] as const;
export type AttentionType = (typeof ATTENTION_TYPES)[number];

export const EVENT_TYPES = [
  "proposal_ready",
  "contract_frozen",
  "worker_dispatched",
  "needs_review",
  "blocked",
  "needs_approval",
  "review_decided",
  "notify_planned",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventLinks {
  pr?: string;
  issue?: string;
  path?: string;
}

/** Open inbox line. Field names match events/schema.json. */
export interface AttentionEvent {
  id: string;
  type: AttentionType;
  title: string;
  summary: string;
  evidence_urls: string[];
  priority: Priority;
  created_at: string;
  source_task_id: string;
  links: EventLinks;
}

export interface ReviewDecidedEvent {
  id: string;
  type: "review_decided";
  title: string;
  summary: string;
  created_at: string;
  source_task_id: string;
  decision: Decision;
  subject_id: string;
  note?: string;
}

export type InboxRecord = AttentionEvent | ReviewDecidedEvent;

export interface InboxAddInput {
  type?: AttentionType;
  title: string;
  summary: string;
  priority?: Priority;
  sourceTaskId: string;
  evidenceUrls?: string[];
  links?: EventLinks;
  id?: string;
  createdAt?: string;
}

export interface ListInboxOptions {
  priority?: Priority;
  type?: AttentionType | "review_decided";
  /** When true, hide items that already have a review_decided row. */
  openOnly?: boolean;
}

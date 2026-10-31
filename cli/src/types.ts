export const PRIORITIES = ["normal", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const EVENT_TYPES = [
  "proposal_ready",
  "contract_frozen",
  "worker_dispatched",
  "needs_review",
  "review_decided",
  "notify_planned",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventLinks {
  pr?: string;
  issue?: string;
  path?: string;
}

/** Inbox line. Field names match events/schema.json. */
export interface NeedsReviewEvent {
  id: string;
  type: "needs_review";
  title: string;
  summary: string;
  evidence_urls: string[];
  priority: Priority;
  created_at: string;
  source_task_id: string;
  links: EventLinks;
}

export interface InboxAddInput {
  title: string;
  summary: string;
  priority?: Priority;
  sourceTaskId: string;
  evidenceUrls?: string[];
  links?: EventLinks;
  id?: string;
  createdAt?: string;
}

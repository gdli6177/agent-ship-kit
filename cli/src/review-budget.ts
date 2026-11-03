import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readInbox } from "./inbox.js";

/**
 * Human review budget on proposal and contract cards.
 *
 * A card with `## Human review budget` is new: a missing or malformed
 * `human_reviews_expected` fails the check (the count must match the purpose
 * list; placeholders fail). A card without that section is older: the check
 * warns and does not fail. Optional `must_human` and `already_automated`
 * notes, when the line is present, must be real text. The check reports
 * `inbox_needs_review_count` so acceptance can compare it with the budget.
 * It never merges.
 */
const SECTION_HEADING = /^##\s+Human review budget\b/i;
const BULLET = /^[-*]\s+(?:\[(?: |x|X)\]\s*)?(.+)$/;
const FIELD = /^(human_reviews_expected|must_human|already_automated):[ \t]*(.*)$/;
const PLACEHOLDER = /^<[^>\n]*>$/;
const CARD_ID = /^[A-Za-z0-9._-]+$/;
const COUNT = /^(0|[1-9]\d*)$/;
const MAX_PURPOSE = 200;
const MAX_NOTE = 280;

export interface HumanReviewBudget {
  human_reviews_expected: number;
  reviews: string[];
  must_human: string | null;
  already_automated: string | null;
}

export interface HumanReviewViolation {
  code: "missing" | "malformed" | "mismatch";
  card: "proposal" | "contract";
  message: string;
}

export interface ParsedHumanReviewBudget {
  present: boolean;
  budget: HumanReviewBudget | null;
  violations: HumanReviewViolation[];
}

export interface HumanReviewAssessment {
  budget: (HumanReviewBudget & { source: "proposal" | "contract" }) | null;
  warnings: string[];
  violations: HumanReviewViolation[];
  inbox_needs_review_count: number;
}

type BudgetCard = "proposal" | "contract";
type NoteKey = "must_human" | "already_automated";

function cleanToken(raw: string): string {
  return raw.trim().replace(/^`+|`+$/g, "").trim();
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

export function readCardField(markdown: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:[ \\t]*(.*)$`, "im").exec(markdown);
  const value = cleanToken(match?.[1] ?? "");
  if (!value || isPlaceholder(value)) return "";
  return value;
}

function push(violations: HumanReviewViolation[], card: BudgetCard, code: HumanReviewViolation["code"], message: string): void {
  violations.push({ code, card, message });
}

export function parseHumanReviewBudget(markdown: string, card: BudgetCard): ParsedHumanReviewBudget {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("## ")) continue;
    if (SECTION_HEADING.test(line) && start === -1) {
      seen += 1;
      start = index + 1;
      continue;
    }
    if (SECTION_HEADING.test(line)) seen += 1;
    if (start !== -1 && end === lines.length) end = index;
  }
  if (start === -1) return { present: false, budget: null, violations: [] };

  const violations: HumanReviewViolation[] = [];
  if (seen > 1) push(violations, card, "malformed", `${card} has more than one Human review budget section`);

  let expectedRaw: string | null = null;
  const reviews: string[] = [];
  const notes = new Map<NoteKey, string>();
  for (const raw of lines.slice(start, end)) {
    const line = raw.trim();
    if (!line) continue;
    const field = FIELD.exec(line);
    if (field) {
      const key = field[1];
      const value = cleanToken(field[2] ?? "");
      if (key === "human_reviews_expected") {
        if (expectedRaw !== null) push(violations, card, "malformed", `${card} repeats human_reviews_expected`);
        expectedRaw = value;
      } else if (key === "must_human" || key === "already_automated") {
        if (notes.has(key)) push(violations, card, "malformed", `${card} repeats ${key}`);
        notes.set(key, value);
      }
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet?.[1]) reviews.push(cleanToken(bullet[1]));
  }

  let expectedCount: number | null = null;
  if (expectedRaw === null) {
    push(violations, card, "missing", `${card} Human review budget is missing human_reviews_expected`);
  } else if (!COUNT.test(expectedRaw)) {
    push(violations, card, "malformed", `${card} human_reviews_expected must be a non-negative integer`);
  } else {
    const parsed = Number(expectedRaw);
    if (!Number.isSafeInteger(parsed)) {
      push(violations, card, "malformed", `${card} human_reviews_expected must be a non-negative integer`);
    } else {
      expectedCount = parsed;
    }
  }

  const purposes: string[] = [];
  for (const review of reviews) {
    if (!review || isPlaceholder(review)) {
      push(violations, card, "malformed", `${card} human review purpose is missing or still a placeholder`);
      continue;
    }
    if (review.length > MAX_PURPOSE) {
      push(violations, card, "malformed", `${card} human review purpose is too long`);
      continue;
    }
    purposes.push(review);
  }
  if (expectedCount !== null && reviews.length !== expectedCount) {
    push(
      violations,
      card,
      "malformed",
      `${card} human_reviews_expected is ${expectedCount} but lists ${reviews.length} reviews`,
    );
  }

  function note(key: NoteKey): string | null {
    if (!notes.has(key)) return null;
    const value = notes.get(key) ?? "";
    if (!value || isPlaceholder(value)) {
      push(violations, card, "malformed", `${card} ${key} is empty or still a placeholder`);
      return null;
    }
    if (value.length > MAX_NOTE) {
      push(violations, card, "malformed", `${card} ${key} is too long`);
      return null;
    }
    return value;
  }

  const mustHuman = note("must_human");
  const alreadyAutomated = note("already_automated");
  if (violations.length > 0 || expectedCount === null) return { present: true, budget: null, violations };
  return {
    present: true,
    budget: {
      human_reviews_expected: expectedCount,
      reviews: purposes,
      must_human: mustHuman,
      already_automated: alreadyAutomated,
    },
    violations: [],
  };
}

export function budgetsMatch(left: HumanReviewBudget, right: HumanReviewBudget): boolean {
  return (
    left.human_reviews_expected === right.human_reviews_expected &&
    left.reviews.length === right.reviews.length &&
    left.reviews.every((item, index) => item === right.reviews[index]) &&
    left.must_human === right.must_human &&
    left.already_automated === right.already_automated
  );
}

export async function assessHumanReview(root: string, contractId: string, contractMarkdown: string): Promise<HumanReviewAssessment> {
  const warnings: string[] = [];
  const violations: HumanReviewViolation[] = [];
  const contractParsed = parseHumanReviewBudget(contractMarkdown, "contract");
  if (!contractParsed.present) {
    warnings.push(`contract ${contractId} has no Human review budget section; older card, not a failure`);
  } else {
    violations.push(...contractParsed.violations);
  }

  let proposalBudget: HumanReviewBudget | null = null;
  const proposalId = readCardField(contractMarkdown, "Proposal id");
  if (proposalId) {
    if (!CARD_ID.test(proposalId)) {
      warnings.push(`proposal id ${proposalId} is not a file id; human review budget checked on the contract only`);
    } else {
      try {
        const proposal = await readFile(join(root, ".crewvane", "proposals", `${proposalId}.md`), "utf8");
        const parsed = parseHumanReviewBudget(proposal, "proposal");
        if (!parsed.present) {
          warnings.push(`proposal ${proposalId} has no Human review budget section; older card, not a failure`);
        } else {
          violations.push(...parsed.violations);
          proposalBudget = parsed.budget;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
        warnings.push(`proposal ${proposalId} file not found; human review budget checked on the contract only`);
      }
    }
  }

  const contractBudget = contractParsed.budget;
  if (proposalBudget && contractBudget && !budgetsMatch(proposalBudget, contractBudget)) {
    push(violations, "contract", "mismatch", `contract ${contractId} human review budget does not match proposal ${proposalId}`);
  }

  const inbox = await readInbox(root);
  const inboxNeedsReviewCount = inbox.filter((item) => item.type === "needs_review" && item.contract_id === contractId).length;
  const chosen = proposalBudget ?? contractBudget;
  return {
    budget: chosen === null ? null : { ...chosen, source: proposalBudget ? "proposal" : "contract" },
    warnings,
    violations,
    inbox_needs_review_count: inboxNeedsReviewCount,
  };
}

export const HISTORY_LIMIT = 20;

export type HistoryEntry = {
  id: string;
  /** The first question. Follow-ups stay in `markdown`. */
  question: string;
  /** Transcript as shown in the answer view, including follow-ups. */
  markdown: string;
  /** Text of the latest turn. Empty when that turn produced no text. */
  answer: string;
  model: string;
  updatedAt: number;
};

export type HistoryDraft = Omit<HistoryEntry, "updatedAt">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.question !== "string" || !value.question.trim()) return null;
  if (typeof value.markdown !== "string" || !value.markdown.trim()) return null;
  if (typeof value.model !== "string") return null;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
  return {
    id: value.id,
    question: value.question,
    markdown: value.markdown,
    answer: typeof value.answer === "string" ? value.answer : "",
    model: value.model,
    updatedAt: value.updatedAt,
  };
}

export function parseHistory(raw: string | undefined | null): HistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const entry = toEntry(item);
      return entry ? [entry] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Inserts or replaces `draft` and keeps the newest conversations.
 * An update moves that conversation to the front.
 */
export function upsertHistory(
  entries: HistoryEntry[],
  draft: HistoryDraft,
  now = Date.now(),
  limit = HISTORY_LIMIT,
): HistoryEntry[] {
  const existing = entries.find((entry) => entry.id === draft.id);
  if (
    existing &&
    existing.question === draft.question &&
    existing.markdown === draft.markdown &&
    existing.answer === draft.answer &&
    existing.model === draft.model
  ) {
    return entries;
  }
  const next: HistoryEntry = { ...draft, updatedAt: now };
  return [next, ...entries.filter((entry) => entry.id !== next.id)].slice(0, limit);
}

export function withoutHistory(entries: HistoryEntry[], id: string): HistoryEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

import { LocalStorage } from "@raycast/api";
import {
  parseHistory,
  upsertHistory,
  withoutHistory,
  type HistoryDraft,
  type HistoryEntry,
} from "./history-entries";

const HISTORY_STORAGE_KEY = "csharp-docs-history";

/**
 * Writes from the answer view and deletes from History can overlap.
 * One chain keeps a later delete from being overwritten by an earlier save.
 */
let pending = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = pending.then(task, task);
  pending = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  const raw = await LocalStorage.getItem(HISTORY_STORAGE_KEY);
  return parseHistory(typeof raw === "string" ? raw : undefined);
}

async function writeAll(entries: HistoryEntry[]): Promise<void> {
  if (entries.length === 0) {
    await LocalStorage.removeItem(HISTORY_STORAGE_KEY);
    return;
  }
  await LocalStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries));
}

export function rememberHistory(draft: HistoryDraft): Promise<void> {
  return enqueue(async () => {
    const entries = await loadHistory();
    const next = upsertHistory(entries, draft);
    if (next === entries) return;
    await writeAll(next);
  });
}

export function deleteHistoryEntry(id: string): Promise<void> {
  return enqueue(async () => {
    const entries = await loadHistory();
    await writeAll(withoutHistory(entries, id));
  });
}

export function clearHistory(): Promise<void> {
  return enqueue(() => writeAll([]));
}

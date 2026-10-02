import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseHistory,
  upsertHistory,
  withoutHistory,
  type HistoryDraft,
  type HistoryEntry,
} from "./history-entries.ts";

function draft(id: string, question = `Question ${id}`): HistoryDraft {
  return {
    id,
    question,
    markdown: `### Question\n\n> ${question}\n\nAnswer ${id}`,
    answer: `Answer ${id}`,
    model: "auto",
  };
}

function entry(id: string, updatedAt: number): HistoryEntry {
  return { ...draft(id), updatedAt };
}

test("parses stored history and skips corrupt items", () => {
  const raw = JSON.stringify([
    entry("a", 2),
    { id: "bad" },
    { ...entry("b", 1), answer: undefined },
    null,
  ]);
  const parsed = parseHistory(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.id, "a");
  assert.equal(parsed[1]?.id, "b");
  assert.equal(parsed[1]?.answer, "");
});

test("parse returns nothing for empty or invalid payloads", () => {
  assert.deepEqual(parseHistory(undefined), []);
  assert.deepEqual(parseHistory(""), []);
  assert.deepEqual(parseHistory("not-json"), []);
  assert.deepEqual(parseHistory("{}"), []);
});

test("upsert moves an updated conversation to the front and drops the oldest", () => {
  const existing = [entry("c", 3), entry("b", 2), entry("a", 1)];
  const updated = upsertHistory(existing, { ...draft("a"), answer: "Updated" }, 4, 2);
  assert.deepEqual(
    updated.map((item) => item.id),
    ["a", "c"],
  );
  assert.equal(updated[0]?.updatedAt, 4);
  assert.equal(updated[0]?.answer, "Updated");
});

test("upsert leaves an unchanged conversation in place", () => {
  const existing = [entry("a", 1)];
  assert.equal(upsertHistory(existing, draft("a"), 9), existing);
});

test("withoutHistory removes one conversation", () => {
  const existing = [entry("a", 2), entry("b", 1)];
  assert.deepEqual(
    withoutHistory(existing, "a").map((item) => item.id),
    ["b"],
  );
});

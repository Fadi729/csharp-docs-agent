import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedModel, parseListModels } from "./parse-models.ts";

test("parses id, display name, and CLI tags", () => {
  const models = parseListModels(`
Available models:

auto - Auto (default)
gpt-5.5-extra-high-fast - GPT-5.5 Extra High Fast (current)
composer-2.5 - Composer 2.5
`);
  assert.deepEqual(
    models.map((model) => ({
      id: model.id,
      title: model.title,
      isDefault: model.isDefault,
      isCurrent: model.isCurrent,
    })),
    [
      { id: "auto", title: "Auto", isDefault: true, isCurrent: false },
      {
        id: "gpt-5.5-extra-high-fast",
        title: "GPT-5.5 Extra High Fast",
        isDefault: false,
        isCurrent: true,
      },
      { id: "composer-2.5", title: "Composer 2.5", isDefault: false, isCurrent: false },
    ],
  );
});

test("parses bare ids and parenthetical tags", () => {
  const models = parseListModels("auto (default)\ncomposer-2-fast\n");
  assert.equal(models[0]?.id, "auto");
  assert.equal(models[0]?.isDefault, true);
  assert.equal(models[1]?.id, "composer-2-fast");
  assert.equal(models[1]?.title, "composer-2-fast");
});

test("strips ANSI and skips headers", () => {
  const models = parseListModels("\u001B[32msonnet-4-thinking\u001B[0m\nAvailable models:\n");
  assert.deepEqual(
    models.map((model) => model.id),
    ["sonnet-4-thinking"],
  );
});

test("parses JSON arrays and wrapped objects", () => {
  const fromArray = parseListModels(
    JSON.stringify([
      { id: "auto", displayName: "Auto", default: true },
      { model: "gpt-5", name: "GPT-5" },
    ]),
  );
  assert.equal(fromArray[0]?.id, "auto");
  assert.equal(fromArray[0]?.isDefault, true);
  assert.equal(fromArray[1]?.id, "gpt-5");

  const wrapped = parseListModels(JSON.stringify({ models: ["auto", "composer-2.5"] }));
  assert.deepEqual(
    wrapped.map((model) => model.id),
    ["auto", "composer-2.5"],
  );
});

test("dedupes ids and ignores prose", () => {
  const models = parseListModels("auto\nauto - Auto\nSign in to continue using Cursor\n");
  assert.deepEqual(
    models.map((model) => model.id),
    ["auto"],
  );
});

test("isAllowedModel only accepts ids from the parsed list", () => {
  const models = parseListModels("auto\ncomposer-2.5\n");
  assert.equal(isAllowedModel(models, "composer-2.5"), true);
  assert.equal(isAllowedModel(models, "definitely-not-a-model"), false);
});

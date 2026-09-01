export const DEFAULT_MODEL = "auto";

export type CursorModel = {
  id: string;
  title: string;
  isDefault: boolean;
  isCurrent: boolean;
};

const MODEL_ID = /^[a-z][a-z0-9._-]*$/;
const HEADER_IDS = new Set(["available", "model", "models", "name", "id"]);
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function takeFlags(label: string): { title: string; isDefault: boolean; isCurrent: boolean } {
  let title = label.trim();
  let isDefault = false;
  let isCurrent = false;
  for (;;) {
    const match = title.match(/\s*\((current|default)\)\s*$/i);
    if (!match || match.index === undefined) break;
    if (match[1].toLowerCase() === "default") isDefault = true;
    else isCurrent = true;
    title = title.slice(0, match.index).trim();
  }
  return { title, isDefault, isCurrent };
}

function asId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return MODEL_ID.test(id) ? id : null;
}

function fromFields(
  id: string,
  title: string | undefined,
  isDefault: boolean,
  isCurrent: boolean,
): CursorModel {
  const flags = takeFlags(title ?? "");
  return {
    id,
    title: flags.title || id,
    isDefault: isDefault || flags.isDefault,
    isCurrent: isCurrent || flags.isCurrent,
  };
}

function modelsFromJson(value: unknown): CursorModel[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const models: CursorModel[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        const id = asId(item);
        if (id) models.push(fromFields(id, undefined, false, false));
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = asId(record.id) ?? asId(record.model) ?? asId(record.name);
      if (!id) continue;
      const title =
        (typeof record.displayName === "string" && record.displayName) ||
        (typeof record.title === "string" && record.title) ||
        (typeof record.name === "string" && record.name !== id ? record.name : undefined);
      models.push(
        fromFields(
          id,
          title || undefined,
          Boolean(record.isDefault ?? record.is_default ?? record.default),
          Boolean(record.isCurrent ?? record.is_current ?? record.current),
        ),
      );
    }
    return models;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["models", "items", "data", "result"]) {
      const nested = modelsFromJson(record[key]);
      if (nested && nested.length > 0) return nested;
    }
  }
  return null;
}

function parseTextLine(line: string): CursorModel | null {
  const trimmed = line
    .trim()
    .replace(/^[•*-]\s+/, "")
    .replace(/^\d+[.)]\s+/, "");
  if (!trimmed) return null;

  const dashed = trimmed.match(/^(\S+)\s+-\s+(.*)$/);
  if (dashed && MODEL_ID.test(dashed[1]) && !HEADER_IDS.has(dashed[1])) {
    return fromFields(dashed[1], dashed[2], false, false);
  }

  const tokens = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
  if (!tokens || !MODEL_ID.test(tokens[1]) || HEADER_IDS.has(tokens[1])) return null;
  const rest = tokens[2] ?? "";
  // Bare ids, or ids followed only by CLI tags like `(default)`.
  if (rest && !/^\(.*\)$/.test(rest.trim())) return null;
  return fromFields(tokens[1], rest, false, false);
}

function dedupe(models: CursorModel[]): CursorModel[] {
  const seen = new Set<string>();
  const unique: CursorModel[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    unique.push(model);
  }
  return unique;
}

/**
 * Parse `agent --list-models` / `agent models` output. The CLI usually prints
 * `id - Display Name (current)` lines; some versions emit JSON instead.
 */
export function parseListModels(stdout: string): CursorModel[] {
  const text = stripAnsi(stdout)
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) return [];

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = modelsFromJson(JSON.parse(text));
      if (parsed && parsed.length > 0) return dedupe(parsed);
    } catch {
      // Fall through to line parsing.
    }
  }

  const models: CursorModel[] = [];
  for (const line of text.split(/\r?\n/)) {
    const model = parseTextLine(line);
    if (model) models.push(model);
  }
  return dedupe(models);
}

export function isAllowedModel(models: CursorModel[], id: string): boolean {
  return models.some((model) => model.id === id);
}

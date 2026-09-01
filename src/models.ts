import { LocalStorage } from "@raycast/api";
import { runAgent } from "./cli";
import { DEFAULT_MODEL, isAllowedModel, parseListModels, type CursorModel } from "./parse-models";

export { DEFAULT_MODEL, isAllowedModel, type CursorModel };

const MODEL_STORAGE_KEY = "cursor-cli-model";

export async function loadStoredModel(): Promise<string> {
  const value = await LocalStorage.getItem(MODEL_STORAGE_KEY);
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_MODEL;
}

export async function saveStoredModel(id: string): Promise<void> {
  await LocalStorage.setItem(MODEL_STORAGE_KEY, id);
}

function modelsOrEmpty(stdout: string): CursorModel[] {
  return parseListModels(stdout);
}

/**
 * Models the signed-in Cursor CLI account is allowed to use. `--list-models`
 * is the non-interactive path; `models` is the fallback subcommand.
 */
export async function fetchAllowedModels(): Promise<CursorModel[]> {
  const listed = await runAgent(["--list-models"]);
  const fromFlag = listed.code === 0 ? modelsOrEmpty(listed.stdout) : [];
  if (fromFlag.length > 0) return fromFlag;

  const subcommand = await runAgent(["models"]);
  const fromSubcommand = subcommand.code === 0 ? modelsOrEmpty(subcommand.stdout) : [];
  if (fromSubcommand.length > 0) return fromSubcommand;

  const detail =
    (subcommand.stderr || listed.stderr || subcommand.stdout || listed.stdout).trim() ||
    "Cursor CLI returned no models. Sign in with `agent login` and try again.";
  throw new Error(detail);
}

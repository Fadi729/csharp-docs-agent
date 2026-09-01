import { environment } from "@raycast/api";
import { spawn } from "child_process";
import { existsSync, mkdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const AGENT_MISSING_MESSAGE =
  "Cursor CLI (`agent`) was not found. Install it with:\n\n```bash\ncurl https://cursor.com/install -fsS | bash\n```";

export type AgentLaunch = { command: string; prefixArgs: string[] };

export function unixPath(): string {
  return [
    join(homedir(), ".local/bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    process.env.PATH ?? "",
  ].join(":");
}

/**
 * An empty, extension-owned directory. The agent runs with `--trust`, so this
 * keeps it from reaching into the home folder for a question that never needs
 * the filesystem.
 */
export function scratchDir(): string {
  const dir = join(environment.supportPath, "scratch");
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return homedir();
  }
}

export function resolveAgentLaunch(): AgentLaunch | null {
  const wrapper = [
    join(homedir(), ".local/bin/agent"),
    "/usr/local/bin/agent",
    "/opt/homebrew/bin/agent",
  ].find((path) => existsSync(path));
  if (!wrapper) return null;

  try {
    const scriptDir = dirname(realpathSync(wrapper));
    const nodeBin = join(scriptDir, "node");
    const indexJs = join(scriptDir, "index.js");
    if (existsSync(nodeBin) && existsSync(indexJs)) {
      return { command: nodeBin, prefixArgs: ["--use-system-ca", indexJs] };
    }
  } catch {
    // Fall back to the bash wrapper.
  }

  return { command: "/bin/bash", prefixArgs: [wrapper] };
}

export function agentEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: unixPath(),
    HOME: homedir(),
    CURSOR_INVOKED_AS: "agent",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

export function runAgent(
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const launch = resolveAgentLaunch();
  if (!launch) {
    return Promise.reject(new Error(AGENT_MISSING_MESSAGE));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.prefixArgs, ...args], {
      cwd: scratchDir(),
      env: agentEnv(),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Timed out talking to the Cursor CLI")));
    }, options?.timeoutMs ?? 20_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      finish(() => resolve({ stdout, stderr, code }));
    });
  });
}

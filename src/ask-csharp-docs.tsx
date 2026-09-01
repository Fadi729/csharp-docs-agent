import {
  Action,
  ActionPanel,
  Detail,
  environment,
  Form,
  Icon,
  Keyboard,
  LaunchProps,
  useNavigation,
} from "@raycast/api";
import { spawn } from "child_process";
import { existsSync, mkdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { useEffect, useRef, useState } from "react";

type AgentEvent = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  sessionId?: string;
  timestamp_ms?: number;
  model_call_id?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  tool_call?: Record<string, { args?: { path?: string } } | { name?: string }>;
};

type AgentRequest = {
  text: string;
  resumeId?: string;
  isFollowUp?: boolean;
};

const SYSTEM_PROMPT = `You are a specialized C# and .NET documentation agent.

Scope:
- Answer only questions about C#, .NET (BCL, runtime, SDK), ASP.NET, Entity Framework, NuGet, and related Microsoft .NET developer documentation.
- Treat every programming question as a C# / .NET question even if the user does not name the language. Example: "How do I iterate over a set" means C# HashSet / ISet / IEnumerable — never Python, Java, or JavaScript.
- When you need current APIs, signatures, or examples, search official Microsoft Learn / .NET documentation (learn.microsoft.com). Prefer those sources over generic blogs.

Out of scope:
- If the question is clearly not about C# or .NET (other programming languages, non-software topics, general chat), do not answer it. Decline in one or two sentences and say you only handle C# and .NET documentation.

Style:
- Answer with C# code and .NET type names.
- Keep examples current (modern C# / current .NET, not Framework-only unless asked).`;

const WAITING_COPY = "_Looking up C# / .NET docs…_";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

function waitingMarkdown(frame: number): string {
  return `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${WAITING_COPY}`;
}

/** The agent can ignore SIGTERM while a tool call is in flight. */
const KILL_GRACE_MS = 2000;

/**
 * Shorter repeats are more likely to be genuine text (a closing brace, a blank
 * line) than a re-sent tail of the stream.
 */
const MIN_DUPLICATE_TAIL = 24;

function quoteQuestion(heading: string, question: string): string {
  const quoted = question
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `### ${heading}\n\n${quoted}\n\n`;
}

function followUpMarkdown(question: string): string {
  return `\n\n---\n\n${quoteQuestion("Follow-up", question)}`;
}

/**
 * Under `--stream-partial-output` each event repeats the whole message so far,
 * so `incoming.startsWith(existing)` carries the common case. The remaining
 * branches only guard against the CLI replaying a chunk it already sent.
 */
function mergeAssistantText(existing: string, incoming: string): string {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (incoming === existing) return existing;
  if (incoming.startsWith(existing)) return incoming;
  if (existing.startsWith(incoming)) return existing;
  if (incoming.length >= MIN_DUPLICATE_TAIL && existing.endsWith(incoming)) return existing;
  return existing + incoming;
}

function buildAgentPrompt(userPrompt: string): string {
  return `${SYSTEM_PROMPT}

User question:
${userPrompt}`;
}

function unixPath(): string {
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
function scratchDir(): string {
  const dir = join(environment.supportPath, "scratch");
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return homedir();
  }
}

function resolveAgentLaunch(): { command: string; prefixArgs: string[] } | null {
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

/**
 * Streamed chunks carry `timestamp_ms`; the full message the CLI replays
 * afterwards carries `model_call_id`. Both checks must hold or the answer
 * renders twice. If the CLI changes this event shape the answer silently comes
 * out blank, so start here when a run produces no text.
 */
function assistantDelta(event: AgentEvent): string | null {
  if (event.type !== "assistant") return null;
  if (!Object.prototype.hasOwnProperty.call(event, "timestamp_ms") || event.timestamp_ms == null) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(event, "model_call_id")) return null;
  const parts = (event.message?.content ?? [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text ?? "");
  return parts.join("") || null;
}

function toolLabel(event: AgentEvent): string | null {
  if (event.type !== "tool_call" || event.subtype !== "started") return null;
  const tc = event.tool_call ?? {};
  const read = tc.readToolCall as { args?: { path?: string } } | undefined;
  if (read?.args?.path) return `Reading ${read.args.path}`;
  const write = tc.writeToolCall as { args?: { path?: string } } | undefined;
  if (write?.args?.path) return `Writing ${write.args.path}`;
  const fn = tc.function as { name?: string } | undefined;
  if (fn?.name) return fn.name;
  return Object.keys(tc)[0] ?? "tool";
}

function eventSessionId(event: AgentEvent): string | undefined {
  return event.session_id || event.sessionId;
}

function FollowUpForm({ onAsk }: { onAsk: (question: string) => void }) {
  const { pop } = useNavigation();
  const [error, setError] = useState<string | undefined>();

  return (
    <Form
      navigationTitle="Follow-up"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Ask"
            icon={Icon.ArrowRight}
            onSubmit={(values: { question: string }) => {
              const question = values.question?.trim();
              if (!question) {
                setError("Enter a question");
                return;
              }
              onAsk(question);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="question"
        title="Question"
        placeholder="Ask a follow-up about this answer…"
        autoFocus
        error={error}
        onChange={() => setError(undefined)}
      />
    </Form>
  );
}

export default function Command(props: LaunchProps<{ arguments: { prompt: string } }>) {
  const prompt = props.arguments?.prompt?.trim() ?? "";
  const [request, setRequest] = useState<AgentRequest | null>(
    prompt ? { text: buildAgentPrompt(prompt) } : null,
  );
  const initialHeader = prompt ? quoteQuestion("Question", prompt) : "";
  const [markdown, setMarkdown] = useState(initialHeader);
  const [answer, setAnswer] = useState("");
  const [activity, setActivity] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [awaitingAnswer, setAwaitingAnswer] = useState(Boolean(prompt));
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const textRef = useRef(initialHeader);

  useEffect(() => {
    if (!request) {
      setError("Prompt is required");
      setIsLoading(false);
      setAwaitingAnswer(false);
      return;
    }

    let cancelled = false;

    const fail = (message: string) => {
      if (cancelled) return;
      setError(message);
      setIsLoading(false);
      setAwaitingAnswer(false);
    };

    const launch = resolveAgentLaunch();
    if (!launch) {
      fail(
        "Cursor CLI (`agent`) was not found. Install it with:\n\n```bash\ncurl https://cursor.com/install -fsS | bash\n```",
      );
      return;
    }

    setError(null);
    setIsLoading(true);
    setAwaitingAnswer(true);
    setActivity(null);
    setAnswer("");

    if (!request.isFollowUp) {
      const header = quoteQuestion("Question", prompt);
      textRef.current = header;
      setMarkdown(header);
    }

    const args = [
      ...launch.prefixArgs,
      "-p",
      "--trust",
      "--mode",
      "ask",
      "--model",
      "auto",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
    ];
    if (request.resumeId) {
      args.push("--resume", request.resumeId);
    }
    args.push("--", request.text);

    const child = spawn(launch.command, args, {
      cwd: scratchDir(),
      env: {
        ...process.env,
        PATH: unixPath(),
        HOME: homedir(),
        CURSOR_INVOKED_AS: "agent",
      },
    });

    let lineBuffer = "";
    let stderr = "";
    let turnAnswer = "";

    const applyDelta = (delta: string) => {
      const merged = mergeAssistantText(turnAnswer, delta);
      if (merged === turnAnswer) return;
      textRef.current =
        textRef.current.slice(0, textRef.current.length - turnAnswer.length) + merged;
      turnAnswer = merged;
      setAnswer(merged);
      setAwaitingAnswer(false);
      setMarkdown(textRef.current);
    };

    const handleLine = (raw: string) => {
      // A killed child keeps draining buffered stdout. Writing here after the
      // effect is torn down would splice this turn's text into the transcript
      // the next request has already started building.
      if (cancelled) return;
      const line = raw.trim();
      if (!line) return;
      let event: AgentEvent;
      try {
        event = JSON.parse(line) as AgentEvent;
      } catch {
        return;
      }

      const sid = eventSessionId(event);
      if (sid) setSessionId(sid);

      const delta = assistantDelta(event);
      if (delta) {
        applyDelta(delta);
        return;
      }

      const label = toolLabel(event);
      if (label) {
        setActivity(label);
        return;
      }

      if (event.type === "result" && event.is_error) {
        fail(event.result || "Agent failed");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const next of lines) handleLine(next);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      fail(err.message);
    });

    child.on("close", (code, signal) => {
      if (cancelled) return;
      if (lineBuffer.trim()) handleLine(lineBuffer);
      setIsLoading(false);
      setAwaitingAnswer(false);
      setActivity(null);
      if (code !== 0 && !turnAnswer) {
        fail(
          stderr.trim() ||
            (signal
              ? `Agent was stopped (${signal})`
              : `Agent exited with code ${code ?? "unknown"}`),
        );
      }
    });

    return () => {
      cancelled = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      child.once("close", () => clearTimeout(timer));
    };
  }, [request]);

  // Only runs between launch and the first token, which is the stretch where
  // the view is otherwise empty.
  useEffect(() => {
    if (!awaitingAnswer) return;
    const id = setInterval(() => {
      setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [awaitingAnswer]);

  const askFollowUp = (question: string) => {
    // The resumed session already carries SYSTEM_PROMPT, so the raw question
    // is enough — but only if we really are resuming.
    if (!sessionId) return;
    textRef.current += followUpMarkdown(question);
    setMarkdown(textRef.current);
    setError(null);
    setIsLoading(true);
    setAwaitingAnswer(true);
    setActivity(null);
    setRequest({ text: question, resumeId: sessionId, isFollowUp: true });
  };

  let body: string;
  if (error) {
    // Keep whatever streamed successfully; the error goes underneath it.
    body = `${markdown}\n\n---\n\n### Error\n\n${error}`.trim();
  } else if (awaitingAnswer) {
    const waitingLine = waitingMarkdown(spinnerFrame);
    body = markdown ? `${markdown}\n\n${waitingLine}` : waitingLine;
  } else {
    body = markdown;
  }

  const status = error ? "Error" : isLoading ? activity || "Streaming" : "Done";
  // Without a session id a follow-up would fall back to the CLI's most recent
  // conversation, which may not be this one.
  const canFollowUp = !isLoading && !error && sessionId !== null;

  return (
    <Detail
      isLoading={isLoading}
      markdown={body}
      navigationTitle={`C# Docs · ${status}`}
      actions={
        <ActionPanel>
          {canFollowUp ? (
            <Action.Push
              title="Ask Follow-Up"
              icon={Icon.SpeechBubble}
              shortcut={Keyboard.Shortcut.Common.New}
              target={<FollowUpForm onAsk={askFollowUp} />}
            />
          ) : null}
          <Action.CopyToClipboard title="Copy Answer" content={answer} />
          <Action.Paste title="Paste Answer" content={answer} />
          <Action.CopyToClipboard
            title="Copy Transcript"
            content={markdown}
            shortcut={Keyboard.Shortcut.Common.Copy}
          />
        </ActionPanel>
      }
    />
  );
}

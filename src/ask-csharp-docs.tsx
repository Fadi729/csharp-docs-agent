import {
  Action,
  ActionPanel,
  Detail,
  Form,
  Icon,
  Keyboard,
  LaunchProps,
  useNavigation,
} from "@raycast/api";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { useEffect, useRef, useState } from "react";
import { AGENT_MISSING_MESSAGE, agentEnv, resolveAgentLaunch, scratchDir } from "./cli";
import History from "./history";
import type { HistoryDraft } from "./history-entries";
import { rememberHistory } from "./history-store";
import { ModelPicker } from "./model-picker";
import { DEFAULT_MODEL, loadStoredModel } from "./models";

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
  model: string;
  resumeId?: string;
  isFollowUp?: boolean;
};

type HistoryMeta = {
  id: string;
  question: string;
  answer: string;
  hasAnswer: boolean;
  model: string;
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

function toHistoryDraft(meta: HistoryMeta, markdown: string, model: string): HistoryDraft | null {
  if (!meta.id || !meta.hasAnswer || !markdown.trim()) return null;
  return {
    id: meta.id,
    question: meta.question,
    markdown,
    answer: meta.answer,
    model: model || meta.model,
  };
}

function saveHistory(draft: HistoryDraft | null) {
  if (!draft) return;
  void rememberHistory(draft).catch(() => undefined);
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
  const { push } = useNavigation();
  const prompt = props.arguments?.prompt?.trim() ?? "";
  const [request, setRequest] = useState<AgentRequest | null>(null);
  const [ready, setReady] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
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
  const modelRef = useRef(model);
  const historyRef = useRef<HistoryMeta>({
    id: "",
    question: prompt,
    answer: "",
    hasAnswer: false,
    model: DEFAULT_MODEL,
  });
  modelRef.current = model;

  useEffect(() => {
    let cancelled = false;
    loadStoredModel().then((stored) => {
      if (cancelled) return;
      setModel(stored);
      if (prompt) {
        setRequest({ text: buildAgentPrompt(prompt), model: stored });
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [prompt]);

  useEffect(() => {
    if (!ready) return;
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
      fail(AGENT_MISSING_MESSAGE);
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
      historyRef.current = {
        id: randomUUID(),
        question: prompt,
        answer: "",
        hasAnswer: false,
        model: request.model,
      };
    } else {
      historyRef.current = { ...historyRef.current, answer: "", model: request.model };
    }

    const args = [
      ...launch.prefixArgs,
      "-p",
      "--trust",
      "--mode",
      "ask",
      "--model",
      request.model || DEFAULT_MODEL,
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
      env: agentEnv(),
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
      historyRef.current = { ...historyRef.current, answer: merged, hasAnswer: true };
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
      saveHistory(toHistoryDraft(historyRef.current, textRef.current, modelRef.current));
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
      // Closing the command unloads this view. The close handler bails out once
      // `cancelled` is set, so the transcript has to be stored here too.
      saveHistory(toHistoryDraft(historyRef.current, textRef.current, modelRef.current));
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      child.once("close", () => clearTimeout(timer));
    };
  }, [request, ready]);

  // Only runs between launch and the first token, which is the stretch where
  // the view is otherwise empty.
  useEffect(() => {
    if (!awaitingAnswer) return;
    const id = setInterval(() => {
      setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [awaitingAnswer]);

  const openHistory = () => {
    const draft = toHistoryDraft(historyRef.current, textRef.current, modelRef.current);
    const stored = draft ? rememberHistory(draft) : Promise.resolve();
    void stored.finally(() => push(<History />)).catch(() => undefined);
  };

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
    setRequest({ text: question, resumeId: sessionId, isFollowUp: true, model });
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
      navigationTitle={`C# Docs · ${model} · ${status}`}
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
          <Action.Push
            title={`Change Model (${model})`}
            icon={Icon.Switch}
            shortcut={{ modifiers: ["cmd"], key: "m" }}
            target={<ModelPicker selected={model} onSelect={setModel} />}
          />
          <Action
            title="View History"
            icon={Icon.Clock}
            shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
            onAction={openHistory}
          />
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

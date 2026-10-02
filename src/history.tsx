import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Detail,
  Icon,
  Keyboard,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { clearHistory, deleteHistoryEntry, loadHistory } from "./history-store";
import type { HistoryEntry } from "./history-entries";

function historyTitle(question: string): string {
  return question.replace(/\s+/g, " ").trim();
}

function HistoryDetail({ entry, onDelete }: { entry: HistoryEntry; onDelete: (id: string) => void }) {
  const { pop } = useNavigation();

  return (
    <Detail
      navigationTitle={historyTitle(entry.question)}
      markdown={entry.markdown}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Answer" content={entry.answer || entry.markdown} />
          <Action.CopyToClipboard
            title="Copy Transcript"
            content={entry.markdown}
            shortcut={Keyboard.Shortcut.Common.Copy}
          />
          <Action
            title="Delete Answer"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={Keyboard.Shortcut.Common.Remove}
            onAction={() => {
              onDelete(entry.id);
              pop();
            }}
          />
        </ActionPanel>
      }
    />
  );
}

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadHistory()
      .then((items) => {
        if (!cancelled) setEntries(items);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = (id: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
    void deleteHistoryEntry(id)
      .then(() => showToast({ style: Toast.Style.Success, title: "Removed from history" }))
      .catch(() => {
        void loadHistory().then(setEntries);
        void showToast({ style: Toast.Style.Failure, title: "Couldn't remove that answer" });
      });
  };

  const clear = async () => {
    const confirmed = await confirmAlert({
      title: "Clear history?",
      message: "Saved questions and answers will be removed from this Mac.",
      primaryAction: { title: "Clear History", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    setEntries([]);
    try {
      await clearHistory();
      await showToast({ style: Toast.Style.Success, title: "History cleared" });
    } catch {
      setEntries(await loadHistory());
      await showToast({ style: Toast.Style.Failure, title: "Couldn't clear history" });
    }
  };

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={entries.length > 0}
      navigationTitle="C# Docs History"
      searchBarPlaceholder="Search saved questions and answers"
    >
      {!isLoading && entries.length === 0 ? (
        <List.EmptyView
          icon={Icon.Clock}
          title="No saved answers"
          description="Ask a question with C# Docs. The conversation is kept here after you close it."
        />
      ) : (
        entries.map((entry) => (
          <List.Item
            key={entry.id}
            title={historyTitle(entry.question)}
            icon={Icon.SpeechBubble}
            keywords={[entry.markdown]}
            accessories={[{ date: new Date(entry.updatedAt) }, { tag: entry.model }]}
            detail={
              <List.Item.Detail
                markdown={entry.markdown}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="Model" text={entry.model || "—"} />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label
                      title="Saved"
                      text={new Date(entry.updatedAt).toLocaleString()}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.Push
                  title="Open Answer"
                  icon={Icon.Eye}
                  target={<HistoryDetail entry={entry} onDelete={remove} />}
                />
                <Action.CopyToClipboard title="Copy Answer" content={entry.answer || entry.markdown} />
                <Action.CopyToClipboard
                  title="Copy Transcript"
                  content={entry.markdown}
                  shortcut={Keyboard.Shortcut.Common.Copy}
                />
                <ActionPanel.Section>
                  <Action
                    title="Delete Answer"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={Keyboard.Shortcut.Common.Remove}
                    onAction={() => remove(entry.id)}
                  />
                  <Action
                    title="Clear History"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
                    onAction={() => void clear()}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}

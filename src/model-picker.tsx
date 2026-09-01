import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { fetchAllowedModels, saveStoredModel, type CursorModel } from "./models";

export function ModelPicker({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: string) => void;
}) {
  const { pop } = useNavigation();
  const [models, setModels] = useState<CursorModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchAllowedModels()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const select = async (id: string) => {
    await saveStoredModel(id);
    onSelect(id);
    await showToast({ style: Toast.Style.Success, title: `Using ${id}` });
    pop();
  };

  return (
    <List
      isLoading={isLoading}
      navigationTitle="Select Model"
      searchBarPlaceholder="Search models allowed by the Cursor CLI"
      selectedItemId={models.some((model) => model.id === selected) ? selected : undefined}
    >
      {error ? (
        <List.EmptyView icon={Icon.Warning} title="Couldn't load models" description={error} />
      ) : (
        models.map((model) => {
          const accessories: List.Item.Accessory[] = [];
          if (model.id === selected) {
            accessories.push({ tag: { value: "Selected", color: Color.Green } });
          }
          if (model.isDefault) accessories.push({ tag: { value: "Default" } });
          if (model.isCurrent) accessories.push({ text: "CLI current" });
          return (
            <List.Item
              key={model.id}
              id={model.id}
              title={model.title}
              subtitle={model.title === model.id ? undefined : model.id}
              icon={model.id === selected ? Icon.CheckCircle : Icon.Stars}
              keywords={[model.id, model.title]}
              accessories={accessories}
              actions={
                <ActionPanel>
                  <Action title="Use Model" icon={Icon.Check} onAction={() => select(model.id)} />
                </ActionPanel>
              }
            />
          );
        })
      )}
    </List>
  );
}

import { api } from "@/api/client";
import ToolInstall, { useToolsState, type ToolActions } from "@/components/ToolInstall";

const ACTIONS: ToolActions = {
  install: (_id, device) => api.ttsChatterboxInstall(device),
  cancel: () => api.ttsChatterboxCancel(),
  remove: () => api.ttsChatterboxRemove(),
};

/** Установка Chatterbox: собственный Python с нужными ему версиями torch и transformers. */
export default function ChatterboxPanel() {
  const { state, reload } = useToolsState(api.ttsChatterbox);
  return <ToolInstall id="chatterbox" state={state} reload={reload} actions={ACTIONS} />;
}

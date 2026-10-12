import type { M3eEditorProps } from "@/pages/myspace/m3e/useM3eEditor";
export type { M3eEditorHandle, M3eEditorProps } from "@/pages/myspace/m3e/useM3eEditor";
import { useM3eEditor } from "@/pages/myspace/m3e/useM3eEditor";
import M3eEditorView from "@/pages/myspace/m3e/M3eEditorView";

export default function Editor({
  initialLang: initialUiLang,
  onLangChange,
  pageId,
  initialDoc,
  onDocChange,
  initialFocusFrame,
  handleRef,
  onReady,
}: M3eEditorProps) {
  const c = useM3eEditor({
    initialLang: initialUiLang,
    onLangChange,
    pageId,
    initialDoc,
    onDocChange,
    initialFocusFrame,
    handleRef,
    onReady,
  });
  return <M3eEditorView c={c} />;
}

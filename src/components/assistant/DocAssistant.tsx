import { useCallback, useEffect, useMemo, useRef } from "react";
import AssistantPane from "@/components/assistant/AssistantPane";
import type { DocAdapter } from "@/lib/assistant/types";
import { sheetAdapter } from "@/pages/sheet/assistant";
import type { SheetCx } from "@/pages/sheet/types";
import { wordAdapter, type AsstCx } from "@/pages/word/assistant";

/** Запросы для пустой беседы; английский текст — ключ перевода. */
const WORD_QUICK = [
  "Summarize this document",
  "Fix spelling and grammar in the whole document",
  "Make the selected text shorter and clearer",
  "Write a short introduction for this document",
  "Translate the document into English",
];
const SHEET_QUICK = [
  "Explain what this table shows",
  "Add a Total row with formulas",
  "Find the largest and smallest values",
  "Create a chart from this data",
  "Sort the table by the first column",
];

/**
 * Панель помощника Word: адаптер собирается один раз на документ, а актуальный контекст страницы
 * берётся через ссылку — состояние документа меняется, пока агент работает.
 */
export function WordAssistant({ cx, onClose }: { cx: AsstCx; onClose: () => void }) {
  const ref = useRef(cx);
  useEffect(() => {
    ref.current = cx;
  });
  const getCx = useCallback(() => ref.current, []);
  const adapter = useMemo<DocAdapter>(() => wordAdapter(getCx, cx.lang), [getCx, cx.lang]);
  return (
    <AssistantPane
      getAdapter={() => adapter}
      docId={`word:${cx.ui.docName || cx.docId}`}
      tw={cx.tw}
      quick={WORD_QUICK}
      onClose={onClose}
    />
  );
}

export function SheetAssistant({ cx, onClose }: { cx: SheetCx; onClose: () => void }) {
  const ref = useRef(cx);
  useEffect(() => {
    ref.current = cx;
  });
  const getCx = useCallback(() => ref.current, []);
  const adapter = useMemo<DocAdapter>(() => sheetAdapter(getCx, cx.lang), [getCx, cx.lang]);
  return (
    <AssistantPane
      getAdapter={() => adapter}
      docId={`sheet:${cx.ui.docName || cx.docId}`}
      tw={cx.tw}
      quick={SHEET_QUICK}
      onClose={onClose}
    />
  );
}

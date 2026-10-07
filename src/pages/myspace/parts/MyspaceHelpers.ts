/**
 * Выделено из MyspacePage.tsx при разбиении крупного файла (поведение не менялось).
 */
import type { VaultBacklink } from "@/api/types";
import React from "react";
import { type TranslateFn } from "@/app/i18n";

// rAF-хэндл синхронного скролла редактор/превью (см. syncScroll ниже).
declare global {
  interface Window {
    _msSyncRaf?: number;
  }
}

export type Side = "explorer" | "search" | "tags";
export type Right = "backlinks" | "outline" | "graph";
export interface OFile {
  path: string;
  name: string;
  content: string;
  frontmatter: Record<string, string>;
  outline: { level: number; text: string; line: number }[];
  backlinks: VaultBacklink[];
  modified: boolean;
}
export function dirname(p: string) {
  const a = p.replace(/\\/g, "/").split("/");
  a.pop();
  return a.join("/");
}
export const viewTabStyle = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 14px",
  borderRadius: 8,
  fontSize: 12,
  fontWeight: active ? 600 : 400,
  background: active ? "var(--glass)" : "transparent",
  border: "1px solid var(--glass-border)",
  color: active ? "var(--text-primary)" : "var(--text-secondary)",
  cursor: "pointer",
  transition: "all 0.15s",
});

/**
 * Коды ошибок сервера (notes_ai_*) → подсказка на языке интерфейса.
 * Как в панели лекций: «нет ключа», «нет модели» и «нет исходника» — разные
 * советы пользователю, и одна общая строка здесь была бы бесполезной.
 */
export function notesAiError(msg: string, t: TranslateFn) {
  if (/notes_ai_not_configured/.test(msg))
    return t("myspace.ai.errKey", { provider: msg.split(": ")[1] || "" });
  if (/notes_ai_provider_unknown/.test(msg))
    return t("myspace.ai.errProvider", { provider: msg.split(": ")[1] || "" });
  if (/notes_ai_model_missing/.test(msg)) return t("myspace.ai.errModel");
  if (/notes_ai_no_source/.test(msg)) return t("myspace.ai.errNoSource");
  if (/notes_ai_empty_note/.test(msg)) return t("myspace.ai.errEmptyNote");
  if (/notes_ai_too_long/.test(msg)) return t("myspace.ai.errTooLong");
  if (/notes_ai_short_output/.test(msg)) return t("myspace.ai.errShortOutput");
  if (/notes_ai_empty_response/.test(msg)) return t("myspace.ai.errEmpty");
  if (/HTTP \d+/.test(msg)) return t("myspace.ai.errServer", { code: msg.replace(/^HTTP\s+/, "") });
  return msg || t("myspace.ai.errGeneric");
}

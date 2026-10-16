/**
 * API страницы «Документы» (server/ts/routes/word.ts): редактор на ядре WordCraft.
 * Все вызовы редактирования возвращают свежее состояние (страницы, каретка, выделение, форматирование).
 */
import { req, multipart, blobGet } from "@/api/apiHttp";

export interface WordPageInfo {
  w: number;
  h: number;
  number: number;
  body: { x: number; y: number; w: number; h: number };
}

export interface WordRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Свойства символа под кареткой (поля CharProps ядра; пустое поле — наследуется). */
export interface WordCharProps {
  font?: string | null;
  size?: number | null;
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: string | null;
  strike?: boolean | null;
  color?: unknown;
  highlight?: string | null;
  vertAlign?: string | null;
  style?: string | null;
  [key: string]: unknown;
}

export interface WordParaProps {
  align?: string | null;
  style?: string | null;
  list?: unknown;
  [key: string]: unknown;
}

export interface WordState {
  pages: WordPageInfo[];
  caret: { page: number; x: number; top: number; height: number } | null;
  selection: {
    collapsed: boolean;
    rects: WordRect[];
    text: string;
  };
  typing: WordCharProps;
  para: WordParaProps | null;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  dirty: boolean;
  words: number;
  rev: number;
}

export interface WordStatus {
  available: boolean;
  bin: string | null;
  searched: string[];
  sessions: number;
}

export interface WordOpened {
  id: string;
  state: WordState;
  name?: string;
}

export interface WordCommand {
  id: string;
  label: string;
  location: string;
  shortcut: string;
  params: string;
  mutates: boolean;
}

export const wordApi = {
  wordStatus: () => req<WordStatus>("GET", "/word/status"),
  wordNew: (template = "blank") => req<WordOpened>("POST", "/word/sessions", { template }),
  wordOpen: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return multipart<WordOpened>("/word/open", fd);
  },
  wordClose: (id: string) => req<{ ok: boolean }>("DELETE", `/word/sessions/${id}`),
  wordState: (id: string) => req<WordState>("GET", `/word/${id}/state`),
  wordClick: (
    id: string,
    body: { page: number; x: number; y: number; extend?: boolean; count?: number },
  ) => req<WordState>("POST", `/word/${id}/click`, body),
  wordKey: (id: string, body: { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean }) =>
    req<WordState>("POST", `/word/${id}/key`, body),
  wordType: (id: string, text: string) => req<WordState>("POST", `/word/${id}/type`, { text }),
  wordRun: (id: string, command: string, params: Record<string, unknown> = {}) =>
    req<{ result: unknown; state: WordState }>("POST", `/word/${id}/run`, { command, params }),
  wordCommands: (id: string) => req<WordCommand[]>("GET", `/word/${id}/commands`),
  /** Страница как PNG (токен в заголовке — <img src> его передать не может). */
  wordPage: (id: string, n: number, scale: number) =>
    blobGet(`/word/${id}/page/${n}?scale=${scale.toFixed(2)}`),
  wordExport: (id: string, format: string, name: string) =>
    blobGet(`/word/${id}/export?format=${format}&name=${encodeURIComponent(name)}`),
};

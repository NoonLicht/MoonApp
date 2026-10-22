import {
  commandTools,
  describeResult,
  str,
  webTools,
} from "@/lib/assistant/sharedTools";
import type { AssistantTool, DocAdapter, ExecResult } from "@/lib/assistant/types";

/**
 * Что помощнику нужно от страницы PDF: чтение документа (текст страниц, поиск, сведения) и команды интерфейса
 * редактора. Всё идёт в рамку PdfCraft (native/office-web: pdfcraft embed.rs). Текст страниц редактор отдаёт
 * только для PDF с текстовым слоем; у сканов он пустой.
 */
export interface AsstPdfCx {
  docId: string;
  lang: string;
  tw: (en: string, vars?: Record<string, string | number>) => string;
  s: { pages: number; page: number };
  ui: { docName: string };
  /** Операция рамки (`text`, `find`, `info`) или метод канала управления (`ui.state`, …). */
  query: <T = unknown>(method: string, p?: unknown) => Promise<T | undefined>;
  /** Операция редактора: `ui.command`, `ui.set`, `ui.click`… с обновлением состояния после неё. */
  exec: (cmd: string, p?: Record<string, unknown>) => Promise<ExecResult>;
  /** Операция самой рамки (не команда интерфейса): `text`, `find`, `info`. */
  frame: <T = unknown>(op: "text" | "find" | "info", p?: Record<string, unknown>) => Promise<T>;
}

interface TextReply {
  pages: number;
  chunks: Array<{ page: number; text: string }>;
  truncated: boolean;
}

const int = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

const compact = (v: unknown, max: number): string => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > max ? `${t.slice(0, max)}…[cut]` : t;
};

const chunksText = (r: TextReply): string => {
  const body = r.chunks
    .map((c) => `--- Page ${c.page} ---\n${c.text || "(no text on this page: it may be a scan)"}`)
    .join("\n\n");
  const last = r.chunks[r.chunks.length - 1]?.page ?? 0;
  return r.truncated ? `${body}\n\n[cut after page ${last} of ${r.pages}: read the rest with read_pages]` : body;
};

/** `getCx` отдаёт актуальный контекст страницы: пока агент работает, состояние документа меняется. */
export function pdfAdapter(getCx: () => AsstPdfCx, lang: string): DocAdapter {
  const cx = new Proxy({} as AsstPdfCx, {
    get: (_t, k) => (getCx() as unknown as Record<string | symbol, unknown>)[k],
  });
  const ok = async (cmd: string, p: Record<string, unknown> = {}) =>
    describeResult(await cx.exec(cmd, p));

  const tools: AssistantTool[] = [
    {
      group: "read",
      name: "document_info",
      description:
        "Overview of the open PDF: name, page count, title, author, subject, keywords, PDF version, size, whether it is encrypted or read-only.",
      parameters: { type: "object", properties: {} },
      label: () => "Looking at the document",
      run: async () => compact(await cx.frame("info"), 2000),
    },
    {
      group: "read",
      name: "read_pages",
      description:
        "Read the text of pages from `from` to `to` (numbered from 1; default: the current page for `from`, the same page for `to`). " +
        "Use it to summarize, quote, translate or answer questions about the content. Long ranges are cut: read on from the page where it stopped.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "number", description: "first page, from 1 (default: the current page)" },
          to: { type: "number", description: "last page (default: the same as from)" },
        },
      },
      label: (a) => `Reading page${a.to && int(a.to) !== int(a.from) ? "s" : ""} ${str(a.from) || "…"}`,
      run: async (a) => {
        const from = a.from === undefined || a.from === "" ? cx.s.page : int(a.from, 1);
        const to = a.to === undefined || a.to === "" ? from : int(a.to, from);
        return chunksText(await cx.frame<TextReply>("text", { from, to }));
      },
    },
    {
      group: "read",
      name: "read_document",
      description: "Read the text of the whole PDF from the first page (long documents are cut: continue with read_pages).",
      parameters: { type: "object", properties: {} },
      label: () => "Reading the document",
      run: async () => chunksText(await cx.frame<TextReply>("text", { from: 1, max: 14000 })),
    },
    {
      group: "read",
      name: "find_text",
      description:
        "Find lines containing a phrase (case-insensitive) in the whole PDF. Returns page numbers (from 1) and the matching lines.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number", description: "at most this many matches (default 30)" } },
        required: ["query"],
      },
      label: (a) => `Searching: ${str(a.query).slice(0, 60)}`,
      run: async (a) => {
        const r = await cx.frame<{ matches: Array<{ page: number; line: string }> }>("find", {
          query: str(a.query),
          limit: a.limit ? int(a.limit, 30) : 30,
        });
        return r.matches.length
          ? r.matches.map((m) => `p.${m.page}: ${m.line}`).join("\n")
          : "No matches.";
      },
    },
    {
      group: "edit",
      name: "go_to_page",
      description: "Show a page of the PDF in the editor (number from 1).",
      parameters: { type: "object", properties: { page: { type: "number" } }, required: ["page"] },
      label: (a) => `Going to page ${str(a.page)}`,
      run: async (a) => {
        const n = int(a.page, 1);
        if (n < 1 || n > cx.s.pages) throw new Error(`no page ${n}: the document has ${cx.s.pages} pages`);
        return ok("ui.set", { key: "page", value: String(n) });
      },
    },
    ...commandTools(
      "pdf",
      () => cx.docId,
      (c, p) => cx.exec(c, p),
      async () => {
        const r = await cx.exec("ui.commands", {});
        if (!r.ok || !Array.isArray(r.result)) throw new Error(r.ok ? "no command list" : r.error);
        return (r.result as Array<Record<string, unknown>>).map((c) => ({
          id: str(c.id),
          label: str(c.label ?? c.title ?? c.name),
        }));
      },
    ),
    ...webTools(lang),
  ];

  return {
    kind: "pdf",
    system:
      "You are an assistant built into a PDF reader and editor. You work on the open PDF through tools. " +
      "You can read it (document_info, read_pages, read_document, find_text), show a page (go_to_page) and run editor commands (find_commands, then run_command with the command id and no parameters). " +
      "Pages are numbered from 1. Read the text before you answer about the content, and say which pages you rely on. " +
      "If a page has no text it is probably a scan: say so instead of guessing. " +
      "You cannot change the text of a page yourself: for edits, rotating, deleting or reordering pages, comments, forms, protection and the like find the matching command with find_commands and run it. " +
      "Do not run a command the user did not ask for. When the user asks for facts outside the document, use web_search and open_page and mention the source links.",
    tools,
    context: () => `PDF: ${cx.ui.docName}. ${cx.s.pages} page(s); the current one is ${cx.s.page}.`,
    snapshot: async (max) => chunksText(await cx.frame<TextReply>("text", { from: 1, max })),
    setPictureSink: () => undefined,
    insert: async () => undefined,
  };
}

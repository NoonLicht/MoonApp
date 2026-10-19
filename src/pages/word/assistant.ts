import {
  commandTools,
  describeResult,
  imageTool,
  partialNumber,
  partialString,
  str,
  webTools,
} from "@/lib/assistant/sharedTools";
import type { AssistantTool, DocAdapter, LiveWrite } from "@/lib/assistant/types";
import type { Cx } from "@/pages/word/ribbon/types";

interface Block {
  index: number;
  type: string;
  style?: string;
  text: string;
  /** Длина в байтах UTF-8: ядро считает смещения именно так. */
  len: number;
}

const body = (path: number, off: number) => ({ story: "body", path: [path], off });

async function blocks(cx: Cx): Promise<Block[]> {
  const r = await cx.query<{ blocks: Block[] }>("document.inspect", {});
  return (r?.blocks ?? []).filter((b) => b.type === "paragraph");
}

const HEADING = /^(title|subtitle|heading|заголовок)/i;

function render(
  list: Block[],
  from: number,
  to: number,
  limit: number,
): { text: string; next: number | null } {
  const out: string[] = [];
  let size = 0;
  for (const b of list) {
    if (b.index < from || b.index > to) continue;
    const line = `[${b.index}]${b.style && b.style !== "Normal" && HEADING.test(b.style) ? ` (${b.style})` : ""} ${b.text}`;
    if (size + line.length > limit && out.length) return { text: out.join("\n"), next: b.index };
    out.push(line);
    size += line.length + 1;
  }
  return { text: out.join("\n"), next: null };
}

/** Набрать текст в каретке: каждая строка — отдельный абзац (text.insert сам переносы строк не делит). */
async function typeLines(cx: Cx, text: string): Promise<void> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) describeResult(await cx.exec("text.newParagraph"));
    if (lines[i]) describeResult(await cx.exec("text.insert", { text: lines[i] }));
  }
}

/** Абзац, в котором стоит каретка (по свежему снимку ядра, а не по состоянию страницы). */
async function caretBlock(cx: Cx): Promise<Block> {
  const r = await cx.query<{ blocks: Block[]; selection: { focus: { path: number[] } } }>(
    "document.inspect",
    {},
  );
  const idx = r?.selection?.focus.path[0] ?? 0;
  return (
    (r?.blocks ?? []).find((b) => b.index === idx) ?? {
      index: idx,
      type: "paragraph",
      text: "",
      len: 0,
    }
  );
}

async function paragraph(cx: Cx, n: unknown): Promise<Block> {
  const idx = Number(n);
  const b = (await blocks(cx)).find((x) => x.index === idx);
  if (!Number.isInteger(idx) || !b)
    throw new Error(`no paragraph ${str(n)} (read the document to see numbers)`);
  return b;
}

/**
 * Куда ставить каретку перед вводом текста. Возвращает «хвост», который нужно набрать после текста
 * (для вставки в начало — перенос строки, чтобы прежний первый абзац не склеился с новым).
 */
async function placeCaret(cx: Cx, where: string, para: unknown): Promise<string> {
  if (where === "end") {
    describeResult(await cx.exec("caret.docEnd"));
    const list = await blocks(cx);
    if (list.length && list[list.length - 1].text)
      describeResult(await cx.exec("text.newParagraph"));
  } else if (where === "start") {
    describeResult(await cx.exec("caret.docStart"));
    return "\n";
  } else if (where === "after_paragraph") {
    const b = await paragraph(cx, para);
    describeResult(
      await cx.exec("select.range", { anchor: body(b.index, b.len), focus: body(b.index, b.len) }),
    );
    describeResult(await cx.exec("text.newParagraph"));
  }
  return "";
}

/**
 * Живая запись текста: пока модель пишет аргументы вызова, текст уже набирается в документе.
 * `locate` вызывается один раз, когда из аргументов известно место; возвращает хвост для конца.
 * Пока место неизвестно (модель ещё не написала `where`), документ не трогаем: обычный `run` сделает всё сам.
 */
function liveWriter(
  cx: Cx,
  ready: (raw: string) => boolean,
  locate: (raw: string) => Promise<string>,
  signal?: AbortSignal,
  /** Модель прислала пустой текст: например, замена абзаца на «ничего» должна стереть выделенное. */
  onEmpty?: () => Promise<void>,
): LiveWrite {
  let state: "idle" | "placing" | "on" = "idle";
  let typed = "";
  let target = "";
  let tail = "";
  let failure: Error | null = null;
  let chain: Promise<void> = Promise.resolve();
  const pump = (): void => {
    chain = chain.then(async () => {
      if (failure || signal?.aborted || state !== "on") return;
      const want = target;
      if (want.length <= typed.length || !want.startsWith(typed)) return;
      const chunk = want.slice(typed.length);
      typed = want;
      try {
        await typeLines(cx, chunk);
      } catch (e) {
        failure = e as Error;
      }
    });
  };
  return {
    push: (raw) => {
      const t = partialString(raw, "text");
      if (!t) return;
      target = t.text;
      if (state === "idle" && ready(raw)) {
        state = "placing";
        chain = chain.then(async () => {
          try {
            tail = await locate(raw);
            state = "on";
          } catch (e) {
            failure = e as Error;
            state = "idle";
          }
        });
      }
      pump();
    },
    started: () => state !== "idle",
    finish: async (args) => {
      const full = str(args.text);
      target = full;
      pump();
      await chain;
      if (failure) throw failure;
      if (full.length > typed.length && full.startsWith(typed)) {
        await typeLines(cx, full.slice(typed.length));
        typed = full;
      }
      if (!full && onEmpty) await onEmpty();
      if (tail) await typeLines(cx, tail);
      return `Wrote ${full.split("\n").length} paragraph(s).`;
    },
  };
}

/** `getCx` отдаёт актуальный контекст страницы: пока агент работает, состояние документа меняется. */
export function wordAdapter(getCx: () => Cx, lang: string): DocAdapter {
  const cx = new Proxy({} as Cx, {
    get: (_t, k) => (getCx() as unknown as Record<string | symbol, unknown>)[k],
  });
  const sink: { fn: ((url: string) => void) | null } = { fn: null };
  const read = async (from = 0, to = 1e9, limit = 9000): Promise<string> => {
    const list = await blocks(cx);
    if (!list.length) return "(the document is empty)";
    const r = render(list, from, to, limit);
    const last = list[list.length - 1].index;
    return `Paragraphs 0–${last}.\n${r.text}${r.next !== null ? `\n[continues: call read_document with from=${r.next}]` : ""}`;
  };

  const tools: AssistantTool[] = [
    {
      group: "read",
      name: "read_document",
      description:
        "Read the document text. Every paragraph is shown as [number] text; numbers are what the editing tools expect. Long documents are returned in parts: pass `from` to continue.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "number", description: "first paragraph number (default 0)" },
          to: { type: "number", description: "last paragraph number (default: end)" },
        },
      },
      label: () => "Reading the document",
      run: (a) => read(Number(a.from) || 0, a.to === undefined ? 1e9 : Number(a.to)),
    },
    {
      group: "read",
      name: "get_selection",
      description: "Get the text the user has selected and the paragraph where the caret is.",
      parameters: { type: "object", properties: {} },
      label: () => "Reading the selection",
      run: async () => {
        const sel = cx.s.selection;
        const para = sel?.focus.path[0];
        return sel && !sel.collapsed
          ? `Selected text (paragraph ${para}):\n${sel.text}`
          : `Nothing is selected. Caret is in paragraph ${para ?? 0}.`;
      },
    },
    {
      group: "edit",
      name: "insert_text",
      description:
        "Insert new text. Each line becomes its own paragraph. `where`: cursor (at the caret, replaces a selection), end (after the last paragraph), start (before the first), after_paragraph (needs `paragraph`). To add paragraphs after the existing text use where=end (cursor glues the text to the caret). Put ALL the text in ONE call and write `where` (and `paragraph`) BEFORE `text`.",
      parameters: {
        type: "object",
        properties: {
          where: { type: "string", enum: ["cursor", "end", "start", "after_paragraph"] },
          paragraph: { type: "number", description: "paragraph number for after_paragraph" },
          text: { type: "string", description: "text to insert; use \\n between paragraphs" },
        },
        required: ["where", "text"],
      },
      label: () => "Writing to the document",
      live: (signal) =>
        liveWriter(
          cx,
          (raw) => {
            const w = partialString(raw, "where");
            return (
              !!w?.done &&
              (w.text !== "after_paragraph" || partialNumber(raw, "paragraph") !== null)
            );
          },
          (raw) =>
            placeCaret(
              cx,
              partialString(raw, "where")?.text ?? "cursor",
              partialNumber(raw, "paragraph"),
            ),
          signal,
        ),
      run: async (a) => {
        const text = str(a.text);
        const tail = await placeCaret(cx, str(a.where) || "cursor", a.paragraph);
        await typeLines(cx, text + tail);
        return `Inserted ${text.split("\n").length} paragraph(s).`;
      },
    },
    {
      group: "edit",
      name: "insert_table",
      description:
        "Insert a real table (Word table element, not text with | signs). `rows` is a list of rows, each row a list of cell texts; the first row is the header. All rows get the same number of cells. `where` as in insert_text. Write `where` BEFORE `rows`.",
      parameters: {
        type: "object",
        properties: {
          where: { type: "string", enum: ["cursor", "end", "start", "after_paragraph"] },
          paragraph: { type: "number", description: "paragraph number for after_paragraph" },
          rows: {
            type: "array",
            description: 'rows of cells, e.g. [["Name","Size"],["A","7B"]]',
            items: { type: "array", items: { type: "string" } },
          },
        },
        required: ["where", "rows"],
      },
      label: () => "Inserting a table",
      run: async (a) => {
        const grid = (Array.isArray(a.rows) ? a.rows : []).slice(0, 60).map((r) =>
          (Array.isArray(r) ? r : [r]).slice(0, 12).map((c) =>
            str(c)
              .replace(/[\t\r\n]+/g, " ")
              .trim(),
          ),
        );
        const cols = Math.max(0, ...grid.map((r) => r.length));
        if (!grid.length || !cols)
          throw new Error("rows must be a non-empty list of lists of strings");
        const lines = grid.map((r) => [...r, ...Array(cols - r.length).fill("")].join("\t"));
        await placeCaret(cx, str(a.where) || "cursor", a.paragraph);
        // Таблица собирается из набранных строк (ячейки разделены табами): так получается настоящая таблица Word.
        let at = await caretBlock(cx);
        if (at.text) {
          describeResult(await cx.exec("text.newParagraph"));
          at = await caretBlock(cx);
        }
        await typeLines(cx, lines.join("\n"));
        const last = new TextEncoder().encode(lines[lines.length - 1]).length;
        describeResult(
          await cx.exec("select.range", {
            anchor: body(at.index, 0),
            focus: body(at.index + lines.length - 1, last),
          }),
        );
        describeResult(await cx.exec("table.fromText", { separator: "tab" }));
        return `Table ${grid.length}x${cols} inserted.`;
      },
    },
    {
      group: "edit",
      name: "replace_paragraph",
      description:
        "Replace the whole text of one paragraph (keeps its style). Empty text deletes the text, not the paragraph.",
      parameters: {
        type: "object",
        properties: {
          paragraph: { type: "number", description: "paragraph number from read_document" },
          text: { type: "string", description: "new text; extra lines become new paragraphs" },
        },
        required: ["paragraph", "text"],
      },
      label: (a) => `Rewriting paragraph: ${str(a.paragraph)}`,
      live: (signal) => {
        let len = 0;
        return liveWriter(
          cx,
          (raw) => partialNumber(raw, "paragraph") !== null,
          async (raw) => {
            const b = await paragraph(cx, partialNumber(raw, "paragraph"));
            len = b.len;
            describeResult(
              await cx.exec("select.range", {
                anchor: body(b.index, 0),
                focus: body(b.index, b.len),
              }),
            );
            return "";
          },
          signal,
          async () => {
            if (len) describeResult(await cx.exec("text.delete"));
          },
        );
      },
      run: async (a) => {
        const b = await paragraph(cx, a.paragraph);
        describeResult(
          await cx.exec("select.range", { anchor: body(b.index, 0), focus: body(b.index, b.len) }),
        );
        const text = str(a.text);
        if (!text) {
          if (b.len) describeResult(await cx.exec("text.delete"));
        } else await typeLines(cx, text);
        return `Paragraph ${b.index} replaced.`;
      },
    },
    {
      group: "edit",
      name: "delete_paragraph",
      description: "Delete a paragraph completely.",
      parameters: {
        type: "object",
        properties: { paragraph: { type: "number", description: "paragraph number" } },
        required: ["paragraph"],
      },
      label: (a) => `Deleting paragraph: ${str(a.paragraph)}`,
      limit: 3,
      run: async (a) => {
        const b = await paragraph(cx, a.paragraph);
        describeResult(
          await cx.exec("select.range", { anchor: body(b.index, 0), focus: body(b.index, 0) }),
        );
        describeResult(await cx.exec("select.paragraph"));
        describeResult(await cx.exec("text.delete"));
        return `Paragraph ${b.index} deleted. Later paragraphs moved up by one (the old ${b.index + 1} is now ${b.index}). Do not delete again unless the user asked for several paragraphs: read the document first.`;
      },
    },
    {
      group: "edit",
      name: "replace_text",
      description: "Find and replace text everywhere in the document.",
      parameters: {
        type: "object",
        properties: {
          find: { type: "string" },
          replace: { type: "string" },
          match_case: { type: "boolean" },
        },
        required: ["find", "replace"],
      },
      label: (a) => `Replacing: ${str(a.find)}`,
      run: async (a) =>
        describeResult(
          await cx.exec("edit.replaceAll", {
            text: str(a.find),
            with: str(a.replace),
            matchCase: !!a.match_case,
          }),
        ),
    },
    ...commandTools(
      "word",
      () => cx.docId,
      (c, p) => cx.exec(c, p),
    ),
    ...webTools(lang),
    imageTool({
      sink,
      insert: async (data, alt, place) => {
        if (place === "end") {
          describeResult(await cx.exec("caret.docEnd"));
          const list = await blocks(cx);
          if (list.length && list[list.length - 1].text)
            describeResult(await cx.exec("text.newParagraph"));
        }
        describeResult(await cx.exec("insert.picture", { data, width: 324, alt }));
      },
    }),
  ];

  return {
    kind: "word",
    system:
      "You are an assistant built into a word processor. You work on the open document through tools. " +
      "Paragraphs are numbered from 0 as shown by read_document; never invent numbers: read first. " +
      "Use insert_text, replace_paragraph, delete_paragraph and replace_text for text, and insert_table for tables (never draw a table with | characters). " +
      "For formatting, styles, tables, lists, headers, page setup and anything else use find_commands, then run_command (it acts on the current selection: select the text first with run_command select.text {text} or select.paragraph). " +
      "When the user asks for facts, use web_search and open_page and mention the source links; write found facts into the document only when asked.",
    tools,
    context: () => {
      const s = cx.s;
      const sel = s.selection;
      const parts = [`Document: ${cx.ui.docName}, ${s.pages.length} page(s), ${s.words} words.`];
      parts.push(
        sel && !sel.collapsed
          ? `Selection (paragraph ${sel.focus.path[0]}): ${sel.text.slice(0, 600)}`
          : `Caret in paragraph ${sel?.focus.path[0] ?? 0}.`,
      );
      return parts.join("\n");
    },
    snapshot: (max) => read(0, 1e9, max),
    setPictureSink: (fn) => {
      sink.fn = fn;
    },
    insert: async (text) => {
      await typeLines(cx, text);
    },
  };
}

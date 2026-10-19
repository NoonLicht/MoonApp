import { commandTools, describeResult, imageTool, str, webTools } from "@/lib/assistant/sharedTools";
import type { AssistantTool, DocAdapter } from "@/lib/assistant/types";
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

function render(list: Block[], from: number, to: number, limit: number): { text: string; next: number | null } {
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

async function paragraph(cx: Cx, n: unknown): Promise<Block> {
  const idx = Number(n);
  const b = (await blocks(cx)).find((x) => x.index === idx);
  if (!Number.isInteger(idx) || !b) throw new Error(`no paragraph ${str(n)} (read the document to see numbers)`);
  return b;
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
        "Insert new text. Each line becomes its own paragraph. `where`: cursor (at the caret, replaces a selection), end (after the last paragraph), start (before the first), after_paragraph (needs `paragraph`).",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "text to insert; use \\n between paragraphs" },
          where: { type: "string", enum: ["cursor", "end", "start", "after_paragraph"] },
          paragraph: { type: "number", description: "paragraph number for after_paragraph" },
        },
        required: ["text"],
      },
      label: () => "Writing to the document",
      run: async (a) => {
        const text = str(a.text);
        const where = str(a.where) || "cursor";
        if (where === "end") {
          describeResult(await cx.exec("caret.docEnd"));
          const list = await blocks(cx);
          if (list.length && list[list.length - 1].text) describeResult(await cx.exec("text.newParagraph"));
        } else if (where === "start") {
          describeResult(await cx.exec("caret.docStart"));
          await typeLines(cx, `${text}\n`);
          return "Inserted at the start.";
        } else if (where === "after_paragraph") {
          const b = await paragraph(cx, a.paragraph);
          describeResult(
            await cx.exec("select.range", { anchor: body(b.index, b.len), focus: body(b.index, b.len) }),
          );
          describeResult(await cx.exec("text.newParagraph"));
        }
        await typeLines(cx, text);
        return `Inserted ${text.split("\n").length} paragraph(s).`;
      },
    },
    {
      group: "edit",
      name: "replace_paragraph",
      description: "Replace the whole text of one paragraph (keeps its style). Empty text deletes the text, not the paragraph.",
      parameters: {
        type: "object",
        properties: {
          paragraph: { type: "number", description: "paragraph number from read_document" },
          text: { type: "string", description: "new text; extra lines become new paragraphs" },
        },
        required: ["paragraph", "text"],
      },
      label: (a) => `Rewriting paragraph: ${str(a.paragraph)}`,
      run: async (a) => {
        const b = await paragraph(cx, a.paragraph);
        describeResult(await cx.exec("select.range", { anchor: body(b.index, 0), focus: body(b.index, b.len) }));
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
      run: async (a) => {
        const b = await paragraph(cx, a.paragraph);
        describeResult(await cx.exec("select.range", { anchor: body(b.index, 0), focus: body(b.index, 0) }));
        describeResult(await cx.exec("select.paragraph"));
        describeResult(await cx.exec("text.delete"));
        return `Paragraph ${b.index} deleted. Later paragraphs shift up by one.`;
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
          await cx.exec("edit.replaceAll", { text: str(a.find), with: str(a.replace), matchCase: !!a.match_case }),
        ),
    },
    ...commandTools("word", () => cx.docId, (c, p) => cx.exec(c, p)),
    ...webTools(lang),
    imageTool({
      sink,
      insert: async (data, alt) => {
        describeResult(await cx.exec("insert.picture", { data, width: 324, alt }));
      },
    }),
  ];

  return {
    kind: "word",
    system:
      "You are an assistant built into a word processor. You work on the open document through tools. " +
      "Paragraphs are numbered from 0 as shown by read_document; never invent numbers: read first. " +
      "Use insert_text, replace_paragraph, delete_paragraph and replace_text for text. " +
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

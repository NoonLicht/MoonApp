import {
  commandTools,
  describeResult,
  imageTool,
  str,
  webTools,
} from "@/lib/assistant/sharedTools";
import type { AssistantTool, DocAdapter, ExecResult } from "@/lib/assistant/types";

/**
 * Что помощнику нужно от страницы презентаций: команды редактора, состояние (слайды, выделение, глубина отмены)
 * и имя файла. Команды идут в рамку DeckCraft (native/office-web: deckcraft embed.rs).
 */
export interface AsstDeckCx {
  docId: string;
  lang: string;
  tw: (en: string, vars?: Record<string, string | number>) => string;
  s: { slides: number; slide: number };
  ui: { docName: string };
  query: <T = unknown>(method: string, p?: unknown) => Promise<T | undefined>;
  exec: (cmd: string, p?: Record<string, unknown>) => Promise<ExecResult>;
  /** Сколько шагов в истории отмены сейчас (свежее состояние из редактора). */
  undoDepth: () => Promise<number>;
}

const compact = (v: unknown, max: number): string => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > max ? `${t.slice(0, max)}…[cut]` : t;
};

const int = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/** Слайд глазами модели: фигуры с номерами, видом, рамкой и текстом, плюс заметки. */
function slideText(r: Record<string, unknown>, max: number): string {
  const shapes = (Array.isArray(r.shapes) ? r.shapes : []) as Array<Record<string, unknown>>;
  const lines = shapes.map((s) => {
    const box = s.box ?? s.bounds ?? (s.x !== undefined ? [s.x, s.y, s.w, s.h] : undefined);
    const text = typeof s.text === "string" ? s.text.replace(/\s*\n\s*/g, " / ") : "";
    return (
      `- id ${str(s.id)} ${str(s.kind)}${s.name ? ` "${str(s.name)}"` : ""}` +
      (box ? ` box ${JSON.stringify(box)}` : "") +
      (text ? `: ${text}` : "")
    );
  });
  const notes = str(r.notes).trim();
  return [
    `Slide ${int(r.index) + 1}, layout "${str(r.layout)}"${r.hidden ? ", hidden" : ""}`,
    ...(lines.length ? lines : ["(no shapes)"]),
    ...(notes ? [`Notes: ${notes}`] : []),
  ]
    .join("\n")
    .slice(0, max);
}

/** `getCx` отдаёт актуальный контекст страницы: пока агент работает, состояние документа меняется. */
export function deckAdapter(getCx: () => AsstDeckCx, lang: string): DocAdapter {
  const cx = new Proxy({} as AsstDeckCx, {
    get: (_t, k) => (getCx() as unknown as Record<string | symbol, unknown>)[k],
  });
  const sink: { fn: ((url: string) => void) | null } = { fn: null };
  const ok = async (cmd: string, p: Record<string, unknown> = {}) =>
    describeResult(await cx.exec(cmd, p));

  /** Слайд по номеру с 1 (по умолчанию — текущий): перейти к нему и вернуть его номер с 0. */
  const goto = async (n: unknown): Promise<number> => {
    const index = n === undefined || n === "" || n === null ? cx.s.slide : int(n, 1) - 1;
    if (index < 0 || index >= cx.s.slides)
      throw new Error(`no slide ${index + 1}: the presentation has ${cx.s.slides} slides`);
    if (index !== cx.s.slide) await ok("slide.go", { index });
    return index;
  };

  /** Заменить весь текст в фигуре, ячейке или заметках: войти в правку, выделить всё, набрать, выйти. */
  const replaceText = async (edit: Record<string, unknown>, text: string): Promise<void> => {
    await ok("text.edit", edit);
    try {
      await ok("text.selectAll");
      if (text) await ok("text.insert", { text });
      else await ok("edit.delete");
    } finally {
      await cx.exec("text.exit", {});
    }
  };

  const readSlide = async (n?: unknown, max = 3500): Promise<string> => {
    const index = n === undefined || n === "" ? cx.s.slide : int(n, 1) - 1;
    const r = await cx.query<Record<string, unknown>>("slide.inspect", { index });
    return r ? slideText(r, max) : "(no such slide)";
  };

  const outline = async (max: number): Promise<string> => {
    const out: string[] = [];
    let size = 0;
    for (let i = 0; i < cx.s.slides; i++) {
      const t = await readSlide(i + 1, 900);
      size += t.length;
      if (size > max) {
        out.push(`[cut after slide ${i}; read the rest with read_slide]`);
        break;
      }
      out.push(t);
    }
    return out.join("\n\n") || "(empty presentation)";
  };

  const tools: AssistantTool[] = [
    {
      group: "read",
      name: "presentation_info",
      description:
        "Overview of the presentation: slide titles and layouts, slide size, theme and the current selection.",
      parameters: { type: "object", properties: {} },
      label: () => "Looking at the presentation",
      run: async () => {
        const i = await cx.query("document.inspect", {});
        return i ? compact(i, 3500) : "No information.";
      },
    },
    {
      group: "read",
      name: "read_slide",
      description:
        "Read one slide: its shapes with ids, kinds, boxes (in points) and text, and the speaker notes. Slides are numbered from 1; default is the current slide.",
      parameters: {
        type: "object",
        properties: { slide: { type: "number", description: "slide number, from 1" } },
      },
      label: (a) => (a.slide ? `Reading slide ${str(a.slide)}` : "Reading the slide"),
      run: (a) => readSlide(a.slide),
    },
    {
      group: "read",
      name: "read_all_slides",
      description:
        "Read the text of every slide (shapes and notes). Use it to summarize or review the whole deck.",
      parameters: { type: "object", properties: {} },
      label: () => "Reading all slides",
      run: () => outline(9000),
    },
    {
      group: "edit",
      name: "add_slide",
      description:
        "Add a slide. layout: title, titleAndContent, sectionHeader, twoContent, comparison, titleOnly, blank, contentWithCaption, pictureWithCaption. " +
        "title and body fill the placeholders; separate bullet points in body with a newline. `at` is the position from 1 (default: after the current slide).",
      parameters: {
        type: "object",
        properties: {
          layout: { type: "string" },
          title: { type: "string" },
          body: { type: "string", description: "bullet points, one per line" },
          at: { type: "number", description: "position from 1" },
        },
      },
      label: (a) => `Adding a slide${a.title ? `: ${str(a.title).slice(0, 60)}` : ""}`,
      run: async (a) => {
        const p: Record<string, unknown> = {};
        if (a.layout) p.layout = str(a.layout);
        if (a.title) p.title = str(a.title);
        if (a.body) p.body = str(a.body);
        if (a.at) p.at = Math.max(0, int(a.at, 1) - 1);
        return ok("slide.new", p);
      },
    },
    {
      group: "edit",
      name: "set_text",
      description:
        "Replace the whole text of a shape (title, body, text box) with new text; newline starts a new paragraph. Get shape ids from read_slide.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "shape id from read_slide" },
          text: { type: "string" },
          slide: { type: "number", description: "slide number from 1 (default: current)" },
        },
        required: ["id", "text"],
      },
      label: (a) => `Changing text on slide ${str(a.slide) || "…"}`,
      run: async (a) => {
        await goto(a.slide);
        await replaceText({ id: int(a.id) }, str(a.text));
        return "OK";
      },
    },
    {
      group: "edit",
      name: "set_notes",
      description: "Replace the speaker notes of a slide.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          slide: { type: "number", description: "slide number from 1 (default: current)" },
        },
        required: ["text"],
      },
      label: () => "Writing speaker notes",
      run: async (a) => {
        await goto(a.slide);
        await replaceText({ notes: true }, str(a.text));
        return "OK";
      },
    },
    {
      group: "edit",
      name: "add_text_box",
      description:
        "Put a new text box on a slide. rect is [x, y, width, height] in points from the slide's top-left corner (default: a sensible place).",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          rect: { type: "array", items: { type: "number" } },
          slide: { type: "number" },
        },
        required: ["text"],
      },
      label: () => "Adding a text box",
      run: async (a) => {
        await goto(a.slide);
        const p: Record<string, unknown> = { text: str(a.text) };
        if (Array.isArray(a.rect) && a.rect.length === 4) p.rect = a.rect.map(Number);
        return ok("insert.textBox", p);
      },
    },
    {
      group: "edit",
      name: "add_table",
      description:
        "Insert a table on a slide and fill it. `cells` is a 2D array of rows (the first row is the header). Rows and columns are taken from it.",
      parameters: {
        type: "object",
        properties: {
          cells: {
            type: "array",
            items: { type: "array", items: {} },
            description: "rows of cell texts",
          },
          slide: { type: "number" },
        },
        required: ["cells"],
      },
      label: () => "Adding a table",
      run: async (a) => {
        const rows = (Array.isArray(a.cells) ? a.cells : []).map((r) => (Array.isArray(r) ? r : [r]));
        const cols = Math.max(0, ...rows.map((r) => r.length));
        if (!rows.length || !cols) throw new Error("cells must be a non-empty 2D array");
        await goto(a.slide);
        await ok("insert.table", { rows: rows.length, cols });
        for (let r = 0; r < rows.length; r++)
          for (let c = 0; c < cols; c++) {
            const v = str(rows[r][c]);
            if (v) await replaceText({ cell: [r, c] }, v);
          }
        return `Table ${rows.length}×${cols} added.`;
      },
    },
    {
      group: "edit",
      name: "delete_slide",
      description: "Delete a slide (number from 1; default: the current one).",
      parameters: { type: "object", properties: { slide: { type: "number" } } },
      label: (a) => `Deleting slide ${str(a.slide)}`,
      run: async (a) => ok("slide.delete", { index: await goto(a.slide) }),
    },
    {
      group: "edit",
      name: "move_slide",
      description: "Move a slide from one position to another (numbers from 1).",
      parameters: {
        type: "object",
        properties: { from: { type: "number" }, to: { type: "number" } },
        required: ["from", "to"],
      },
      label: (a) => `Moving slide ${str(a.from)} to ${str(a.to)}`,
      run: (a) => ok("slide.move", { from: int(a.from, 1) - 1, to: int(a.to, 1) - 1 }),
    },
    {
      group: "edit",
      name: "duplicate_slide",
      description: "Duplicate a slide (number from 1; default: the current one).",
      parameters: { type: "object", properties: { slide: { type: "number" } } },
      label: () => "Duplicating a slide",
      run: async (a) => ok("slide.duplicate", { index: await goto(a.slide) }),
    },
    ...commandTools(
      "deck",
      () => cx.docId,
      (c, p) => cx.exec(c, p),
      async () => {
        const r = await cx.exec("commands.list", {});
        if (!r.ok || !Array.isArray(r.result)) throw new Error(r.ok ? "no command list" : r.error);
        return r.result as Array<{ id: string; label?: string; params?: string }>;
      },
    ),
    ...webTools(lang),
    imageTool({
      sink,
      insert: async (base64, alt) => {
        await ok("insert.picture", { data: base64, name: "picture.png", alt });
      },
    }),
  ];

  return {
    kind: "deck",
    system:
      "You are an assistant built into a presentation application (slides). You work on the open presentation through tools. " +
      "Look first: presentation_info, read_slide or read_all_slides. Slides are numbered from 1 in your tools. " +
      "Use add_slide for new slides (a title and bullet points go straight into its placeholders), set_text to change text, set_notes for speaker notes, add_table and add_text_box for content. " +
      "Keep slides short: a title and at most 5 short bullet points; put details into the speaker notes. " +
      "For themes, fonts and colours, shapes, pictures, charts, SmartArt, animations, transitions, sections, hiding slides and everything else use find_commands, then run_command " +
      "(most commands act on the current slide or the selected shapes: go to the slide with slide.go {index} (from 0) and select shapes with edit.select {ids} first). " +
      "Do not rebuild a slide that only needs a small change: change just what was asked. " +
      "When the user asks for facts, use web_search and open_page and mention the source links.",
    tools,
    context: () =>
      `Presentation: ${cx.ui.docName}. ${cx.s.slides} slide(s); the current one is ${cx.s.slide + 1}.`,
    undoMark: () => cx.undoDepth(),
    undoTo: async (mark) => {
      for (let guard = 0; guard < 500; guard++) {
        if ((await cx.undoDepth()) <= mark) break;
        describeResult(await cx.exec("edit.undo", {}));
      }
    },
    snapshot: (max) => outline(max),
    setPictureSink: (fn) => {
      sink.fn = fn;
    },
    insert: async (text) => {
      const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
      const [title, ...rest] = lines;
      describeResult(
        await cx.exec("slide.new", { layout: "titleAndContent", title, body: rest.join("\n") }),
      );
    },
  };
}

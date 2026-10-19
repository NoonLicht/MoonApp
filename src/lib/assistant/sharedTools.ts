import { api } from "@/api/client";
import type { AssistantTool, ExecResult } from "@/lib/assistant/types";

/** Команда ядра в том виде, как её отдаёт `engine.commands` (у Word и Excel поля чуть различаются). */
interface CoreCommand {
  id: string;
  label?: string;
  params?: string;
  location?: string;
  menu?: string[];
  shortcut?: string;
}

const cache = new Map<string, Promise<CoreCommand[]>>();

function commands(kind: "word" | "sheet", docId: string): Promise<CoreCommand[]> {
  let p = cache.get(kind);
  if (!p) {
    p = (kind === "word" ? api.wordCommands(docId) : api.sheetCommands(docId)) as Promise<
      CoreCommand[]
    >;
    p.catch(() => cache.delete(kind));
    cache.set(kind, p);
  }
  return p;
}

const words = (q: string): string[] =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .filter((w) => w.length > 1);

/** Поиск команды по словам запроса: id и подпись весят больше, чем место на ленте. */
export function searchCommands(list: CoreCommand[], query: string, limit = 12): CoreCommand[] {
  const ws = words(query);
  if (!ws.length) return [];
  return list
    .map((c) => {
      const id = c.id.toLowerCase();
      const label = (c.label ?? "").toLowerCase();
      const where = `${c.location ?? ""} ${(c.menu ?? []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const w of ws) {
        if (id === w) score += 8;
        else if (id.includes(w)) score += 4;
        if (label.includes(w)) score += 3;
        if (where.includes(w)) score += 1;
      }
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}

/** Параметры могут прийти и объектом, и JSON-строкой (маленькие модели часто путают). */
function objectArg(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string" && v.trim()) {
    try {
      const o = JSON.parse(v) as unknown;
      if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch {
      /* ниже — пустые параметры */
    }
  }
  return {};
}

export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Результат команды для модели: короткий JSON без служебного состояния. */
export function describeResult(r: ExecResult): string {
  if (!r.ok) throw new Error(r.error || "command failed");
  if (r.result === undefined || r.result === null) return "OK";
  const text = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
  return text.length > 2500 ? `OK. Result: ${text.slice(0, 2500)}…` : `OK. Result: ${text}`;
}

/** «Найти команду» и «Выполнить команду»: через них помощнику доступно всё, что есть на ленте. */
export function commandTools(
  kind: "word" | "sheet",
  docId: () => string,
  exec: (cmd: string, p?: Record<string, unknown>) => Promise<ExecResult>,
): AssistantTool[] {
  return [
    {
      group: "commands",
      name: "find_commands",
      description:
        "Search the application's commands (everything on the ribbon: formatting, tables, charts, styles, page setup…). " +
        "Returns command ids with their parameter format. Call it before run_command if you are not sure of an id.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "what you want to do, in English, e.g. 'bold', 'insert table', 'sort'",
          },
        },
        required: ["query"],
      },
      label: (a) => `Finding commands: ${str(a.query)}`,
      run: async (a) => {
        const hits = searchCommands(await commands(kind, docId()), str(a.query));
        if (!hits.length) return "No commands found; try other words.";
        return hits
          .map(
            (c) =>
              `${c.id} — ${c.label ?? ""}${c.params ? ` — params: ${c.params.slice(0, 220)}` : ""}`,
          )
          .join("\n");
      },
    },
    {
      group: "commands",
      name: "run_command",
      description:
        "Run an application command by id with parameters (see find_commands). Applies to the current selection or caret. " +
        "Returns OK or the error text.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "command id, e.g. format.bold" },
          params: { type: "object", description: "command parameters as an object" },
        },
        required: ["command"],
      },
      label: (a) => `Running command: ${str(a.command)}`,
      run: async (a) => describeResult(await exec(str(a.command), objectArg(a.params))),
    },
  ];
}

const toDataUrl = (b: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

/**
 * «Нарисовать картинку»: Qwen-Image через stable-diffusion.cpp, результат показывается в чате и
 * вставляется в документ (`insert` знает, как это делает именно Word или Excel).
 */
export function imageTool(o: {
  insert: (base64: string, alt: string, place: string) => Promise<void>;
  sink: { fn: ((url: string) => void) | null };
}): AssistantTool {
  return {
    group: "images",
    name: "generate_image",
    description:
      "Draw a picture from a text description and insert it into the document at the caret / active cell. Takes minutes: use it once, only when the user asked for an image. Describe the picture in English in detail.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "detailed description of the picture, in English" },
        size: {
          type: "string",
          enum: ["square", "landscape", "portrait"],
          description: "default square",
        },
        place: {
          type: "string",
          description:
            'where to put it: in a document "cursor" (default) or "end" (after the last paragraph); in a workbook a cell address such as "F2" (default: the active cell)',
        },
      },
      required: ["prompt"],
    },
    label: () => "Generating an image",
    run: async (a, signal) => {
      const size = str(a.size);
      const blob = await api.assistantImage(
        {
          prompt: str(a.prompt),
          width: size === "landscape" ? 896 : 768,
          height: size === "portrait" ? 896 : 768,
        },
        signal,
      );
      const url = await toDataUrl(blob);
      o.sink.fn?.(url);
      await o.insert(url.split(",")[1] ?? "", str(a.prompt).slice(0, 120), str(a.place));
      return "Image generated and inserted into the document.";
    },
  };
}

/** Поиск в интернете и чтение страниц (сервер: server/ts/assistant/web.ts). */
export function webTools(lang: string): AssistantTool[] {
  return [
    {
      group: "web",
      name: "web_search",
      description:
        "Search the internet. Returns titles, links and short snippets; open_page reads a result in full. Always cite the links you used.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "search query" } },
        required: ["query"],
      },
      label: (a) => `Searching the web: ${str(a.query)}`,
      run: async (a) => {
        const r = await api.assistantWebSearch(str(a.query), lang);
        if (!r.hits.length)
          return "No results for this query. Try different or shorter words, another language, or open a known page with open_page.";
        return r.hits
          .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
          .join("\n");
      },
    },
    {
      group: "web",
      name: "open_page",
      description:
        "Read a web page by URL as plain text. If the text is cut off, call again with `offset` set to the returned next value.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) link" },
          offset: { type: "number", description: "character offset to continue reading from" },
        },
        required: ["url"],
      },
      label: (a) => `Opening page: ${str(a.url)}`,
      run: async (a) => {
        const r = await api.assistantWebFetch(str(a.url), Number(a.offset) || 0, 7000);
        return `${r.title ? `Title: ${r.title}\n` : ""}URL: ${r.url}\n\n${r.text}${r.next ? `\n\n[continues: offset=${r.next}, total ${r.total} chars]` : ""}`;
      },
    },
  ];
}

/**
 * Значение строкового поля из НЕПОЛНОГО JSON аргументов: то, что модель успела написать.
 * Незавершённая escape-последовательность в конце не включается (дойдёт со следующим куском).
 * `null` — поле ещё не началось; `done` — строка закрыта.
 */
export function partialString(raw: string, key: string): { text: string; done: boolean } | null {
  const m = new RegExp(String.raw`"${key}"\s*:\s*"`).exec(raw);
  if (!m) return null;
  let out = "";
  for (let i = m.index + m[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') return { text: out, done: true };
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = raw[i + 1];
    if (n === undefined) break;
    if (n === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "" : n;
    i += 1;
  }
  return { text: out, done: false };
}

/** Число из неполного JSON (поле должно быть уже завершено следующим знаком). */
export function partialNumber(raw: string, key: string): number | null {
  const m = new RegExp(String.raw`"${key}"\s*:\s*(-?\d+)\s*[,}]`).exec(raw);
  return m ? Number(m[1]) : null;
}

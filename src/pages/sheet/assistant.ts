import {
  commandTools,
  describeResult,
  imageTool,
  str,
  webTools,
} from "@/lib/assistant/sharedTools";
import type { AssistantTool, DocAdapter } from "@/lib/assistant/types";
import type { SheetCx } from "@/pages/sheet/types";

interface SheetRead {
  range: string;
  sheet: string;
  values: unknown[][];
}

interface Inspect {
  activeCell: string;
  activeSheet: number;
  names: unknown[];
  sheets: {
    name: string;
    usedRange: string | null;
    cells: number;
    charts: { title?: string; at?: string; kind?: string }[];
    tables: unknown[];
    autofilter: unknown;
    freeze: unknown;
  }[];
}

const colName = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const colIndex = (s: string): number =>
  [...s.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** «B2:F15» → строка и столбец левого верхнего угла (нумерация с нуля). */
function origin(range: string): { row: number; col: number } {
  const m = /^\$?([A-Za-z]+)\$?(\d+)/.exec(range.split("!").pop() ?? range);
  return m ? { row: Number(m[2]) - 1, col: colIndex(m[1]) } : { row: 0, col: 0 };
}

/** Значения → текст с адресами ячеек: модель видит, где что лежит. */
function table(r: SheetRead, maxChars: number): string {
  const o = origin(r.range);
  const head = `Sheet "${r.sheet}", range ${r.range}. Columns: ${(r.values[0] ?? []).map((_, i) => colName(o.col + i)).join(" | ")}`;
  const lines: string[] = [];
  let size = head.length;
  for (let i = 0; i < r.values.length; i++) {
    const line = `${o.row + i + 1}: ${r.values[i]
      .map((v) =>
        str(v)
          .replace(/[\t\r\n]+/g, " ")
          .trim(),
      )
      .join(" | ")}`;
    if (size + line.length > maxChars) {
      lines.push(`[cut after row ${o.row + i}; read the next part with a narrower range]`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return `${head}\n${lines.join("\n")}`;
}

function matrix(v: unknown): unknown[][] {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      throw new Error("values must be a 2D array like [[1,2],[3,4]]");
    }
  }
  if (!Array.isArray(x) || !x.length) throw new Error("values must be a non-empty 2D array");
  return x.map((row) => (Array.isArray(row) ? row : [row]));
}

/** `getCx` отдаёт актуальный контекст страницы: пока агент работает, состояние документа меняется. */
export function sheetAdapter(getCx: () => SheetCx, lang: string): DocAdapter {
  const cx = new Proxy({} as SheetCx, {
    get: (_t, k) => (getCx() as unknown as Record<string | symbol, unknown>)[k],
  });
  const sink: { fn: ((url: string) => void) | null } = { fn: null };
  const activeName = (): string => cx.s.sheets[cx.s.active]?.name ?? "";

  const read = async (
    range?: string,
    sheet?: string,
    formulas = false,
    max = 9000,
  ): Promise<string> => {
    const r = await cx.query<SheetRead>("sheet.read", {
      ...(range ? { range } : {}),
      ...(sheet ? { sheet } : {}),
      formatted: !formulas,
      formulas,
    });
    if (!r || !r.values?.length) return "(no data in that range)";
    return table(r, max);
  };

  const tools: AssistantTool[] = [
    {
      group: "read",
      name: "workbook_info",
      description:
        "List the sheets of the workbook with their used ranges, charts and tables, and the active cell.",
      parameters: { type: "object", properties: {} },
      label: () => "Looking at the workbook",
      run: async () => {
        const i = await cx.query<Inspect>("document.inspect", {});
        if (!i) return "No information.";
        return [
          `Active sheet: ${i.sheets[i.activeSheet]?.name}, active cell ${i.activeCell}.`,
          ...i.sheets.map(
            (s) =>
              `- "${s.name}": used range ${s.usedRange ?? "empty"}, ${s.cells} cells` +
              (s.charts.length
                ? `, charts: ${s.charts.map((c) => `${c.title ?? c.kind} at ${c.at}`).join("; ")}`
                : "") +
              (s.tables.length ? `, ${s.tables.length} table(s)` : ""),
          ),
        ].join("\n");
      },
    },
    {
      group: "read",
      name: "read_range",
      description:
        "Read cell values from a sheet. Without a range it reads the whole used range. Set formulas=true to see formulas instead of displayed values.",
      parameters: {
        type: "object",
        properties: {
          range: { type: "string", description: 'A1 range, e.g. "A1:D20"' },
          sheet: { type: "string", description: "sheet name (default: active)" },
          formulas: { type: "boolean" },
        },
      },
      label: (a) => (a.range ? `Reading: ${str(a.range)}` : "Reading the sheet"),
      run: (a) => read(str(a.range) || undefined, str(a.sheet) || undefined, !!a.formulas),
    },
    {
      group: "read",
      name: "get_selection",
      description: "Get the currently selected range and the value of the active cell.",
      parameters: { type: "object", properties: {} },
      label: () => "Reading the selection",
      run: async () =>
        `Selection ${cx.s.sel.a1} on sheet "${activeName()}".\n${await read(cx.s.sel.a1, undefined, true, 1500)}`,
    },
    {
      group: "edit",
      name: "write_cells",
      description:
        "Write a block of values starting at a cell or range. `values` is a 2D array of rows; strings starting with = are formulas.",
      parameters: {
        type: "object",
        properties: {
          range: { type: "string", description: 'top-left cell or range, e.g. "A1"' },
          values: {
            type: "array",
            description: 'rows of values, e.g. [["Name","Qty"],["Apples",3]]',
            items: { type: "array", items: {} },
          },
          sheet: { type: "string", description: "sheet name (default: active)" },
        },
        required: ["range", "values"],
      },
      label: (a) => `Writing to: ${str(a.range)}`,
      run: async (a) => {
        if (a.sheet && str(a.sheet) !== activeName())
          describeResult(await cx.exec("sheet.activate", { sheet: str(a.sheet) }));
        return describeResult(
          await cx.exec("range.setValues", { range: str(a.range), values: matrix(a.values) }),
        );
      },
    },
    {
      group: "edit",
      name: "set_formula",
      description: "Put a formula (or any value) into one cell. Formulas start with =.",
      parameters: {
        type: "object",
        properties: {
          cell: { type: "string", description: 'cell address, e.g. "E2"' },
          formula: { type: "string", description: 'e.g. "=SUM(B2:B10)"' },
        },
        required: ["cell", "formula"],
      },
      label: (a) => `Setting cell: ${str(a.cell)}`,
      run: async (a) =>
        describeResult(await cx.exec("cell.set", { cell: str(a.cell), input: str(a.formula) })),
    },
    ...commandTools(
      "sheet",
      () => cx.docId,
      (c, p) => cx.exec(c, p),
    ),
    ...webTools(lang),
    imageTool({
      sink,
      insert: async (base64, alt, place) => {
        describeResult(
          await cx.exec("insert.picture", {
            base64,
            mime: "image/png",
            at: /^[A-Za-z]{1,3}\d{1,7}$/.test(place)
              ? place.toUpperCase()
              : cx.s.sel.a1.split(":")[0],
            width: 320,
            alt,
          }),
        );
      },
    }),
  ];

  return {
    kind: "sheet",
    system:
      "You are an assistant built into a spreadsheet application. You work on the open workbook through tools. " +
      "Look first: workbook_info, then read_range. Cells are addressed in A1 style. " +
      "Use write_cells and set_formula for data and formulas (prefer formulas over typed results when the user wants calculations). " +
      "For sorting, filtering, formatting, charts, pivot tables, validation and everything else use find_commands, then run_command (it acts on the current selection: select the range first with run_command selection.set {range}). " +
      "When the user asks for facts, use web_search and open_page and mention the source links; put found data into cells only when asked.",
    tools,
    context: () => {
      const s = cx.s;
      return `Workbook: ${cx.ui.docName}. Active sheet: "${activeName()}". Selection: ${s.sel.a1}. Sheets: ${s.sheets.map((x) => x.name).join(", ")}.`;
    },
    undoMark: async () => 0,
    undoTo: async (_mark, edits) => {
      if (edits > 0) describeResult(await cx.exec("edit.undo", { steps: edits }));
    },
    snapshot: (max) => read(undefined, undefined, false, max),
    setPictureSink: (fn) => {
      sink.fn = fn;
    },
    insert: async (text) => {
      const rows = text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((l) => l.split("\t"));
      describeResult(
        await cx.exec("range.setValues", { range: cx.s.sel.a1.split(":")[0], values: rows }),
      );
    },
  };
}

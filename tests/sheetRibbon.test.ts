/**
 * Лента «Таблиц»: модель вкладок ссылается только на существующие команды ядра GridCraft,
 * а каждая английская подпись переведена на русский (каталоги WordCraft и GridCraft + наши добавки).
 * Без собранного ядра (native/gridcore) проверка команд пропускается.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ALL_TABS, contextTabs } from "../src/pages/sheet/ribbon/model";
import {
  chartDesign,
  chartFormat,
  pictureFormat,
  pivotAnalyze,
  pivotDesign,
  shapeFormat,
  slicerTab,
  tableDesign,
} from "../src/pages/sheet/ribbon/model/context";
import { FORMS1 } from "../src/pages/sheet/dialogs/specs1";
import { FORMS2 } from "../src/pages/sheet/dialogs/specs2";
import { FORMS3 } from "../src/pages/sheet/dialogs/specs3";
import type { Act, Ctl, Item, Tab } from "../src/pages/word/ribbon/types";
import type { SheetCx as Cx } from "../src/pages/sheet/types";
import wordRu from "../src/pages/word/i18n/cat/ru.json";
import wordExtraRu from "../src/pages/word/i18n/extra/ru.json";
import sheetRu from "../src/pages/sheet/i18n/cat/ru.json";
import extraRu from "../src/pages/sheet/i18n/extra/ru.json";

const ru: Record<string, string> = { ...wordRu, ...wordExtraRu, ...sheetRu };

/** Заглушка контекста: любое обращение к свойству возвращает безопасное значение. */
function deep(): unknown {
  const fn = (): unknown => deep();
  return new Proxy(fn, {
    get: (_t, k) =>
      k === Symbol.toPrimitive ? () => "" : k === "length" ? 0 : k === "then" ? undefined : deep(),
    apply: () => deep(),
  });
}
const cx = deep() as Cx;

const cmds = new Set<string>();
const labels = new Set<string>();

function item(it: Item): void {
  if (it.label && !it.raw) labels.add(it.label);
  if (it.head && !it.raw) labels.add(it.head);
  act(it.act);
  const subs =
    typeof it.sub === "function" ? safe(() => (it.sub as (c: Cx) => Item[])(cx)) : it.sub;
  subs?.forEach(item);
}
function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}
function act(a: Act | undefined): void {
  if (a && "cmd" in a) cmds.add(a.cmd);
}
function ctl(c: Ctl): void {
  switch (c.k) {
    case "big":
    case "small":
      if (c.label) labels.add(c.label);
      if (c.tip) labels.add(c.tip);
      act(c.act);
      break;
    case "menu": {
      if (c.label) labels.add(c.label);
      if (c.tip) labels.add(c.tip);
      const sp =
        typeof c.split === "function" ? safe(() => (c.split as (x: Cx) => Act)(cx)) : c.split;
      act(sp);
      const items =
        typeof c.items === "function" ? safe(() => (c.items as (x: Cx) => Item[])(cx)) : c.items;
      items?.forEach(item);
      break;
    }
    case "stack":
      c.rows.forEach(ctl);
      break;
    case "row":
      c.items.forEach(ctl);
      break;
    case "check":
      labels.add(c.label);
      break;
    default:
  }
}
function tab(t: Tab): void {
  labels.add(t.label);
  const groups = typeof t.groups === "function" ? t.groups(cx) : t.groups;
  for (const g of groups) {
    labels.add(g.label);
    act(g.launcher);
    g.items.forEach(ctl);
  }
}

const TABS = [
  ...ALL_TABS,
  tableDesign,
  chartDesign,
  chartFormat,
  pictureFormat,
  shapeFormat,
  slicerTab,
  pivotAnalyze,
  pivotDesign,
];
for (const t of TABS) tab(t);

/** Подписи диалогов: названия, вкладки, поля и их варианты. */
for (const f of [...Object.values(FORMS1), ...Object.values(FORMS2), ...Object.values(FORMS3)]) {
  labels.add(f.title);
  f.tabs?.forEach((x) => labels.add(x));
  for (const fl of f.fields) {
    if ("label" in fl && fl.label) labels.add(fl.label);
    if ("unit" in fl && fl.unit) labels.add(fl.unit);
    if (fl.k === "note" && !fl.raw) labels.add(fl.text);
    if ((fl.k === "select" || fl.k === "radio") && !fl.raw && Array.isArray(fl.options)) fl.options.forEach(([, l]) => labels.add(l));
  }
}

function engineCommands(): Set<string> | null {
  const bin = path.join(
    __dirname,
    "..",
    "native",
    "gridcore",
    "target",
    "release",
    process.platform === "win32" ? "gridcore.exe" : "gridcore",
  );
  if (!fs.existsSync(bin)) return null;
  const r = spawnSync(bin, [], {
    input: '{"id":1,"method":"engine.commands","params":{}}\n{"method":"quit"}\n',
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("{"));
  if (!line) return null;
  const res = (JSON.parse(line) as { result?: { id: string }[] }).result ?? [];
  return new Set(res.map((c) => c.id));
}

/** Строки, переведённые прямо в коде: tw("…") и empty="…" в исходниках страницы. */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === "i18n" ? [] : walk(f)) : /\.tsx?$/.test(e.name) ? [f] : [];
  });
}
for (const f of walk(path.join(__dirname, "..", "src", "pages", "sheet"))) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/\btw\(\s*"([^"$]+)"/g)) labels.add(m[1]);
  for (const m of src.matchAll(/\bempty="([^"]+)"/g)) labels.add(m[1]);
  for (const m of src.matchAll(/\btitle="([^"]+)"/g)) labels.add(m[1]);
}

describe("лента «Таблиц»", () => {
  it("модель покрывает все вкладки и использует много команд ядра", () => {
    expect(TABS.length).toBeGreaterThanOrEqual(15);
    expect(cmds.size).toBeGreaterThan(100);
    expect(contextTabs).toBeTypeOf("function");
  });

  it("каждая команда ленты есть в ядре", () => {
    const known = engineCommands();
    if (!known) return;
    const unknown = [...cmds].filter((c) => !known.has(c));
    expect(unknown).toEqual([]);
  });

  it("каждая подпись ленты переведена на русский", () => {
    const miss = [...labels].filter(
      (l) => l && /[A-Za-z]/.test(l) && !(l in ru) && !(l in extraRu),
    );
    if (process.env.DUMP_MISS) fs.writeFileSync(process.env.DUMP_MISS, JSON.stringify(miss, null, 1));
    expect(miss).toEqual([]);
  });
});

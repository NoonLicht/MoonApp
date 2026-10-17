/**
 * Лента «Документов»: модель вкладок ссылается только на существующие команды ядра WordCraft,
 * а каждая английская подпись переведена на русский (каталог WordCraft + наши добавки).
 * Без собранного ядра (native/wordcore) проверка команд пропускается.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ALL_TABS, contextTabs } from "../src/pages/word/ribbon/model";
import { design } from "../src/pages/word/ribbon/model/design";
import {
  chartDesign,
  equationTab,
  outlining,
  pictureFormat,
  shapeFormat,
  smartArtDesign,
  tableDesign,
  tableLayout,
} from "../src/pages/word/ribbon/model/context";
import { hf } from "../src/pages/word/ribbon/model/misc";
import type { Act, Ctl, Cx, Item, Tab } from "../src/pages/word/ribbon/types";
import ru from "../src/pages/word/i18n/cat/ru.json";
import extraRu from "../src/pages/word/i18n/extra/ru.json";

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
  design,
  tableDesign,
  tableLayout,
  pictureFormat,
  shapeFormat,
  chartDesign,
  smartArtDesign,
  equationTab,
  outlining,
  hf,
];
for (const t of TABS) tab(t);

function engineCommands(): Set<string> | null {
  const bin = path.join(
    __dirname,
    "..",
    "native",
    "wordcore",
    "target",
    "release",
    process.platform === "win32" ? "wordcore.exe" : "wordcore",
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

describe("лента Word", () => {
  it("модель покрывает все вкладки и использует много команд ядра", () => {
    expect(TABS.length).toBeGreaterThanOrEqual(19);
    expect(cmds.size).toBeGreaterThan(200);
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
    expect(miss).toEqual([]);
  });
});

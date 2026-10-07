import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import ru from "@/i18n/ru.json";
import en from "@/i18n/en.json";

/**
 * Linux-вкладка «Тюнинг ПК»: каталог скриптов linutil (server/vendor/linutil/catalog.json)
 * должен быть целым — каждый пункт ссылается на существующий скрипт с LF-концами строк.
 */
const ROOT = path.join(__dirname, "..", "server", "vendor", "linutil");
interface Node {
  id?: string;
  script?: string;
  children?: Node[];
}
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8")) as {
  tabs: { id: string; groups: Node[] }[];
};
const leaves: { tab: string; node: Node }[] = [];
const walk = (tab: string, list: Node[]): void => {
  for (const n of list) {
    if (n.script) leaves.push({ tab, node: n });
    if (n.children) walk(tab, n.children);
  }
};
for (const t of catalog.tabs) walk(t.id, t.groups);

describe("каталог linutil", () => {
  it("есть вкладки и скрипты, id уникальны", () => {
    expect(catalog.tabs.length).toBeGreaterThan(0);
    expect(leaves.length).toBeGreaterThan(100);
    const ids = leaves.map((l) => l.node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("каждый скрипт существует и использует LF", () => {
    for (const { tab, node } of leaves) {
      const file = path.join(ROOT, tab, node.script as string);
      expect(fs.existsSync(file), node.id).toBe(true);
      expect(fs.readFileSync(file, "utf8").includes("\r"), node.id).toBe(false);
    }
  });

  it("лицензия MIT лежит рядом со скриптами", () => {
    expect(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8")).toMatch(/MIT License/);
  });

  it("названия вкладок переведены", () => {
    for (const dict of [ru, en]) {
      const lu = (dict as unknown as { tuning: { lu: { tab: Record<string, string> } } }).tuning.lu;
      for (const t of catalog.tabs) expect(lu.tab[t.id], t.id).toBeTruthy();
    }
  });
});

describe("запуск", () => {
  it("принимает только id из каталога", () => {
    const { linutilRun } = require("../server/linutil") as typeof import("../server/ts/linutil");
    const r = linutilRun("../../etc/passwd");
    expect(r.ok).toBe(false);
  });
});

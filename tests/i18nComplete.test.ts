import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LANGS } from "@/app/i18n";

/**
 * Полнота словарей: у каждого языка тот же набор ключей, что у en.json, и те же
 * плейсхолдеры {name}. То же самое в CI проверяет `npm run check:i18n`; тест
 * нужен, чтобы расхождение ловилось и при обычном `npm test`.
 */
const DIR = path.join(__dirname, "..", "src", "i18n");
const load = (l: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(DIR, `${l}.json`), "utf8"));

function flat(o: Record<string, unknown>, pre = "", out = new Map<string, string>()) {
  for (const [k, v] of Object.entries(o)) {
    if (k === "_meta") continue;
    if (v && typeof v === "object") flat(v as Record<string, unknown>, `${pre}${k}.`, out);
    else out.set(pre + k, String(v));
  }
  return out;
}
const ph = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

const en = flat(load("en"));

describe("словари интерфейса", () => {
  it("список LANGS совпадает с файлами в src/i18n и с _meta.native", () => {
    const files = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
    expect(LANGS.map((l) => l.code).sort()).toEqual(files);
    for (const l of LANGS) {
      expect((load(l.code)._meta as { native: string }).native, l.code).toBe(l.native);
    }
  });

  for (const { code } of LANGS.filter((l) => l.code !== "en")) {
    it(`${code}: те же ключи и плейсхолдеры, что в en.json`, () => {
      const d = flat(load(code));
      expect([...en.keys()].filter((k) => !d.has(k))).toEqual([]);
      expect([...d.keys()].filter((k) => !en.has(k))).toEqual([]);
      const bad = [...en.keys()].filter((k) => ph(d.get(k)!) !== ph(en.get(k)!));
      expect(bad).toEqual([]);
    });
  }
});

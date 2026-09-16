import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Страж перевода серверных модулей на TS (server/ts/*.ts -> server/*.js).
 *
 * Модуль, переведённый на TS, но забытый в tsconfig.server.json, существует
 * только в исходнике: require("./имя") упадёт в рантайме, потому что рядом нет
 * собранного .js. Отдельно проверяем, что артефакт не попал в git: он
 * генерируется и в истории репозитория дублировать его не нужно.
 */
const root = path.resolve(__dirname, "..");
const tsDir = path.join(root, "server", "ts");
const cfgText = fs.readFileSync(path.join(root, "tsconfig.server.json"), "utf8");
const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");

const sources = fs
  .readdirSync(tsDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => f.replace(/\.ts$/, ""));

describe("перевод серверных модулей на TS", () => {
  it("в server/ts есть исходники (иначе тест ничего не проверяет)", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)("server/ts/%s.ts перечислен в files tsconfig.server.json", (name) => {
    expect(cfgText).toContain(`server/ts/${name}.ts`);
  });

  it.each(sources)("для server/ts/%s.ts собран артефакт server/%s.js", (name) => {
    const artifact = path.join(root, "server", `${name}.js`);
    expect(fs.existsSync(artifact), `нет собранного ${artifact}`).toBe(true);
    // Артефакт не пустой: tsc отдаёт exports.* только для непустых модулей.
    expect(fs.readFileSync(artifact, "utf8")).toContain("exports.");
  });

  it.each(sources)("артефакт server/%s.js не хранится в git", (name) => {
    expect(gitignore).toContain(`server/${name}.js`);
  });
});

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Журнал проблем (server/ts/problemLog.ts -> server/problemLog.js).
 * Фиксируем поведение: одинаковые ошибки склеиваются, секреты вырезаются,
 * размер ограничен, а журнал никогда не бросает исключений.
 */
const req = createRequire(import.meta.url);

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-problems-"));
});

function mod(): any {
  return req("../server/problemLog");
}

beforeEach(() => {
  mod().clearProblems();
});

describe("problemLog", () => {
  it("склеивает одинаковые ошибки в одну запись со счётчиком", () => {
    const { reportProblem, listProblems } = mod();
    reportProblem({ source: "t", error: new Error("файл 12 не найден") });
    reportProblem({ source: "t", error: new Error("файл 345 не найден") });
    const items = listProblems();
    expect(items).toHaveLength(1);
    expect(items[0].count).toBe(2);
  });

  it("разные источники — разные записи", () => {
    const { reportProblem, listProblems } = mod();
    reportProblem({ source: "a", error: "boom" });
    reportProblem({ source: "b", error: "boom" });
    expect(listProblems()).toHaveLength(2);
  });

  it("вырезает ключи и токены", () => {
    const { reportProblem, listProblems } = mod();
    reportProblem({
      source: "t",
      error: new Error(
        "401 Bearer abcdefghijklmnop1234 url?api_key=SECRET123 sk-abcdefghijklmnopqrstuv",
      ),
    });
    const msg: string = listProblems()[0].message;
    expect(msg).not.toContain("abcdefghijklmnop1234");
    expect(msg).not.toContain("SECRET123");
    expect(msg).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("не держит больше MAX_PROBLEMS записей", () => {
    const { reportProblem, listProblems, MAX_PROBLEMS } = mod();
    for (let i = 0; i < MAX_PROBLEMS + 20; i++) {
      reportProblem({ source: `s${i}`, error: "x" });
    }
    expect(listProblems().length).toBe(MAX_PROBLEMS);
  });

  it("не бросает на странных входных данных", () => {
    const { reportProblem } = mod();
    expect(() => reportProblem({ source: "t", error: undefined })).not.toThrow();
    expect(() => reportProblem({ source: "t", error: { a: 1 } })).not.toThrow();
  });
});

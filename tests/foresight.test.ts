import { describe, it, expect, beforeAll } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { createRequire } from "module";

const nodeRequire = createRequire(__filename);

/** Foresight: поиск вопросов в расшифровке встречи и подготовка запросов к модели. */

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-foresight-"));
});

const chunk = (start: number, end: number, text: string) => ({
  start_ms: start,
  end_ms: end,
  text,
  status: "done",
});

describe("распознавание вопросов", () => {
  it("вопрос со знаком и без знака (расшифровка его часто не ставит)", async () => {
    const f = await import("../server/foresight");
    expect(f.isQuestion("Когда мы выпускаем релиз?")).toBe(true);
    expect(f.isQuestion("почему сборка падает на Windows")).toBe(true);
    expect(f.isQuestion("What is the deadline for the report")).toBe(true);
    expect(f.isQuestion("Can we ship it on Friday?")).toBe(true);
    expect(f.isQuestion("Релиз выходит в пятницу.")).toBe(false);
    expect(f.isQuestion("Как хорошо, что мы это сделали.")).toBe(false);
    expect(f.isQuestion("что?")).toBe(false);
  });

  it("находит только новые вопросы после отметки и убирает повторы", async () => {
    const f = await import("../server/foresight");
    const chunks = [
      chunk(0, 4000, "Начнём. Кто отвечает за тесты? Мы всё проверили."),
      chunk(5000, 9000, "Кто отвечает за тесты? Сколько это займёт по времени"),
    ];
    const all = f.detectQuestions(chunks);
    expect(all.map((q) => q.question)).toEqual([
      "Кто отвечает за тесты?",
      "Сколько это займёт по времени",
    ]);
    expect(all[0].atMs).toBe(0);
    // после отметки берутся только свежие чанки; повтор старого вопроса отсекает scan() по известным карточкам
    const later = f.detectQuestions(chunks, 4000);
    expect(later.every((q) => q.atMs === 5000)).toBe(true);
    expect(later.map((q) => q.question)).toContain("Сколько это займёт по времени");
  });

  it("недописанные и пустые чанки пропускаются", async () => {
    const f = await import("../server/foresight");
    const r = f.detectQuestions([
      { start_ms: 0, end_ms: 1000, text: "Где лежит файл?", status: "pending" },
      chunk(1000, 2000, ""),
    ]);
    expect(r).toEqual([]);
  });
});

describe("подготовка запросов", () => {
  it("расшифровка с метками времени и ужатие под лимит", async () => {
    const f = await import("../server/foresight");
    const short = f.transcriptFor([chunk(65000, 70000, "Привет всем")]);
    expect(short).toBe("[00:01:05] Привет всем");
    const many = Array.from({ length: 400 }, (_, i) =>
      chunk(i * 1000, i * 1000 + 900, `реплика номер ${i} ${"слово ".repeat(10)}`),
    );
    const squeezed = f.transcriptFor(many, 3000);
    expect(squeezed.length).toBeLessThanOrEqual(3000);
    expect(squeezed).toContain("реплика номер 0");
  });

  it("промпт ответа содержит вопрос и пронумерованные отрывки", async () => {
    const f = await import("../server/foresight");
    const p = f.buildAnswerPrompt("Когда релиз?", [
      { source: "note", ref: "1", title: "План", snippet: "Релиз 5 мая", score: 0.8 },
    ]);
    expect(p).toContain("Вопрос: Когда релиз?");
    expect(p).toContain("[1] План");
    expect(p).toContain("Релиз 5 мая");
  });
});

describe("сканирование встречи (настоящая БД)", () => {
  it("scan() находит вопросы, не дублирует их и позволяет убрать карточку", async () => {
    // обоим модулям нужен один экземпляр БД — грузим через общий CJS-кэш Node, а не через vite
    const { stmts } = nodeRequire("../server/db") as typeof import("../server/db");
    const f = nodeRequire("../server/foresight") as typeof import("../server/foresight");
    const lectureId = Number(stmts.lectureInsert.run("Планёрка", 16000, 1).lastInsertRowid);
    const info = stmts.chunkInsert.run(lectureId, 0, 0, 5000, "a.wav", {
      text: "Давайте начнём. Где лежит документ с планом?",
      status: "done",
    });
    expect(info).toBeTruthy();

    const first = f.scan(lectureId);
    expect(first.added).toBe(1);
    expect(first.cards[0].question).toBe("Где лежит документ с планом?");

    const again = f.scan(lectureId);
    expect(again.added).toBe(0);
    expect(again.cards).toHaveLength(1);

    const manual = f.ask(lectureId, "Кто ведёт протокол?");
    expect(manual.manual).toBe(true);
    expect(f.cardsOf(lectureId)).toHaveLength(2);

    expect(f.dismiss(lectureId, first.cards[0].id)).toBe(true);
    expect(f.cardsOf(lectureId)).toHaveLength(1);

    await expect(f.expandNotes(lectureId, "   ")).rejects.toThrow("empty_notes");
    expect(() => f.scan(999999)).toThrow("session_not_found");
    f.forget(lectureId);
    expect(f.cardsOf(lectureId)).toHaveLength(0);
  });
});

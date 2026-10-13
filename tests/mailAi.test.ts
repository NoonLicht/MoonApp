import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Локальный «интеллект» почты: сводка, задачи, быстрые ответы и дайджест без облачных провайдеров. */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-mailai-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
let ai: any;
let db: any;

function add(id: string, o: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO messages (id, account, folder, uid, subject, from_name, from_addr, date, seen, snippet, text, thread)
     VALUES (@id,'a1','INBOX',@uid,@subject,@from_name,@from_addr,@date,@seen,@snippet,@text,@id)`,
  ).run({
    id,
    uid: Math.floor(Math.random() * 1e6),
    subject: "",
    from_name: "",
    from_addr: "",
    date: Date.now() - 3600_000,
    seen: 0,
    snippet: "",
    text: "",
    ...o,
  });
}

beforeAll(() => {
  req("../server/mail/mailService");
  db = req("../server/mail/mailDb").mailDb();
  ai = req("../server/mail/mailAi");
  db.prepare(
    "INSERT INTO folders (account, path, name, special) VALUES ('a1','INBOX','INBOX','\\Inbox')",
  ).run();
  add("m1", {
    subject: "Отчёт за квартал",
    from_name: "Анна",
    from_addr: "anna@work.example",
    snippet: "Пожалуйста, пришлите отчёт до пятницы.",
    text: "Добрый день!\nПожалуйста, пришлите отчёт за квартал до пятницы. Нужно также подтвердить встречу в среду?\nЦифры по продажам выросли на 12 процентов. Прошу проверить таблицу.",
  });
  add("m2", {
    subject: "Оповещение системы безопасности",
    from_name: "Google",
    from_addr: "no-reply@accounts.google.com",
    snippet: "Создан пароль приложения",
  });
  add("m3", {
    subject: "Оповещение системы безопасности",
    from_name: "Google",
    from_addr: "no-reply@accounts.google.com",
    snippet: "Вход в аккаунт на устройстве Windows",
  });
  add("m4", {
    subject: "Скидки до 50% на всё",
    from_name: "Shop",
    from_addr: "news@shop.example",
    snippet: "Распродажа только сегодня",
  });
});

describe("локальный ИИ почты", () => {
  it("сводка цепочки выбирает предложения из письма", async () => {
    const r = await ai.runAi({ action: "summarize", id: "m1", lang: "ru" });
    expect(r.text).toContain("Отчёт за квартал");
    expect(r.text).toMatch(/- /);
  });

  it("задачи находят просьбы и сроки", async () => {
    const r = await ai.runAi({ action: "tasks", id: "m1" });
    expect(r.list.join(" ")).toMatch(/до пятницы/);
  });

  it("быстрые ответы зависят от намерения письма", async () => {
    const r = await ai.runAi({ action: "quick", id: "m1", lang: "ru" });
    expect(r.list).toHaveLength(3);
  });

  it("дайджест группирует уведомления и рекламу, не обращаясь к провайдерам", async () => {
    const r = await ai.runAi({ action: "digest", period: "day", lang: "ru" });
    expect(r.list[0]).toBe("4");
    expect(r.text).toContain("Сервисы и уведомления");
    expect(r.text).toContain("Рассылки и реклама");
    // два одинаковых оповещения Google схлопнуты
    expect(r.text).toMatch(/ещё 1/);
  });

  it("улучшение «исправить» работает без модели, перефразирование — нет", async () => {
    const fixed = await ai.runAi({
      action: "improve",
      mode: "fix",
      text: "привет ,мир!!!!!  как дела",
    });
    expect(fixed.text).toMatch(/^Привет, мир/);
    await expect(ai.runAi({ action: "improve", mode: "formal", text: "x" })).rejects.toThrow();
  });
});

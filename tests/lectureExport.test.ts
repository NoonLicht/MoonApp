import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Тесты выгрузки файлов лекции.
 *
 * Контекст (реальный баг): «Скачать .md» отвечало 400 с текстом
 *   Invalid character in header content ["Content-Disposition"]
 * Потому что в заголовок клали имя файла из НАЗВАНИЯ лекции, а оно на русском.
 * Node запрещает символы вне ASCII (точнее, вне Latin-1) в заголовках, поэтому
 * .md падал, а .srt/.vtt выживали — у них имя lecture_<id>.
 *
 * Здесь проверяем: имя файла в заголовке безопасно, а настоящее (русское) имя
 * уезжает в filename*=UTF-8'' — его понимает и браузер, и клиент
 * (filenameFromDisposition в src/api/client.ts читает именно filename*).
 */
const req = createRequire(import.meta.url);

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-export-"));
});

function lectureMod(): any { return req("../server/lecture"); }

describe("Выгрузка лекции — Content-Disposition с русским именем", () => {
  it("ASCII-часть заголовка безопасна, русское имя — в filename*", async () => {
    const lecture = await lectureMod();
    const header = lecture.contentDisposition("Лекция №1 (тест) / 2026.md");
    // Node принимает только символы Latin-1: любые «непечатные» тут = тот самый 400.
    expect(header).toMatch(/^[\x20-\x7E]+$/);
    // Настоящее имя сохраняется и раскодируется обратно байт-в-байт.
    const star = /filename\*=UTF-8''([^;]+)/.exec(header);
    expect(star).toBeTruthy();
    expect(decodeURIComponent(star![1])).toBe("Лекция №1 (тест) / 2026.md");
    // Обычный filename= для старых клиентов — тоже есть и не пустой.
    expect(/filename="[^"]+"/.test(header)).toBe(true);
  });

  it("латинское имя проходит без изменений", async () => {
    const lecture = await lectureMod();
    const header = lecture.contentDisposition("lecture_42.md");
    expect(header).toContain('filename="lecture_42.md"');
    expect(header).toContain("filename*=UTF-8''lecture_42.md");
  });

  it("кавычки и запрещённые символы не ломают заголовок", async () => {
    const lecture = await lectureMod();
    const header = lecture.contentDisposition('Отчёт "важный" <2026>.md');
    expect(header).toMatch(/^[\x20-\x7E]+$/);
    expect(header).not.toContain('filename="Отчёт "важный"');
  });

  it("кириллическое имя не превращается в «______.md»", async () => {
    const lecture = await lectureMod();
    const header = lecture.contentDisposition("Лекция.md");
    // ASCII-фолбэк осмысленный (нейтральное имя с тем же расширением).
    expect(header).toContain('filename="lecture.md"');
    expect(header).toMatch(/^[\x20-\x7E]+$/);
    // А настоящее имя не потеряно.
    expect(decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(header)![1])).toBe("Лекция.md");
  });

  it("пустое имя не оставляет заголовок без файла", async () => {
    const lecture = await lectureMod();
    const header = lecture.contentDisposition("");
    expect(header).toMatch(/^[\x20-\x7E]+$/);
    expect(header).toContain("filename=");
    expect(header).not.toContain('filename=""');
  });

  it("имя MD-файла — это название лекции (поэтому заголовок и падал)", async () => {
    const lecture = await lectureMod();
    const { stmts } = req("../server/db");
    const info = stmts.lectureInsert.run("Лекция по матанализу", 16000, 1);
    const id = Number(info.lastInsertRowid);
    stmts.chunkInsert.run(id, 1, 0, 5000, "chunk_00001.wav", { status: "done", text: "Текст лекции" });
    const md = lecture.exportContent(id, "md", { mode: "off" });
    expect(md.name).toBe("Лекция по матанализу.md");
    // А вот заголовок из него — уже безопасный.
    expect(lecture.contentDisposition(md.name)).toMatch(/^[\x20-\x7E]+$/);
    // srt/vtt имена не зависят от названия — потому раньше и не падали.
    expect(lecture.exportContent(id, "srt", { mode: "off" }).name).toBe(`lecture_${id}.srt`);
    expect(lecture.exportContent(id, "vtt", { mode: "off" }).name).toBe(`lecture_${id}.vtt`);
  });
});
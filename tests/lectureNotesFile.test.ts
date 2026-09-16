import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Заметки лекции должны жить не только в JSON-сторе, но и в storage/notes/
 * обычным .md файлом — «полная синхронизация»:
 *   • ИИ-конспект (кнопка и авто-режим) сразу создаёт файл;
 *   • кнопка «Сохранить заметки» и маркер важного пишут в ТОТ ЖЕ файл;
 *   • файл, удалённый вручную, восстанавливается с тем же id;
 *   • удаление лекции убирает и её файл (нет «осиротевших» .md).
 *
 * Модули берём через require (как сервер): динамический import() дал бы ДРУГОЙ
 * экземпляр модуля и другую копию стор-таблиц (см. tests/lectureConspectus.test.ts).
 */
const req = createRequire(import.meta.url);

beforeAll(() => {
  // storage подменяем ДО загрузки server/*: config читает MOONAPP_STORAGE при require.
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-notesfile-"));
});

function lectureMod(): any {
  return req("../server/lecture");
}

function notesDir(): string {
  return req("../server/config").DIRS.notes;
}

/** Файлы заметок конкретной лекции: имя = {noteId}-{slug}.md */
function filesFor(noteId: number): string[] {
  return fs.readdirSync(notesDir()).filter((f) => f.endsWith(".md") && f.startsWith(`${noteId}-`));
}

function readFile(name: string): string {
  return fs.readFileSync(path.join(notesDir(), name), "utf8");
}

/** Провайдер-заглушка: сеть в тестах не трогаем (как в lectureConspectus.test.ts). */
function fakeTarget(reply: (prompt: string) => string) {
  return {
    provider: {
      id: "fake",
      chat: async ({ messages }: { messages: { text: string }[] }) =>
        reply(messages.map((m) => m.text).join("\n")),
    },
    secret: "test-key",
    model: "fake-model",
    cfg: {
      providerId: "fake", model: "fake-model",
      chunkChars: 400, overlapChars: 120, maxChunks: 3, temperature: 0.3,
    },
  };
}

/** Лекция с готовой расшифровкой (текст чанка пишем прямо в стор). */
function sessionWithChunks(title: string, text: string) {
  const { stmts } = req("../server/db");
  const info = stmts.lectureInsert.run(title, 16000, 1);
  const id = Number(info.lastInsertRowid);
  stmts.chunkInsert.run(id, 1, 40000, 60000, "chunk_00001.wav", { status: "done", text, error: "" });
  return { id, stmts };
}

describe("Заметки лекции → .md файл в storage/notes", () => {
  it("ИИ-конспект (кнопка) создаёт .md файл с frontmatter и конспектом", async () => {
    const lecture = lectureMod();
    const { id, stmts } = sessionWithChunks("Матанализ", "Предел функции и производная. ".repeat(20));
    const target = fakeTarget((prompt) =>
      prompt.includes("=== ФРАГМЕНТ ===") ? "заметка по фрагменту" : "## Обзор\nКонспект лекции про пределы");

    await lecture.generateConspectus(id, { target });

    // Связь «лекция → заметка» запоминается в самой лекции: иначе следующий
    // прогон завёл бы второй файл вместо обновления первого.
    const noteId = Number(stmts.lectureGet.get(id).notes_note_id);
    expect(noteId).toBeGreaterThan(0);

    const files = filesFor(noteId);
    expect(files).toHaveLength(1);
    const body = readFile(files[0]);
    expect(body).toContain("## Обзор");
    expect(body).toContain("Конспект лекции про пределы");
    // frontmatter: заголовок с названием и датой, метка и папка для внешних читателей
    expect(body).toMatch(/title: "Лекция: Матанализ \(\d{4}-\d{2}-\d{2}\)"/);
    expect(body).toContain("tags: \"lecture\"");
    expect(body).toContain("folder: \"lectures\"");
  });

  it("повторная сборка конспекта дописывает в ТОТ ЖЕ файл (копий нет)", async () => {
    const lecture = lectureMod();
    const { id, stmts } = sessionWithChunks("Физика", "Второй закон Ньютона. ".repeat(20));
    const target = fakeTarget((prompt) =>
      prompt.includes("=== ФРАГМЕНТ ===") ? "черновик" : "## Конспект\nПервый прогон");

    await lecture.generateConspectus(id, { target });
    const noteId = Number(stmts.lectureGet.get(id).notes_note_id);
    const first = filesFor(noteId);
    expect(first).toHaveLength(1);

    // Пришла новая расшифровка → материалы дособрали: файл должен быть тот же.
    stmts.chunkInsert.run(id, 2, 60000, 80000, "chunk_00002.wav", { status: "done", text: "Импульс тела. ".repeat(20) });
    const target2 = fakeTarget(() => "## Конспект\nВторой прогон");
    await lecture.generateConspectus(id, { target: target2 });

    const after = filesFor(noteId);
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(first[0]);          // имя файла не изменилось
    const body = readFile(after[0]);
    expect(body).toContain("Первый прогон");  // накопление, а не перезапись
    expect(body).toContain("Второй прогон");
  });

  it("правки заметок и маркер важного пишут в файл, удалённый файл восстанавливается", () => {
    const lecture = lectureMod();
    const { id, stmts } = sessionWithChunks("История", "Реформа и её последствия. ".repeat(10));

    // Кнопка «Сохранить заметки» (PATCH /api/lecture/:id)
    lecture.setNotes(id, "# Мои заметки\nпервая строка");
    const noteId = Number(stmts.lectureGet.get(id).notes_note_id);
    const files = filesFor(noteId);
    expect(files).toHaveLength(1);
    expect(readFile(files[0])).toContain("# Мои заметки");

    // Маркер важного (Ctrl+B / F2): таймкод-чекбокс тоже попадает в файл
    lecture.addMarker(id, 65000, "Разбор примера");
    expect(readFile(files[0])).toContain("- [ ] **[00:01:05]** Разбор примера");

    // Файл удалили с диска вручную: следующая правка создаёт его заново с тем же
    // id (иначе лекция молча осталась бы без зеркала). Удаляем unlinkSync, а не
    // rmSync: на Windows rmSync не удаляет файлы с кириллическими именами (см.
    // server/ts/fsUtil.ts) — иначе «ручное удаление» в тесте ничего бы не удаляло.
    fs.unlinkSync(path.join(notesDir(), files[0]));
    expect(filesFor(noteId)).toHaveLength(0);

    const notes = String(stmts.lectureGet.get(id).notes || "");
    lecture.setNotes(id, `${notes}\nдописано после удаления`);
    const restored = filesFor(noteId);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toBe(files[0]);
    expect(readFile(restored[0])).toContain("дописано после удаления");
  });

  // Авто-режим (maybeAutoConspectus → generateConspectus) пишет .md тем же
  // кодом, что и кнопка: отдельный тест ему не нужен, запуск авто-сборки уже
  // проверяется в tests/lectureConspectus.test.ts.

  it("backfill заводит .md для лекций, записанных до синхронизации", () => {
    const lecture = lectureMod();
    const { stmts } = req("../server/db");
    // Лекция «как из старой версии»: заметки есть, notes_note_id нет — файла на
    // диске не существует, пока не сработает backfill (server/index.js на старте).
    const id = Number(stmts.lectureInsert.run("Старая лекция", 16000, 1).lastInsertRowid);
    stmts.lectureUpdate.run(id, { notes: "# Старый конспект" });
    expect(Number(stmts.lectureGet.get(id).notes_note_id) || 0).toBe(0);

    expect(lecture.backfillNotesFiles()).toBe(1);

    const noteId = Number(stmts.lectureGet.get(id).notes_note_id);
    expect(noteId).toBeGreaterThan(0);
    const files = filesFor(noteId);
    expect(files).toHaveLength(1);
    expect(readFile(files[0])).toContain("# Старый конспект");

    // Лекция без заметок пустого .md не создаёт: backfill больше ничего не заводит.
    const emptyId = Number(stmts.lectureInsert.run("Без заметок", 16000, 1).lastInsertRowid);
    expect(lecture.backfillNotesFiles()).toBe(0);
    expect(Number(stmts.lectureGet.get(emptyId).notes_note_id) || 0).toBe(0);
  });

  it("удаление лекции убирает её .md файл", () => {
    const lecture = lectureMod();
    const { id, stmts } = sessionWithChunks("Химия", "Органическая химия. ".repeat(10));
    lecture.setNotes(id, "черновик конспекта");
    const noteId = Number(stmts.lectureGet.get(id).notes_note_id);
    expect(filesFor(noteId)).toHaveLength(1);

    lecture.deleteSession(id);

    expect(filesFor(noteId)).toHaveLength(0);
    expect(stmts.lectureGet.get(id)).toBeUndefined();
  });
});
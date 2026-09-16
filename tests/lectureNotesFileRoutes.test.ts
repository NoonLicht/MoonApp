import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Заметки лекции → .md в storage/notes: проверка через РЕАЛЬНЫЙ HTTP-роут.
 *
 * Юнит-тесты (tests/lectureNotesFile.test.ts) дёргают функции модуля напрямую, а
 * здесь проверяется весь путь пользователя: PATCH /api/lecture/:id (кнопка
 * «Сохранить заметки»), POST /:id/markers (маркер Ctrl+B/F2) и DELETE /:id.
 * Файл должен создаваться, обновляться и удаляться — это и есть «полная
 * синхронизация» заметок с диском.
 *
 * Модули грузим через createRequire: роутер и модуль лекций обязаны быть в одном
 * инстансе (см. tests/lectureEngineRoutes.test.ts).
 */
const req = createRequire(import.meta.url);

describe("Заметки лекции → storage/notes (HTTP-роут)", () => {
  let srv: any = null;
  let base = "";
  let storage = "";

  /** Папка заметок приложения (та же, что пишет server/notes-fs.js). */
  const notesDir = () => req("../server/config").DIRS.notes;

  /** Имя .md для лекции = {noteId}-{slug}.md, noteId хранится в самой лекции. */
  function noteIdOf(id: number): number {
    return Number(req("../server/db").stmts.lectureGet.get(id)?.notes_note_id) || 0;
  }

  function filesForNote(noteId: number): string[] {
    if (noteId <= 0) return [];
    return fs.readdirSync(notesDir()).filter((f) => f.endsWith(".md") && f.startsWith(`${noteId}-`));
  }

  function filesForLecture(id: number): string[] {
    return filesForNote(noteIdOf(id));
  }

  async function call(method: string, p: string, body?: any) {
    const res = await fetch(`${base}/api/lecture${p}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-notes-routes-"));
    process.env.MOONAPP_STORAGE = storage;

    const express = req("express");
    const router = req("../server/routes/lecture");
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/lecture", router);
    await new Promise<void>((resolve) => { srv = app.listen(0, "127.0.0.1", () => resolve()); });
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  afterAll(() => {
    try { srv?.close(); } catch { /* noop */ }
    try { req("../server/fsUtil").removePath(storage); } catch { /* noop */ }
  });

  it("создаёт сессию, сохраняет заметки и заводит .md в storage/notes", async () => {
    const s = await call("POST", "/sessions", { title: "Матанализ", sampleRate: 16000, channels: 1 });
    expect(s.status).toBe(201);
    const id = Number(s.body.id);
    expect(id).toBeGreaterThan(0);

    // storage изолирован: заметки пишутся в storage/notes этого прогона, а не в
    // рабочий каталог приложения.
    expect(notesDir()).toBe(path.join(storage, "notes"));

    const r = await call("PATCH", `/${id}`, { notes: "# Конспект\nпервая строка" });
    expect(r.status).toBe(200);

    const files = filesForLecture(id);
    expect(files).toHaveLength(1);
    const body = fs.readFileSync(path.join(notesDir(), files[0]), "utf8");
    expect(body).toContain("# Конспект");
    expect(body).toContain("первая строка");
    expect(body).toMatch(/title: "Лекция: Матанализ \(\d{4}-\d{2}-\d{2}\)"/);

    await call("DELETE", `/${id}`);
  });

  it("повторное сохранение и маркер обновляют тот же файл, удаление лекции — убирает", async () => {
    const s = await call("POST", "/sessions", { title: "Физика", sampleRate: 16000, channels: 1 });
    const id = Number(s.body.id);

    await call("PATCH", `/${id}`, { notes: "черновик" });
    const noteId = noteIdOf(id);
    expect(noteId).toBeGreaterThan(0);
    const first = filesForNote(noteId);
    expect(first).toHaveLength(1);

    // Маркер важного (Ctrl+B/F2) дописывает таймкод-чекбокс в тот же файл.
    const m = await call("POST", `/${id}/markers`, { atMs: 65000, label: "Импульс" });
    expect(m.status).toBe(201);
    const after = filesForNote(noteId);
    expect(after).toEqual(first); // имя файла не изменилось — копий нет
    expect(fs.readFileSync(path.join(notesDir(), after[0]), "utf8"))
      .toContain("- [ ] **[00:01:05]** Импульс");

    // Удаление лекции убирает и её .md (нет «осиротевших» файлов). Фильтруем по
    // СОХРАНЁННОМУ noteId: после удаления лекции его уже негде взять.
    const d = await call("DELETE", `/${id}`);
    expect(d.status).toBe(200);
    expect(filesForNote(noteId)).toHaveLength(0);
  });
});
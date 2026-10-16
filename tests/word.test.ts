import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import os from "os";
import path from "path";
import fs from "fs";

/**
 * Страница «Документы»: сайдкар-ядро текстового редактора (native/wordcore).
 * Проверки живого ядра пропускаются, если бинарник не собран (`npm run build:wordcore`).
 */

const nodeRequire = createRequire(__filename);
type Core = typeof import("../server/office/wordCore");

let core: Core;
beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-word-"));
  core = nodeRequire("../server/office/wordCore") as Core;
});

afterAll(() => core?.closeAll());

describe("поиск ядра", () => {
  it("кандидаты включают переменную окружения, storage и локальную сборку", () => {
    const list = core.binCandidates().join("\n");
    expect(list).toContain(path.join("native", "wordcore", "target", "release"));
    expect(list).toContain(path.join(process.env.MOONAPP_STORAGE as string, "office"));
  });

  it("без ядра сеанс не открывается понятной ошибкой", async () => {
    const prev = process.env.MOONAPP_WORDCORE;
    const real = core.status().available;
    if (real) return; // ядро есть — проверка ниже, с живым процессом
    await expect(core.open({})).rejects.toThrow("core_not_installed");
    process.env.MOONAPP_WORDCORE = prev;
  });
});

describe("живое ядро", () => {
  const available = (): boolean => core.status().available;

  it("ввод, форматирование, выделение и страница как PNG", async () => {
    if (!available()) return;
    const { id, state } = (await core.open({})) as { id: string; state: { pages: unknown[] } };
    expect(state.pages).toHaveLength(1);

    const typed = (await core.call(id, "view.type", { text: "Привет, мир! Это тест ядра." })) as {
      words: number;
      dirty: boolean;
      caret: { x: number };
    };
    expect(typed.words).toBe(5);
    expect(typed.dirty).toBe(true);
    expect(typed.caret.x).toBeGreaterThan(72);

    const bold = (await core.call(id, "view.key", { key: "B", ctrl: true })) as {
      typing: { bold?: boolean };
    };
    expect(bold.typing.bold).toBe(true);

    const sel = (await core.call(id, "view.key", { key: "Left", shift: true })) as {
      selection: { text: string; rects: unknown[] };
    };
    expect(sel.selection.text).toHaveLength(1);
    expect(sel.selection.rects.length).toBeGreaterThan(0);

    const clicked = (await core.call(id, "view.click", { page: 0, x: 100, y: 80 })) as {
      caret: { page: number };
    };
    expect(clicked.caret.page).toBe(0);

    const r = (await core.call(id, "ui.render", { page: 1, scale: 1 })) as {
      png: string;
      width: number;
    };
    const bytes = Buffer.from(r.png, "base64");
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(r.width).toBe(612);

    const failed = core.call(id, "engine.execute", { command: "нет.такой", params: {} });
    await expect(failed).rejects.toThrow();
    // после ошибки сеанс жив
    expect(((await core.call(id, "view.state")) as { words: number }).words).toBe(5);
    expect(core.close(id)).toBe(true);
  }, 60_000);

  it("сохранение в docx и повторное открытие даёт тот же текст", async () => {
    if (!available()) return;
    const { id } = await core.open({});
    await core.call(id, "view.type", { text: "Проверка круга" });
    const file = path.join(process.env.MOONAPP_STORAGE as string, "round.docx");
    await core.call(id, "engine.execute", { command: "file.saveAs", params: { path: file } });
    expect(fs.statSync(file).size).toBeGreaterThan(1000);
    core.close(id);

    const again = await core.open({ file });
    const inspected = (await core.call(again.id, "document.inspect")) as {
      blocks: { text: string }[];
    };
    expect(inspected.blocks[0].text).toBe("Проверка круга");
    core.close(again.id);
  }, 60_000);
});

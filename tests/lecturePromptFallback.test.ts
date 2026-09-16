import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Регресс-тесты «пустой расшифровки» в Лектории.
 *
 * Что случилось в бою: пользователь включал GPU (сборка CUDA), модель на пару
 * секунд поднималась в видеопамять, движок молча завершался с кодом 0, а в UI
 * было «нечего расшифровывать». На процессоре та же лекция считалась нормально.
 *
 * Причина оказалась не в видеокарте: на длинную русскую подсказку
 * (--prompt из настроек) large-v3-turbo отвечает ПУСТЫМ SRT — воспроизводится и
 * на CPU (`-ng`) той же сборкой. Проверено на живом прогоне: с подсказкой —
 * 0 байт за ~2 с, без неё — нормальный текст.
 *
 * Поэтому расшифровка повторяется без --prompt, а перед каждым прогоном
 * удаляется прошлый .srt: whisper-cli создаёт файл только когда нашёл текст, и
 * иначе «нечего расшифровывать» показывал бы огрызок предыдущего прогона.
 *
 * Тесты не зависят от железа и наличия whisper-cli: прогон подменяется стабом.
 */

beforeAll(() => {
  // Изолируем storage: config читает MOONAPP_STORAGE при require, поэтому
  // подменяем путь ДО импорта модулей (как в tests/lectureEngine.test.ts).
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-prompt-"));
});

function engine(): Promise<any> {
  return import("../server/whisperEngine");
}
function lecture(): Promise<any> {
  return import("../server/lecture");
}

describe("whisperEngine — подсказка распознавания в аргументах", () => {
  it("по умолчанию уходит --prompt из настроек лекции", async () => {
    const e = await engine();
    const args = e.transcribeArgs("m.bin", "a.wav", "out");
    const i = args.indexOf("--prompt");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(e.initialPrompt());
    expect(args).toContain("-osrt");
  });

  it("prompt: null убирает флаг целиком (повтор без подсказки)", async () => {
    const e = await engine();
    const args = e.transcribeArgs("m.bin", "a.wav", "out", { prompt: null });
    expect(args).not.toContain("--prompt");
    // Остальные флаги на месте: откат не должен менять набор вывода/потоков.
    expect(args).toContain("-osrt");
    expect(args).toContain("-t");
  });

  it("пустая подсказка — это не откат: флаг остаётся (поведение как раньше)", async () => {
    const e = await engine();
    const args = e.transcribeArgs("m.bin", "a.wav", "out", { prompt: "" });
    expect(args).toContain("--prompt");
  });

  it("needsPromptlessRetry: пусто + была подсказка → повтор, иначе нет", async () => {
    const e = await engine();
    expect(e.needsPromptlessRetry("", "лекция")).toBe(true);
    expect(e.needsPromptlessRetry("   ", "лекция")).toBe(true);
    expect(e.needsPromptlessRetry("", "")).toBe(false);
    expect(e.needsPromptlessRetry("", null)).toBe(false);
    expect(e.needsPromptlessRetry("текст есть", "лекция")).toBe(false);
  });
});
describe("lecture — откат прогона без подсказки", () => {
  it("пустой прогон повторяется без --prompt и помечается promptless", async () => {
    const L = await lecture();
    const calls: string[][] = [];
    const runner = async (_bin: string, args: string[]) => {
      calls.push(args);
      // Первый прогон — «модель поднялась и промолчала», второй — текст.
      return calls.length === 1
        ? { text: "", segments: [] }
        : { text: "Здравствуйте", segments: [{ text: "Здравствуйте" }] };
    };
    const res = await L.transcribeFile("bin", "model", "a.wav", "a", {}, runner);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--prompt");
    expect(calls[1]).not.toContain("--prompt");
    expect(res.text).toBe("Здравствуйте");
    expect(res.promptless).toBe(true);
  });

  it("успешный прогон не повторяется (лишний запуск модели — это секунды)", async () => {
    const L = await lecture();
    const calls: string[][] = [];
    const runner = async (_bin: string, args: string[]) => {
      calls.push(args);
      return { text: "текст", segments: [{ text: "текст" }] };
    };
    const res = await L.transcribeFile("bin", "model", "a.wav", "a", {}, runner);
    expect(calls).toHaveLength(1);
    expect(res.promptless).toBe(false);
  });

  it("без подсказки в настройках повтор не запускается даже на пустом ответе", async () => {
    const L = await lecture();
    const e = await engine();
    const settings = require("../server/settings");
    const before = e.initialPrompt();
    try {
      // Пустая подсказка = повторять нечего: пустой ответ так и остаётся пустым.
      settings.set({ lecture: { initialPrompt: "" } });
      let calls = 0;
      const runner = async () => {
        calls++;
        return { text: "", segments: [] };
      };
      const res = await L.transcribeFile("bin", "model", "a.wav", "a", {}, runner);
      expect(calls).toBe(1);
      expect(res.promptless).toBe(false);
    } finally {
      settings.set({ lecture: { initialPrompt: before } });
    }
  });
});

describe("lecture — чтение результата прогона", () => {
  it("берёт сегменты из SRT, а если файла нет — текст из stdout", async () => {
    const L = await lecture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-read-"));
    const base = path.join(dir, "chunk");
    fs.writeFileSync(
      base + ".srt",
      "1\n00:00:00,000 --> 00:00:02,000\nПервый\n\n2\n00:00:02,000 --> 00:00:04,000\nВторой\n",
    );
    const fromSrt = L.readChunkResult(base, "мусор из stdout");
    expect(fromSrt.text).toBe("Первый Второй");
    expect(fromSrt.segments).toHaveLength(2);
    fs.rmSync(base + ".srt", { force: true });
    const fromStdout = L.readChunkResult(base, "  текст  из  вывода ");
    expect(fromStdout.text).toBe("текст из вывода");
    expect(fromStdout.segments).toHaveLength(0);
  });

  it("прогон удаляет прошлый .srt: огрызок предыдущего чанка не выдаётся за ответ", async () => {
    const L = await lecture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-stale-"));
    const base = path.join(dir, "chunk");
    // Огрызок предыдущего прогона, который whisper-cli не перезапишет, если
    // текст не найден (файл создаётся только при наличии результата).
    fs.writeFileSync(base + ".srt", "1\n00:00:00,000 --> 00:00:01,000\nСтарый текст\n");
    // «Движок», который молча завершается с кодом 0 и ничего не пишет.
    const res = await L.runWhisper(process.execPath, ["-e", "process.exit(0)"], base);
    expect(res.text).toBe("");
    expect(fs.existsSync(base + ".srt")).toBe(false);
  });
});

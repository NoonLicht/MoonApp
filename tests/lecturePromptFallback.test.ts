import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Откат «без подсказки» при пустой расшифровке Whisper GGUF.
 *
 * На длинную русскую подсказку часть моделей отвечает пустотой, а без неё —
 * нормальным текстом. Поэтому пустой прогон повторяется без initial prompt.
 * Движок подменяется стабом: тесты не зависят от железа и наличия моделей.
 */
beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-prompt-"));
});

const require = createRequire(import.meta.url);

/** Подменяем методы настоящих модулей (сервер собран в CommonJS, vi.mock его require не видит). */
function setup(replies: string[]) {
  const calls: { prompt?: string }[] = [];
  const gguf = require("../server/asrGguf");
  const giga = require("../server/gigaamEngine");
  vi.spyOn(gguf, "isInstalled").mockReturnValue(true);
  vi.spyOn(giga, "isInstalled").mockReturnValue(false);
  vi.spyOn(gguf, "transcribeWav").mockImplementation(async (_p: string, o: { prompt?: string }) => {
    calls.push(o);
    const text = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { text, segments: text ? [{ start: 0, end: 1, text }] : [] };
  });
  const asr = require("../server/lectureAsr");
  return { asr, calls };
}

describe("lectureAsr — откат прогона без подсказки", () => {
  afterEach(() => vi.restoreAllMocks());

  it("пустой прогон повторяется без подсказки и помечается promptless", async () => {
    const { asr, calls } = setup(["", "Здравствуйте"]);
    const res = await asr.transcribeFile("a.wav");
    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).toBeTruthy();
    expect(calls[1].prompt).toBeUndefined();
    expect(res.text).toBe("Здравствуйте");
    expect(res.promptless).toBe(true);
  });

  it("успешный прогон не повторяется", async () => {
    const { asr, calls } = setup(["текст"]);
    const res = await asr.transcribeFile("a.wav");
    expect(calls).toHaveLength(1);
    expect(res.promptless).toBe(false);
  });

  it("allowRetry=false (черновик стриминга) не запускает повтор", async () => {
    const { asr, calls } = setup([""]);
    const res = await asr.transcribeFile("a.wav", {}, false);
    expect(calls).toHaveLength(1);
    expect(res.text).toBe("");
  });

  it("галлюцинации на тишине вырезаются, зацикленные повторы схлопываются", async () => {
    const { asr } = setup(["x"]);
    expect(asr.sanitizeText("Спасибо за просмотр!")).toBe("");
    expect(asr.sanitizeText("вот так вот так вот так")).toBe("вот так");
  });
});

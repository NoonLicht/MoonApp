import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";

// ВАЖНО: MOONAPP_STORAGE выставляется ДО первого require любого модуля,
// тянущего server/config.js — тот вычисляет STORAGE_DIR один раз при загрузке
// модуля (eagerly), а не лениво. Если выставить его позже (например, в
// beforeAll после того, как что-то уже успело require'нуть config.js), пути
// останутся указывать на настоящий storage/ рядом с исходниками — и тест
// писал бы в РЕАЛЬНЫЕ файлы пользователя. Ровно так это и произошло при первой
// версии теста (исправлено переносом присвоения сюда, до всех require).
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-quicknotes-"));
process.env.MOONAPP_STORAGE = storage;

const req = createRequire(import.meta.url);
const engine: typeof import("../server/quickNotes") = req("../server/quickNotes");

const { detectFfmpeg } = req("../server/convertEngine") as {
  detectFfmpeg(): Promise<{ found: boolean; ffmpeg: string | null }>;
};
// Вендорный ffmpeg (server/vendor/ffmpeg) не зависит от STORAGE_DIR, поэтому
// находится даже в изолированном тестовом хранилище.
const ffDetected = await detectFfmpeg();
const ffmpegBin: string | null = ffDetected.found ? ffDetected.ffmpeg : null;

// А вот модели whisper физически лежат в НАСТОЯЩЕМ storage/whisper — в
// изолированном тестовом STORAGE_DIR их нет и не будет, поэтому здесь
// whisperReady детерминированно false. Полный сквозной прогон с реальным
// распознаванием речи проверен вручную (см. итоговый отчёт по фиче) — здесь
// автоматически покрывается путь "whisper не установлен", что тоже реальный
// сценарий (у части пользователей движок ещё не настроен).
const whisperEngineProbe = req("../server/whisperEngine") as {
  findBin(): string | null;
  findModel(): string | null;
};
const whisperReady = !!(whisperEngineProbe.findBin() && whisperEngineProbe.findModel());

function makeSilentWav(): string {
  if (!ffmpegBin) throw new Error("ffmpeg not found for test setup");
  const out = path.join(storage, "in.wav");
  execFileSync(ffmpegBin, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1", out], {
    stdio: "ignore",
  });
  return out;
}

describe("server/quickNotes — CRUD и конвейер распознавания (изолированное хранилище)", () => {
  it("list/remove на пустом хранилище работают без падений", () => {
    expect(engine.list()).toEqual([]);
    expect(engine.remove("no-such-id")).toBe(false);
  });

  it.runIf(!!ffmpegBin && !whisperReady)(
    "честная ошибка whisper_not_installed, когда движок распознавания не настроен",
    async () => {
      const wav = makeSilentWav();
      await expect(
        engine.transcribeAndSave({ audioPath: wav, originalExt: ".wav", keepAudio: false }),
      ).rejects.toThrow("whisper_not_installed");
    },
  );

  it.runIf(!!ffmpegBin && whisperReady)(
    "реальный сквозной прогон: ffmpeg-конвертация → whisper → сохранение → список → аудио на диске → удаление",
    async () => {
      const wav = makeSilentWav();
      const note = await engine.transcribeAndSave({ audioPath: wav, originalExt: ".wav", keepAudio: true });
      expect(note.id).toBeTruthy();
      expect(typeof note.text).toBe("string");
      expect(note.audioFile).toBeTruthy();
      expect(note.durationSec).toBeGreaterThan(0);

      const list = engine.list();
      expect(list.some((n) => n.id === note.id)).toBe(true);
      expect(fs.existsSync(path.join(storage, "quicknotes", note.audioFile!))).toBe(true);

      expect(engine.remove(note.id)).toBe(true);
      expect(engine.list().some((n) => n.id === note.id)).toBe(false);
      expect(fs.existsSync(path.join(storage, "quicknotes", note.audioFile!))).toBe(false);
    },
    30000,
  );
});

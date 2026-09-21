import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/convertEngine, переведённого на TS (server/ts/convertEngine.ts →
 * server/convertEngine.js).
 *
 * Проверяем то, на что опираются потребители (routes/convert.js, compressor.js,
 * encoders.js, sitebak.js, tts.js — все берут detectFfmpeg, роут ещё и CATEGORIES/
 * extOf/tools/convert/installStatus): форму модуля для require(), разбор форматов
 * и поведение без установленного FFmpeg — оно не должно «притворяться успехом».
 * Реальный запуск FFmpeg здесь не нужен: PATH на время проверки пустой, поэтому
 * поиск бинаря заведомо не находит ничего. server/vendor/ffmpeg (комплект
 * инсталлятора, см. scripts/fetch-engines.js) на время этих тестов тоже
 * отводится в сторону — иначе на машине разработчика, где движки уже
 * скачаны, «без FFmpeg» переставало быть правдой.
 */
const req = createRequire(import.meta.url);

let engine: any;
let storage: string;
const realPath = process.env.PATH;
const VENDOR_FFMPEG_DIR = path.join(__dirname, "..", "server", "vendor", "ffmpeg");
const VENDOR_FFMPEG_HIDDEN = `${VENDOR_FFMPEG_DIR}.hidden-for-tests`;
const vendorWasPresent = fs.existsSync(VENDOR_FFMPEG_DIR);

beforeAll(() => {
  if (vendorWasPresent) fs.renameSync(VENDOR_FFMPEG_DIR, VENDOR_FFMPEG_HIDDEN);
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-convert-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/convertEngine");
});

afterAll(() => {
  if (vendorWasPresent) fs.renameSync(VENDOR_FFMPEG_HIDDEN, VENDOR_FFMPEG_DIR);
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
});

describe("server/convertEngine — форма модуля и форматы", () => {
  it("require() отдаёт те же 8 имён, что и .js-версия (без { default })", () => {
    expect(engine.default).toBeUndefined();
    for (const name of [
      "CATEGORIES",
      "extOf",
      "categoryOf",
      "detectFfmpeg",
      "tools",
      "convert",
      "installFfmpeg",
      "installStatus",
    ]) {
      expect(engine[name], name).toBeDefined();
    }
    expect(typeof engine.detectFfmpeg).toBe("function");
    expect(typeof engine.convert).toBe("function");
  });

  it("extOf снимает точку и приводит к нижнему регистру, мусор → пустая строка", () => {
    expect(engine.extOf("Clip.MP4")).toBe("mp4");
    expect(engine.extOf("a.b.MkV")).toBe("mkv");
    expect(engine.extOf("noext")).toBe("");
    expect(engine.extOf(null)).toBe("");
    expect(engine.extOf(undefined)).toBe("");
  });

  it("categoryOf раскладывает расширения по категориям, неизвестное → null", () => {
    expect(engine.categoryOf("song.mp3").id).toBe("audio");
    expect(engine.categoryOf("pic.PNG").id).toBe("image");
    expect(engine.categoryOf("movie.mkv").id).toBe("video");
    expect(engine.categoryOf("archive.rar")).toBeNull();
    expect(engine.categoryOf("")).toBeNull();
  });

  it("в каталоге три категории, и gif есть и на входе видео, и на выходе", () => {
    const ids = engine.CATEGORIES.map((c: { id: string }) => c.id);
    expect(ids).toEqual(["video", "audio", "image"]);
    const video = engine.CATEGORIES.find((c: { id: string }) => c.id === "video");
    expect(video.inputs).toContain("gif");
    expect(video.outputs).toContain("gif");
  });

  it("без FFmpeg detectFfmpeg честно сообщает found:false, а tools().ready — false", async () => {
    process.env.PATH = "";
    const ff = await engine.detectFfmpeg({ force: true });
    expect(ff.found).toBe(false);
    expect(ff.path).toBeNull();

    process.env.PATH = "";
    const t = await engine.tools();
    expect(t.ready).toBe(false);
    expect(t.categories).toHaveLength(3);
  });

  it("convert() без FFmpeg падает с 'ffmpeg not found', а не создаёт пустой файл", async () => {
    process.env.PATH = "";
    const out = path.join(storage, "out.mp3");
    await expect(
      engine.convert({ inputPath: path.join(storage, "in.wav"), to: "mp3", outPath: out }),
    ).rejects.toThrow("ffmpeg not found");
    expect(fs.existsSync(out)).toBe(false);
  });

  it("installStatus отражает наличие локального бинаря (кнопка установки в UI)", () => {
    const fresh = engine.installStatus();
    expect(fresh.state).toBe("idle");
    expect(fresh.installed).toBe(false);

    const binDir = path.join(storage, "ffmpeg");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "ffmpeg.exe"), "stub", "utf8");
    expect(engine.installStatus().installed).toBe(true);
  });

  it("ищет ffmpeg и в подпапках storage/ffmpeg (архив распакован «как скачалось»)", async () => {
    // Архив с gyan.dev распаковывается в ffmpeg-<версия>-essentials_build/bin/ —
    // бинарь лежит на два уровня глубже, и раньше его не находили (в UI при этом
    // было «FFmpeg не установлен», хотя файл лежал в storage).
    const nested = path.join(storage, "ffmpeg", "ffmpeg-9.0-essentials_build", "bin");
    fs.mkdirSync(nested, { recursive: true });
    const stub = path.join(nested, "ffmpeg.exe");
    fs.writeFileSync(stub, "stub", "utf8");

    expect(engine.ffmpegSearchPaths()).toContain(stub);

    // Заглушка не запускается → бинарь НЕ считается найденным: UI не должен врать.
    process.env.PATH = "";
    const ff = await engine.detectFfmpeg({ force: true });
    expect(ff.found).toBe(false);
  });
});

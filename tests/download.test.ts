import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { createRequire } from "module";

/**
 * Скачивание файла на диск (server/ts/download.ts -> server/download.js)
 * и общий фронтенд-хелпер saveBlob (src/utils/download.ts).
 *
 * До фазы 1 код downloadTo лежал двумя копиями (diarize.js и whisperEngine.js) —
 * они различались только строкой User-Agent, но поведение обязано быть
 * одинаковым: потоковая запись (пакеты по 40 МБ не влезают в память), удаление
 * недокачанного файла при ошибке/отмене, прогресс по каждому пакету. Здесь
 * проверяем ПОВЕДЕНИЕ на реальном HTTP-сервере, а не реализацию.
 */
const req = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..");
const readFile = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8");

let tmpDir = "";
let server: http.Server;
let baseUrl = "";

/** Режимы тестового сервера: как он отвечает на запрос. */
let mode: "ok" | "notfound" | "nolen" | "fail-mid" = "ok";
const BODY = Buffer.alloc(64 * 1024, 7);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-download-"));
  server = http.createServer((req2, res) => {
    if (mode === "notfound") {
      res.writeHead(404).end("нет");
      return;
    }
    if (mode === "nolen") {
      // Без Content-Length: total должен остаться 0, а файл — докачаться.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(BODY);
      return;
    }
    if (mode === "fail-mid") {
      res.writeHead(200, { "content-length": String(BODY.length) });
      res.write(BODY.subarray(0, 1024));
      // Рвём соединение до конца: клиент обязан удалить недокачанный файл.
      setTimeout(() => res.destroy(), 10);
      return;
    }
    res.writeHead(200, { "content-length": String(BODY.length) });
    res.end(BODY);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}/file`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function download(): any {
  return req("../server/download");
}

/**
 * Контракт: реализация скачивания и сохранения blob существует в одном месте.
 * Если копия вернётся в один из файлов, поведение снова разъедется (как это уже
 * случилось с копиями User-Agent), поэтому проверяем исходники.
 */
describe("контракт: единый модуль скачивания вместо копий", () => {
  it("diarize.js и whisperEngine.js берут потоковую запись из server/download", () => {
    for (const name of ["diarize.js", "whisperEngine.js"]) {
      const src = readFile("server", name);
      expect(src, `${name}: нет require("./download")`).toContain('require("./download")');
      expect(src, `${name}: вернулась своя потоковая запись`).not.toContain("createWriteStream");
      expect(src, `${name}: вернулась копия fetch-цикла`).not.toContain(
        "for await (const chunk of",
      );
    }
  });

  it("User-Agent остался разным у двух движков (sherpa и whisper.cpp)", () => {
    expect(readFile("server", "diarize.js")).toContain("sherpa-onnx diarization");
    expect(readFile("server", "whisperEngine.js")).toContain("whisper.cpp");
  });

  it("страницы не держат своих копий saveBlob", () => {
    // SettingsPage/LectureRecorderPage — исходные две копии (0.2.x); MusicPage,
    // VideoPage, AudiobookTTSPage и ConverterPage остались с ручной сборкой
    // <a download> после первой унификации и переведены на общий хелпер.
    const pages = [
      "SettingsPage.tsx",
      "LectureRecorderPage.tsx",
      "MusicPage.tsx",
      "VideoPage.tsx",
      "AudiobookTTSPage.tsx",
      "ConverterPage.tsx",
    ];
    for (const name of pages) {
      const src = readFile("src", "pages", name);
      expect(src, `${name}: вернулась локальная копия`).not.toMatch(/function saveBlob\s*\(/);
      expect(src, `${name}: нет импорта общего хелпера`).toContain('from "../utils/download"');
      // Ручная сборка <a download> — это и есть копия тела saveBlob.
      expect(src, `${name}: ручное скачивание вернулось`).not.toMatch(
        /document\.createElement\("a"\)/,
      );
    }
  });

  it("saveBlob объявлен ровно один раз во фронтенде", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(root, "src"));
    const owners = files.filter((f) => /export function saveBlob/.test(fs.readFileSync(f, "utf8")));
    expect(owners.map((f) => path.relative(root, f))).toEqual([
      path.join("src", "utils", "download.ts"),
    ]);
  });

  it("общий серверный модуль и его артефакт на месте", () => {
    expect(readFile("server", "ts", "download.ts")).toContain(
      "export async function downloadToFile",
    );
    expect(readFile("server", "download.js")).toContain("exports.downloadToFile");
  });
});

describe("downloadToFile — потоковая запись, прогресс и очистка", () => {
  it("скачивает файл целиком и возвращает число записанных байт", async () => {
    mode = "ok";
    const dest = path.join(tmpDir, "ok.bin");
    const got = await download().downloadToFile(baseUrl, dest, { userAgent: "MoonApp/test" });
    expect(got).toBe(BODY.length);
    expect(fs.readFileSync(dest)).toEqual(BODY);
  });

  it("сообщает прогресс: сначала total с нулём, затем реально записанные байты", async () => {
    mode = "ok";
    const seen: Array<{ total: number; received: number }> = [];
    await download().downloadToFile(baseUrl, path.join(tmpDir, "prog.bin"), {
      userAgent: "MoonApp/test",
      onProgress: (p: { total: number; received: number }) => seen.push({ ...p }),
    });
    expect(seen[0]).toEqual({ total: BODY.length, received: 0 });
    const last = seen[seen.length - 1];
    expect(last.received).toBe(BODY.length);
    // Прогресс монотонный — по нему UI считает проценты.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].received).toBeGreaterThanOrEqual(seen[i - 1].received);
    }
  });

  it("без Content-Length считает total = 0, но файл докачивает", async () => {
    mode = "nolen";
    const dest = path.join(tmpDir, "nolen.bin");
    const got = await download().downloadToFile(baseUrl, dest, { userAgent: "MoonApp/test" });
    expect(got).toBe(BODY.length);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("HTTP-ошибка -> download_http_404, файл не создаётся", async () => {
    mode = "notfound";
    const dest = path.join(tmpDir, "404.bin");
    await expect(
      download().downloadToFile(baseUrl, dest, { userAgent: "MoonApp/test" }),
    ).rejects.toThrowError(/download_http_404/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("отмена до старта -> ошибка cancelled и файла нет", async () => {
    mode = "ok";
    const dest = path.join(tmpDir, "cancel.bin");
    await expect(
      download().downloadToFile(baseUrl, dest, {
        userAgent: "MoonApp/test",
        shouldCancel: () => true,
      }),
    ).rejects.toThrowError(/cancelled/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("обрыв связи -> недокачанный файл удаляется (не выглядит готовым)", async () => {
    mode = "fail-mid";
    const dest = path.join(tmpDir, "broken.bin");
    await expect(
      download().downloadToFile(baseUrl, dest, { userAgent: "MoonApp/test" }),
    ).rejects.toBeTruthy();
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("создаёт каталог назначения, если его ещё нет", async () => {
    mode = "ok";
    const dest = path.join(tmpDir, "нет-такого-каталога", "deep", "file.bin");
    await download().downloadToFile(baseUrl, dest, { userAgent: "MoonApp/test" });
    expect(fs.existsSync(dest)).toBe(true);
  });
});

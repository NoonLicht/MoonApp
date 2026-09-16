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
let mode: "ok" | "notfound" | "nolen" | "fail-mid" | "redirect" = "ok";
const BODY = Buffer.alloc(64 * 1024, 7);
/** Заголовки последнего запроса: проверяем, что opts.headers доходят до сервера. */
let lastHeaders: http.IncomingHttpHeaders = {};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-download-"));
  server = http.createServer((req2, res) => {
    lastHeaders = req2.headers;
    // Адрес после редиректа отдаёт тело как обычно — иначе редирект зациклился бы.
    if (req2.url?.startsWith("/redirected/")) {
      res.writeHead(200, { "content-length": String(BODY.length) });
      res.end(BODY);
      return;
    }
    if (mode === "redirect") {
      res.writeHead(302, { location: "/redirected/release-1.2.3.bin" });
      res.end();
      return;
    }
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

/**
 * Опции, из-за которых шесть копий цикла загрузки нельзя было свести к одной:
 * лимит размера (у установщиков движков и store он свой), дополнительные
 * заголовки (store добавляет Referer), путь от адреса после редиректов (GitHub
 * уводит релиз на objects.githubusercontent.com) и тексты ошибок для UI.
 */
describe("downloadToFile — opts: лимит размера, заголовки, resolveDest, тексты", () => {
  it("без maxBytes файл качается целиком (лимит по умолчанию не задан)", async () => {
    mode = "ok";
    const dest = path.join(tmpDir, "no-limit.bin");
    const got = await download().downloadToFile(baseUrl, dest, { userAgent: "MoonApp/test" });
    expect(got).toBe(BODY.length);
  });

  it("Content-Length больше лимита -> отказ до записи, файла нет", async () => {
    mode = "ok";
    const dest = path.join(tmpDir, "too-big.bin");
    await expect(
      download().downloadToFile(baseUrl, dest, { userAgent: "MoonApp/test", maxBytes: 10 }),
    ).rejects.toThrowError(/больше допустимого размера/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("без Content-Length лимит ловится по факту, недокачанный файл удаляется", async () => {
    mode = "nolen";
    const dest = path.join(tmpDir, "too-big-stream.bin");
    await expect(
      download().downloadToFile(baseUrl, dest, { userAgent: "MoonApp/test", maxBytes: 100 }),
    ).rejects.toThrowError(/больше допустимого размера/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("свой текст ошибки превышения лимита получает байты и сам лимит", async () => {
    mode = "ok";
    const seen: number[] = [];
    // Лимит заведомо меньше тела: Content-Length больше -> отказ ещё до записи.
    const limit = 1024;
    await expect(
      download().downloadToFile(baseUrl, path.join(tmpDir, "custom-limit.bin"), {
        userAgent: "MoonApp/test",
        maxBytes: limit,
        tooLargeText: (bytes: number, max: number) => {
          seen.push(bytes, max);
          return `Файл слишком большой (${bytes} байт), лимит ${max} байт`;
        },
      }),
    ).rejects.toThrowError(`Файл слишком большой (${BODY.length} байт), лимит ${limit} байт`);
    expect(seen).toEqual([BODY.length, limit]);
  });

  it("httpErrorText заменяет download_http_<status>", async () => {
    mode = "notfound";
    await expect(
      download().downloadToFile(baseUrl, path.join(tmpDir, "custom-http.bin"), {
        userAgent: "MoonApp/test",
        httpErrorText: (status: number) => `HTTP ${status} при скачивании FFmpeg`,
      }),
    ).rejects.toThrowError("HTTP 404 при скачивании FFmpeg");
  });

  it("interruptedPrefix добавляется к обрыву связи", async () => {
    mode = "fail-mid";
    await expect(
      download().downloadToFile(baseUrl, path.join(tmpDir, "prefix.bin"), {
        userAgent: "MoonApp/test",
        interruptedPrefix: "Загрузка прервана: ",
      }),
    ).rejects.toThrowError(/^Загрузка прервана: /);
  });

  it("interruptedPrefix не переписывает свои ошибки (HTTP и отмену)", async () => {
    mode = "notfound";
    await expect(
      download().downloadToFile(baseUrl, path.join(tmpDir, "prefix-http.bin"), {
        userAgent: "MoonApp/test",
        interruptedPrefix: "Загрузка прервана: ",
      }),
    ).rejects.toThrowError(/^download_http_404$/);

    mode = "ok";
    await expect(
      download().downloadToFile(baseUrl, path.join(tmpDir, "prefix-cancel.bin"), {
        userAgent: "MoonApp/test",
        interruptedPrefix: "Загрузка прервана: ",
        shouldCancel: () => true,
      }),
    ).rejects.toThrowError(/^cancelled$/);
  });

  it("opts.headers уходят на сервер вместе с User-Agent", async () => {
    mode = "ok";
    await download().downloadToFile(baseUrl, path.join(tmpDir, "headers.bin"), {
      userAgent: "MoonApp/test",
      headers: { Accept: "*/*", Referer: "http://127.0.0.1/" },
    });
    expect(lastHeaders["user-agent"]).toBe("MoonApp/test");
    expect(lastHeaders["accept"]).toBe("*/*");
    expect(lastHeaders["referer"]).toBe("http://127.0.0.1/");
  });

  it("resolveDest вычисляет путь по адресу ПОСЛЕ редиректов", async () => {
    mode = "redirect";
    const dest = path.join(tmpDir, "до-редиректа.bin");
    const got = await download().downloadToFile(baseUrl, dest, {
      userAgent: "MoonApp/test",
      resolveDest: (finalUrl: string) =>
        path.join(tmpDir, "из-url-" + path.basename(new URL(finalUrl).pathname)),
    });
    expect(got).toBe(BODY.length);
    // Имя взято из адреса после редиректа, а не из исходной ссылки.
    expect(fs.existsSync(path.join(tmpDir, "из-url-release-1.2.3.bin"))).toBe(true);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("mb() округляет байты до мегабайт (для текстов ошибок о размере)", () => {
    expect(download().mb(0)).toBe(0);
    expect(download().mb(3 * 1024 ** 2)).toBe(3);
    expect(download().mb(1536 * 1024)).toBe(2);
  });
});

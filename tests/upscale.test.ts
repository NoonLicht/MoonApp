import { describe, it, expect, beforeAll, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт страницы «Апскейл медиа» без реального инференса.
 *
 * ONNX-моделей и самого рантайма в CI нет, поэтому проверяем то, что от них не
 * зависит и чаще всего ломается при правках: нормализацию параметров, математику
 * тайлинга и целевых размеров, сборку ffmpeg-команд потокового пайплайна,
 * каталог моделей из манифеста и наличие роутов/папок хранилища.
 */
const req = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..");

let engine: any;
let pipe: any;

beforeAll(() => {
  // config читает MOONAPP_STORAGE при require — уводим хранилище во временный каталог.
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-upscale-"));
  engine = req("../server/upscale");
  pipe = req("../server/upscalePipeline");
});

describe("апскейл: каталог моделей и правки манифеста", () => {
  const root = path.resolve(__dirname, "..");
  const manifestFile = path.join(root, "server", "models.manifest.json");

  it("manifest — источник ссылок: url/sha256 у моделей, id и file обязательны", () => {
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      _note?: string;
      models: { id: string; label: string; file: string; url: string; sha256: string }[];
    };
    // Именно этот файл правит пользователь, добавляя ссылки на скачивание.
    expect(typeof m._note).toBe("string");
    expect(m._note).toContain("models/upscale");
    expect(m.models.length).toBeGreaterThan(10);
    const ids = new Set<string>();
    for (const x of m.models) {
      expect(x.id, JSON.stringify(x)).toBeTruthy();
      expect(x.file).toMatch(/\.onnx$/);
      expect(typeof x.url).toBe("string");
      // id уникален: по нему идут скачивание/удаление/запуск.
      expect(ids.has(x.id)).toBe(false);
      ids.add(x.id);
    }
    // Скачивание возможно только там, где задан url — иначе в панели нет кнопки.
    expect(m.models.filter((x) => x.url).length).toBeGreaterThan(0);
  });

  it("файл в storage/models/upscale сразу делается «скачанным»", () => {
    // Проверяем то, чем пользуется пользователь, не трогая манифест: подложенный
    // .onnx с именем из поля file показывается как установленный (available).
    const model = engine.listModels().find((m: { file: string }) => /\.onnx$/.test(m.file));
    expect(model).toBeTruthy();
    const file = path.join(model.path);
    const existed = fs.existsSync(file);
    const restore = existed ? fs.readFileSync(file) : null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!existed) fs.writeFileSync(file, Buffer.from([0x00]));
      const after = engine.listModels().find((m: { id: string }) => m.id === model.id) as {
        available: boolean;
      };
      expect(after.available, `${model.id} должен считаться скачанным`).toBe(true);
    } finally {
      // Не оставляем мусор: возвращаем каталог в исходное состояние.
      if (existed && restore) fs.writeFileSync(file, restore);
      else if (!existed) fs.rmSync(file, { force: true });
    }
  });

  it("каталог перечитывается по времени правки (без перезапуска сервера)", () => {
    // Правку манифеста (новые ссылки) должно быть видно сразу после сохранения,
    // а смена источника (скачанный → вшитый) — сама инвалидировать кэш.
    const src = fs.readFileSync(path.join(root, "server", "ts", "upscale.ts"), "utf8");
    expect(src).toContain("mtimeMs");
    expect(src).toMatch(/manifestCache\?\.key === key/);
    expect(src).toContain("userManifestFile()");
    expect(src).toContain("bundledManifestFile()");
    // Битый/пустой файл не должен обнулять каталог: берём следующий источник,
    // а последний удачный список остаётся как есть.
    expect(src).toMatch(/if \(!manifestCache\) manifestCache = \{ key: ""/);
    expect(src).toContain("sanitizeManifest");
  });

  it("scripts/manifest.js — тот же приоритет источников, что у сервера", () => {
    const m = req("../scripts/manifest");
    // Скачанный каталог важнее вшитого: его создаёт кнопка «Обновить каталог».
    expect(m.userManifestFile()).toBe(
      path.join(process.env.MOONAPP_STORAGE as string, "models", "models.manifest.json"),
    );
    expect(m.bundledManifestFile()).toContain(path.join("server", "models.manifest.json"));
    const read = m.readManifest();
    expect(read.file).toBe(m.manifestFile());
    expect(read.models.length).toBeGreaterThan(10);
    // Скрипты обязаны ходить через этот резолвер, а не по своему пути.
    for (const s of ["fetch-models.js", "verify-model.js"]) {
      const src = fs.readFileSync(path.join(root, "scripts", s), "utf8");
      expect(src, s).toContain(`require("./manifest")`);
      expect(src, s).not.toContain(`"server", "models.manifest.json"`);
    }
    // --url позволяет проверить модель, ещё не записанную в манифест.
    const verify = fs.readFileSync(path.join(root, "scripts", "verify-model.js"), "utf8");
    expect(verify).toContain("--update-manifest");
  });

  it("в каталоге моделей — массовые «Скачать все»/«Удалить все» и обновление каталога", () => {
    // Кнопку «Обновить» (перечитать локальный список) заменили массовые операции:
    // «Скачать все» добирает файлы всех моделей, «Удалить все» чистит диск.
    // Без «Обновить каталог» новая модель приходила бы только с обновлением приложения.
    const panel = fs.readFileSync(
      path.join(root, "src", "pages", "upscale", "parts", "UpscaleModelsPanel.tsx"),
      "utf8",
    );
    expect(panel).toContain("up.mdlDownloadAll");
    expect(panel).toContain("onDownloadAll");
    expect(panel).toContain("up.mdlDeleteAll");
    expect(panel).toContain("onRemoveAll");
    // Удаление необратимо — подтверждаем; прогресс: «{done} из {total}».
    expect(panel).toContain("up.mdlDeleteAllConfirm");
    expect(panel).toContain("up.mdlBulkDone");
    expect(panel).not.toContain("up.mdlRefresh");
    expect(panel).not.toContain("onRefresh");
    expect(panel).toContain("onSync");
    expect(panel).toContain("up.mdlSync");
    // Строка «откуда каталог»: видно, что список пришёл из GitHub и когда.
    expect(panel).toContain("up.mdlSrcRemote");
    expect(panel).toContain("up.mdlSrcBundled");
    const page = fs.readFileSync(
      path.join(root, "src", "pages", "upscale", "UpscalePage.tsx"),
      "utf8",
    );
    // Массовые операции идут последовательно: сервер качает/удаляет по одному файлу.
    expect(page).toContain("downloadAllModels");
    expect(page).toContain("removeAllModels");
    expect(page).toMatch(/onDownloadAll=\{downloadAllModels\}/);
    expect(page).toMatch(/onRemoveAll=\{removeAllModels\}/);
    expect(page).toContain("upscaleSyncModels");
    expect(page).toMatch(/onSync=\{syncModels\}/);
  });
});

describe("живой каталог моделей: манифест из GitHub", () => {
  const root = path.resolve(__dirname, "..");
  const userManifest = (): string =>
    path.join(process.env.MOONAPP_STORAGE as string, "models", "models.manifest.json");

  afterEach(() => {
    // Скачанный каталог — состояние одного теста, а не всего файла.
    fs.rmSync(userManifest(), { force: true });
  });

  /** Локальный HTTP-сервер вместо GitHub: отдаёт ровно то, что скажут. */
  async function serve(text: string, status = 200): Promise<{ url: string; close: () => void }> {
    const http = req("http") as typeof import("http");
    const srv = http.createServer((_q, s) => {
      s.writeHead(status, { "content-type": "application/json" });
      s.end(text);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}/models.manifest.json`,
      close: () => {
        (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        srv.close();
      },
    };
  }

  /**
   * Минимальный zip-writer: наш распаковщик CRC не проверяет, поэтому пишем
   * только заголовки, имена и данные (deflate или store).
   */
  function makeZip(entries: { name: string; data: Buffer }[], deflate = true): Buffer {
    const zlib = req("zlib") as typeof import("zlib");
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
      const name = Buffer.from(e.name, "utf8");
      const comp = deflate ? zlib.deflateRawSync(e.data) : e.data;
      const method = deflate ? 8 : 0;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(method, 8);
      lh.writeUInt32LE(comp.length, 18);
      lh.writeUInt32LE(e.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, comp);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt32LE(comp.length, 20);
      ch.writeUInt32LE(e.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(offset, 42);
      central.push(ch, name);
      offset += 30 + name.length + comp.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  }

  it("sanitizeManifest отбрасывает опасные записи и чистит поля", () => {
    const list = engine.sanitizeManifest({
      models: [
        {
          id: "ok",
          label: "Ok",
          file: "ok.onnx",
          scale: 4,
          arch: "rrdb",
          sizeMb: 12,
          license: "MIT",
          url: "https://example.com/ok.onnx",
          sha256: "A".repeat(64),
          tags: ["photo", "ПЛОХОЙ-ТЕГ"],
          rec: { tile: 256, overlap: 16, denoise: 999 },
        },
        // Файл с разделителями пути увёл бы загрузку из папки моделей.
        { id: "escape", file: "../../../secrets.json" },
        { id: "noext", file: "model.bin" },
        { id: "badurl", file: "b.onnx", url: "file:///C:/Windows/system32/calc.exe" },
        { id: "badsha", file: "s.onnx", sha256: "не-хеш" },
        { id: "ok", file: "dup.onnx" }, // дубликат id
        null,
      ],
    });
    expect(list.map((m: { id: string }) => m.id)).toEqual(["ok", "badurl", "badsha"]);
    expect(list[0].url).toBe("https://example.com/ok.onnx");
    expect(list[0].sha256).toBe("a".repeat(64)); // приведён к нижнему регистру
    expect(list[0].tags).toEqual(["photo"]); // мусорный тег отброшен
    // Записи с негодными ссылкой/хешем остаются, но «обезврежены»: url "" = нет
    // кнопки «Скачать», sha256 "" = загрузка без сверки (как у моделей без хеша).
    expect(list[1].url).toBe("");
    expect(list[2].sha256).toBe("");
    // Значения вне диапазона зажимаются: 999 % шума → 100.
    expect(list[0].rec).toEqual({ tile: 256, overlap: 16, denoise: 100 });
    // Пустой url — это «нет кнопки скачать», а не битая запись.
    expect(engine.sanitizeManifest({ models: [{ id: "x", file: "x.onnx" }] })[0].url).toBe("");
    expect(engine.sanitizeManifest({})).toEqual([]);
    expect(engine.sanitizeManifest(null)).toEqual([]);
    expect(engine.sanitizeManifest("не-объект")).toEqual([]);
  });

  it("строгая проверка не теряет ни одной модели текущего каталога", () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, "server", "models.manifest.json"), "utf8"),
    ) as { models: Record<string, unknown>[] };
    const clean = engine.sanitizeManifest(raw) as Record<string, unknown>[];
    expect(clean.length).toBe(raw.models.length);
    for (const [i, m] of raw.models.entries()) {
      for (const k of [
        "id",
        "file",
        "label",
        "arch",
        "license",
        "url",
        "sha256",
        "kind",
        "scale",
        "_hint",
        "_measured",
      ]) {
        if (m[k] === undefined) continue;
        expect(clean[i][k], `${String(m.id)}.${k}`).toEqual(m[k]);
      }
      expect(clean[i].tags, String(m.id)).toEqual(m.tags || []);
      expect(clean[i].rec, String(m.id)).toEqual(m.rec || undefined);
    }
  });

  it("по умолчанию каталог вшитый, адрес обновления — GitHub", () => {
    const info = engine.manifestInfo();
    expect(info.source).toBe("bundled");
    expect(info.url).toContain("github");
    expect(info.count).toBeGreaterThan(10);
    expect(engine.manifestUrls()[0]).toBe(info.url);
  });

  it("подменяемый адрес каталога берётся из MOONAPP_MANIFEST_URL", () => {
    process.env.MOONAPP_MANIFEST_URL = "https://example.com/my/catalog.json";
    try {
      const urls = engine.manifestUrls();
      expect(urls[0]).toBe("https://example.com/my/catalog.json");
      // Зеркала остаются: свой адрес не должен ломать запасной вариант.
      expect(urls.length).toBeGreaterThan(1);
      expect(engine.manifestInfo().url).toBe("https://example.com/my/catalog.json");
    } finally {
      delete process.env.MOONAPP_MANIFEST_URL;
    }
  });

  it("«Обновить каталог» скачивает манифест и подменяет список моделей", async () => {
    const doc = {
      _note: "тестовый каталог",
      models: [
        {
          id: "probe-x4",
          label: "Probe x4",
          file: "probe-x4.onnx",
          scale: 4,
          arch: "rrdb",
          sizeMb: 12.5,
          license: "MIT",
          url: "https://example.com/probe-x4.onnx",
          tags: ["photo"],
          rec: { scale: 2, tile: 256 },
        },
        {
          id: "probe-interp",
          label: "Probe Interp",
          kind: "interp",
          mult: 2,
          file: "probe-interp.onnx",
          inputSig: "l1r1",
          scale: 1,
          arch: "rife",
          sizeMb: 8,
          license: "MIT",
          url: "https://example.com/probe-interp.onnx",
          tags: ["interp"],
        },
      ],
    };
    const srv = await serve(JSON.stringify(doc));
    try {
      const r = await engine.syncManifest({ url: srv.url, timeoutMs: 5000 });
      expect(r.count).toBe(2);
      expect([...r.added].sort()).toEqual(["probe-interp", "probe-x4"]);
      // Каталог подменяется целиком: вшитые модели скрыты, пока файл на месте.
      expect(engine.listModels().map((m: { id: string }) => m.id)).toEqual([
        "probe-x4",
        "probe-interp",
      ]);
      expect(engine.interpModels().map((m: { id: string }) => m.id)).toEqual(["probe-interp"]);
      // Файл лежит в storage (переживёт перезапуск) — это и есть «живой каталог».
      expect(fs.existsSync(userManifest())).toBe(true);
      const info = engine.manifestInfo();
      expect(info.source).toBe("remote");
      expect(info.count).toBe(2);
      expect(info.updatedAt).toBeTruthy();
      // Повторное обновление тем же файлом ничего не «добавляет».
      const again = await engine.syncManifest({ url: srv.url, timeoutMs: 5000 });
      expect(again.added).toEqual([]);
      expect(again.removed).toEqual([]);
    } finally {
      srv.close();
    }
  });

  it("битый, пустой и недоступный каталог не подменяют работающий", async () => {
    const before = engine.listModels().map((m: { id: string }) => m.id);
    const bad = await serve("{ это не JSON");
    const empty = await serve(JSON.stringify({ models: [] }));
    const gone = await serve("nope", 404);
    try {
      await expect(engine.syncManifest({ url: bad.url, timeoutMs: 5000 })).rejects.toThrow(
        "manifest_invalid",
      );
      await expect(engine.syncManifest({ url: empty.url, timeoutMs: 5000 })).rejects.toThrow(
        "manifest_empty",
      );
      await expect(engine.syncManifest({ url: gone.url, timeoutMs: 5000 })).rejects.toThrow(
        "http_404",
      );
      // Каталог не тронут: ни списка, ни файла в storage.
      expect(engine.listModels().map((m: { id: string }) => m.id)).toEqual(before);
      expect(fs.existsSync(userManifest())).toBe(false);
    } finally {
      bad.close();
      empty.close();
      gone.close();
    }
  });

  it("недоступный адрес — переводимая ошибка, а не падение сервера", async () => {
    // Порт 1 закрыт: fetch падает, панель покажет «нет связи с GitHub».
    await expect(
      engine.syncManifest({ url: "http://127.0.0.1:1/x.json", timeoutMs: 2000 }),
    ).rejects.toThrow("manifest_fetch");
  });

  it("удаление скачанного каталога возвращает вшитый (офлайн)", async () => {
    const srv = await serve(
      JSON.stringify({ models: [{ id: "only-one", file: "only-one.onnx", scale: 4 }] }),
    );
    try {
      await engine.syncManifest({ url: srv.url, timeoutMs: 5000 });
      expect(engine.manifestInfo().source).toBe("remote");
      expect(engine.listModels().length).toBe(1);
    } finally {
      srv.close();
    }
    fs.rmSync(userManifest(), { force: true });
    expect(engine.manifestInfo().source).toBe("bundled");
    expect(engine.listModels().length).toBeGreaterThan(10);
  });

  it("скачанный каталог важнее вшитого и для скриптов", async () => {
    const srv = await serve(
      JSON.stringify({ models: [{ id: "script-only", file: "script-only.onnx", scale: 4 }] }),
    );
    try {
      await engine.syncManifest({ url: srv.url, timeoutMs: 5000 });
      const m = req("../scripts/manifest");
      expect(m.manifestFile()).toBe(userManifest());
      expect(m.readManifest().models.map((x: { id: string }) => x.id)).toEqual(["script-only"]);
    } finally {
      srv.close();
    }
  });

  it("zip-модель (как у Qualcomm): граф, внешние веса и удаление", async () => {
    // Так раздаёт модели Qualcomm: внутри архива граф, отдельный файл весов и
    // метаданные, всё в подпапке. Наш движок должен разложить это рядом.
    const zip = makeZip([
      { name: "real_esrgan_x4plus-onnx-float/", data: Buffer.alloc(0) },
      { name: "real_esrgan_x4plus-onnx-float/model.onnx", data: Buffer.from("ONNXGRAPH") },
      { name: "real_esrgan_x4plus-onnx-float/model.data", data: Buffer.from("W".repeat(2048)) },
      { name: "real_esrgan_x4plus-onnx-float/metadata.json", data: Buffer.from("{}") },
    ]);
    const http = req("http") as typeof import("http");
    let catalog = "";
    const srv = http.createServer((q, s) => {
      if (String(q.url).endsWith(".zip")) {
        s.writeHead(200, { "content-type": "application/zip" });
        s.end(zip);
        return;
      }
      s.writeHead(200, { "content-type": "application/json" });
      s.end(catalog);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    catalog = JSON.stringify({
      models: [
        {
          id: "zip-probe",
          label: "Zip Probe",
          file: "zip-probe.onnx",
          scale: 4,
          arch: "rrdb",
          sizeMb: 1,
          license: "BSD-3-Clause",
          // sha256 — хеш самого архива: содержимое проверяется целиком.
          sha256: crypto.createHash("sha256").update(zip).digest("hex"),
          url: `http://127.0.0.1:${port}/model.zip`,
          tags: ["photo"],
        },
      ],
    });
    const dir = path.join(process.env.MOONAPP_STORAGE as string, "models", "upscale");
    try {
      await engine.syncManifest({
        url: `http://127.0.0.1:${port}/models.manifest.json`,
        timeoutMs: 5000,
      });
      const r = await engine.downloadModel("zip-probe");
      expect(r.ok).toBe(true);
      // Граф — под именем из каталога, веса и метаданные — рядом с ним.
      expect(fs.readFileSync(path.join(dir, "zip-probe.onnx"), "utf8")).toBe("ONNXGRAPH");
      expect(fs.existsSync(path.join(dir, "model.data"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "metadata.json"))).toBe(true);
      // Индекс: по нему «Удалить» уберёт и веса, а не только граф.
      const index = JSON.parse(
        fs.readFileSync(path.join(dir, "zip-probe.onnx.files.json"), "utf8"),
      ) as string[];
      expect(index).toContain("model.data");
      expect(engine.listModels().find((m: { id: string }) => m.id === "zip-probe")?.available).toBe(
        true,
      );
      // Повторное скачивание без force не качает заново (файл уже на диске).
      expect((await engine.downloadModel("zip-probe")).ok).toBe(true);
      expect(engine.removeModel("zip-probe").removed).toBe(true);
      for (const f of [
        "zip-probe.onnx",
        "zip-probe.onnx.files.json",
        "model.data",
        "metadata.json",
      ]) {
        expect(fs.existsSync(path.join(dir, f)), f).toBe(false);
      }
    } finally {
      srv.close();
    }
  });

  it("битый архив и архив без ONNX — понятные ошибки", () => {
    expect(() => engine.extractZipEntries(Buffer.from("это не zip"))).toThrow("zip_invalid");
    expect(() =>
      engine.extractOnnxFromZip(makeZip([{ name: "readme.txt", data: Buffer.from("нет модели") }])),
    ).toThrow("zip_no_onnx");
    // Архив без сжатия тоже читаем (метод store).
    const stored = engine.extractZipEntries(
      makeZip([{ name: "m.onnx", data: Buffer.from("MODEL") }], false),
    ) as { name: string; data: Buffer }[];
    expect(stored.length).toBe(1);
    expect(stored[0].data.toString()).toBe("MODEL");
    // Два файла с одним basename затрут друг друга — это отказ, а не тихая ошибка.
    expect(() =>
      engine.extractZipEntries(
        makeZip([
          { name: "a/m.onnx", data: Buffer.from("1") },
          { name: "b/m.onnx", data: Buffer.from("2") },
        ]),
      ),
    ).toThrow("zip_invalid");
  });
});

describe("upscalePipeline: чистые функции кадрового конвейера", () => {
  it("parseFps понимает дробную и целую запись", () => {
    expect(pipe.parseFps("30000/1001")).toBeCloseTo(29.97, 2);
    expect(pipe.parseFps("25")).toBe(25);
    expect(pipe.parseFps("")).toBe(0);
    expect(pipe.parseFps("0/0")).toBe(0);
    expect(pipe.parseFps({} as unknown as string)).toBe(0);
  });

  it("planFrames считает кадры и не падает без длительности", () => {
    expect(pipe.planFrames(10, 25)).toBe(250);
    expect(pipe.planFrames(0, 25)).toBe(0);
    expect(pipe.planFrames(10, 0)).toBe(0);
  });

  it("frameBytes — это rgb24-кадр", () => {
    expect(pipe.frameBytes(4, 3)).toBe(36);
    expect(pipe.frameBytes(0, 3)).toBe(0);
  });

  it("распаковка идёт rawvideo/rgb24 в stdout", () => {
    const args = pipe.buildDecodeArgs("in.mp4");
    expect(args).toContain("rawvideo");
    expect(args).toContain("rgb24");
    expect(args[args.length - 1]).toBe("-");
    expect(args).toContain("in.mp4");
  });

  it("сборка копирует звук и субтитры копией, а видео перекодирует", () => {
    const args = pipe.buildEncodeArgs({
      fps: 25,
      outWidth: 3840,
      outHeight: 2160,
      inputPath: "in.mkv",
      outFile: "out.mkv",
      encoder: "libx265",
      qualityArgs: ["-crf", "20"],
      audioAction: "copy",
      hasSubs: true,
    });
    const s = args.join(" ");
    expect(s).toContain("-f rawvideo");
    expect(s).toContain("-s 3840x2160");
    expect(s).toContain("-c:v libx265");
    expect(s).toContain("-crf 20");
    expect(s).toContain("-c:a copy");
    expect(s).toContain("-c:s copy");
    expect(s).toContain("-map 1:a?");
    expect(s).toContain("-map 1:s?");
  });

  it("при aac звук перекодируется, а субтитры не трогаются", () => {
    const s = pipe
      .buildEncodeArgs({
        fps: 24,
        outWidth: 1920,
        outHeight: 1080,
        inputPath: "in.mp4",
        outFile: "out.mp4",
        encoder: "libx264",
        qualityArgs: ["-crf", "18"],
        audioAction: "aac",
        hasSubs: false,
      })
      .join(" ");
    expect(s).toContain("-c:a aac");
    expect(s).not.toContain("-c:s");
  });

  it("результат с субтитрами уходит в mkv", () => {
    expect(pipe.outFileName("clip.mp4", true)).toBe("clip_upscaled.mkv");
    expect(pipe.outFileName("clip.mp4", false)).toBe("clip_upscaled.mp4");
  });
});

describe("upscale: параметры, тайлинг и размеры", () => {
  it("normalizeParams клампует значения и чинит неизвестные строки", () => {
    const p = engine.normalizeParams({
      model: "realesr-general-x4v3",
      scale: 99,
      tile: 99999,
      overlap: 9999,
      threads: 100,
      quality: 1000,
      sharpen: -10,
      denoise: 500,
      provider: "nonsense",
      format: "exe",
      vcodec: "nope",
      audioAction: "nope",
      vcrf: 99,
      targetW: 999999,
    });
    expect(p.scale).toBe(4); // не из списка → дефолт
    expect(p.tile).toBe(4096);
    expect(p.overlap).toBe(128);
    expect(p.threads).toBe(64);
    expect(p.quality).toBe(100);
    expect(p.sharpen).toBe(0);
    expect(p.denoise).toBe(100);
    expect(p.provider).toBe("auto");
    expect(p.format).toBe("png");
    expect(p.vcodec).toBe("x264");
    expect(p.audioAction).toBe("copy");
    expect(p.vcrf).toBe(51);
    expect(p.targetW).toBe(32768);
  });

  it("вторая модель без веса получает 50%, а без модели вес сбрасывается", () => {
    const p = engine.normalizeParams({
      model: "realesr-general-x4v3",
      model2: "ultrasharp",
      blendAmount: 0,
    });
    expect(p.model2).toBe("ultrasharp");
    expect(p.blendAmount).toBe(50);

    const q = engine.normalizeParams({
      model: "realesr-general-x4v3",
      model2: "",
      blendAmount: 80,
    });
    expect(q.blendAmount).toBe(0);
  });

  it("одна и та же модель дважды не считается смешиванием", () => {
    const p = engine.normalizeParams({
      model: "ultrasharp",
      model2: "ultrasharp",
      blendAmount: 40,
    });
    expect(p.model2).toBe("");
    expect(p.blendAmount).toBe(0);
  });

  it("тайлинг без размера — один тайл, иначе сетка с перекрытием", () => {
    expect(engine.tileRects(100, 50, 0, 16)).toEqual([{ x: 0, y: 0, w: 100, h: 50 }]);
    expect(engine.tileRects(100, 50, 512, 16)).toEqual([{ x: 0, y: 0, w: 100, h: 50 }]);

    const rects = engine.tileRects(1000, 600, 256, 16);
    expect(rects.length).toBeGreaterThan(1);
    for (const r of rects) {
      expect(r.w).toBeLessThanOrEqual(256);
      expect(r.h).toBeLessThanOrEqual(256);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1000);
      expect(r.y + r.h).toBeLessThanOrEqual(600);
    }
    // Крайние тайлы прижаты к краю картинки — «дыры» недопустимы.
    expect(rects.some((r: any) => r.x + r.w === 1000)).toBe(true);
    expect(rects.some((r: any) => r.y + r.h === 600)).toBe(true);
  });

  it("targetDims держит пропорцию и чётность сторон", () => {
    expect(engine.targetDims(1920, 1080, 2, 0, 0)).toEqual({ w: 3840, h: 2160 });
    expect(engine.targetDims(1920, 1080, 4, 1280, 0)).toEqual({ w: 1280, h: 720 });
    expect(engine.targetDims(1920, 1080, 1, 0, 540)).toEqual({ w: 960, h: 540 });
  });

  it("buildFilters добавляет scale только при расхождении с нативным размером", () => {
    const same = engine.buildFilters({
      srcW: 100,
      srcH: 100,
      nativeScale: 4,
      scale: 4,
      targetW: 0,
      targetH: 0,
      sharpen: 0,
    });
    expect(same).toEqual([]);

    const resized = engine.buildFilters({
      srcW: 100,
      srcH: 100,
      nativeScale: 4,
      scale: 2,
      targetW: 0,
      targetH: 0,
      sharpen: 20,
    });
    expect(resized[0]).toContain("scale=200:200");
    expect(resized[1]).toContain("unsharp");
  });

  it("картинки и видео различаются по расширению, имя результата — по формату", () => {
    expect(engine.isImageFile("a.PNG")).toBe(true);
    expect(engine.isImageFile("a.mkv")).toBe(false);
    expect(engine.photoOutName("photo.jpeg", "jpeg")).toBe("photo_upscaled.jpg");
    expect(engine.photoOutName("photo.png", "webp")).toBe("photo_upscaled.webp");
  });
});

describe("upscale: каталог моделей и системные пресеты", () => {
  it("манифест читается и содержит модели с обязательными полями", () => {
    const models = engine.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      expect(m.file).toMatch(/\.onnx$/);
      expect(["upscale", "interp"], m.id).toContain(m.kind);
      // Множитель апскейла есть у апскейлеров; у интерполяторов — число кадров
      // пары, поэтому проверяем соответственно виду модели.
      // Множитель апскейла есть у апскейлеров; у интерполяторов — число кадров
      // пары, поэтому проверяем соответственно виду модели. ×1 — модели
      // восстановления (dejpeg/denoise/detail): они не меняют размер кадра.
      if (m.kind === "upscale") expect([1, 2, 3, 4], m.id).toContain(m.scale);
      expect(typeof m.available).toBe("boolean");
      expect(typeof m.path).toBe("string");
    }
    expect(models.some((m: any) => m.url.startsWith("http"))).toBe(true);
  });

  it("пресеты покрывают фото и видео и указывают модель с множителем", () => {
    const presets = engine.SYSTEM_PRESETS;
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.some((p: any) => p.kind === "photo")).toBe(true);
    expect(presets.some((p: any) => p.kind === "video")).toBe(true);
    for (const p of presets) {
      expect(String(p.id)).not.toBe("");
      expect(String(p.model)).not.toBe("");
      expect([2, 3, 4]).toContain(p.scale);
    }
  });

  it("runtimeAvailable() отвечает булевым значением даже без установленной библиотеки", () => {
    expect(typeof engine.runtimeAvailable()).toBe("boolean");
  });
});

describe("upscale: роуты и хранилище", () => {
  it("роутер собран (Express Router) и не падает при require", () => {
    const router = req("../server/routes/upscale");
    expect(typeof router).toBe("function");
  });

  it("в config появились папки апскейла и моделей", () => {
    const cfg = req("../server/config");
    for (const key of ["upscaleIn", "upscaleOut", "upscaleModels"]) {
      expect(fs.existsSync(cfg.DIRS[key]), key).toBe(true);
      expect(cfg.DIRS[key].startsWith(process.env.MOONAPP_STORAGE as string)).toBe(true);
    }
  });

  it("манифест и собранный артефакт лежат в server/ (манифест ищется по __dirname)", () => {
    expect(fs.existsSync(path.join(root, "server", "models.manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "server", "upscale.js"))).toBe(true);
  });
});

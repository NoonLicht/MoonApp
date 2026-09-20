import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * /api/upscale — реальные запросы к НАСТОЯЩЕМУ серверу приложения.
 *
 * Зачем именно так: страница апскейла уже один раз оказалась «отдельным
 * островом» — роутер существовал и отвечал в изолированном стенде, но не был
 * подключён в server/index.js, поэтому в приложении пользователь видел 404
 * (а UI трактовал это как «нет ONNX-рантайма» и не показывал каталог моделей).
 * Тест поднимает сервер тем же путём, что Electron (startServer) и дергает API
 * по HTTP — так разрыв между «роут написан» и «роут доступен» виден сразу.
 *
 * Фоновые задачи (LHM, автоиндексация winget) гасим до require — как в
 * tests/index.test.ts, иначе тест запускал бы реальные процессы.
 */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-upscale-api-"));
process.env.MOONAPP_STORAGE = STORAGE;
delete process.env.MOONAPP_TOKEN;

const require = createRequire(import.meta.url);
require("../server/settings").set({
  store: { wingetAutoIndex: false },
  monitor: { lhmAutoStart: false },
});
const server = require("../server");

/** Порт 0 → случайный свободный; ждём фактического listen и узнаём номер. */
async function portOf(srv: { listening: boolean; address: () => unknown }): Promise<number> {
  if (!srv.listening) {
    await new Promise((r) => (srv as never as { once: unknown }).once("listening", r));
  }
  return (srv.address() as { port: number }).port;
}

/** Закрыть сервер вместе с keep-alive-соединениями fetch (иначе тест висит). */
function stop(srv: { close: () => void; closeAllConnections?: () => void }): void {
  srv.closeAllConnections?.();
  srv.close();
}

describe("апскейл: API подключён к серверу приложения", () => {
  let base = "";
  let srv: { close: () => void; closeAllConnections?: () => void } | null = null;

  beforeAll(async () => {
    srv = server.startServer(0);
    base = `http://127.0.0.1:${await portOf(srv as never)}`;
  });

  // Сервер живёт только внутри этого файла: иначе он держал бы цикл событий
  // во время остальных тестов (проверки с таймаутами начинают падать).
  afterAll(() => {
    if (srv) stop(srv);
    srv = null;
  });

  it("GET /api/upscale/hardware — рантайм и железо (не 404)", async () => {
    const r = await fetch(`${base}/api/upscale/hardware`);
    expect(r.status).toBe(200);
    const hw = (await r.json()) as {
      runtime: boolean;
      runtimeInfo?: { available: boolean; version: string; path: string; error: string };
      cpu: { coresLogical: number };
      gpu: { decode: string; x264: string; x265: string; av1: string; hardware: boolean };
      models: { id: string }[];
    };
    // Рантайм — зависимость package.json, в этом репозитории он установлен;
    // если его действительно нет, тест объяснит почему (runtimeInfo.error).
    expect(hw.runtime, hw.runtimeInfo?.error || "onnxruntime-node не загрузился").toBe(true);
    expect(hw.runtimeInfo?.available).toBe(true);
    expect(hw.runtimeInfo?.version).toMatch(/^\d+\./);
    expect(hw.runtimeInfo?.path).toContain("onnxruntime-node");
    expect(hw.cpu.coresLogical).toBeGreaterThan(0);
    expect(hw.models.length).toBeGreaterThan(0);
    // План аппаратного ускорения: панель настроек показывает, что сборка ffmpeg
    // реально умеет (NVENC/QSV/AMF или только CPU) — без этого она обещала бы
    // ускорение, которого нет.
    expect(hw.gpu).toBeTruthy();
    expect(typeof hw.gpu.hardware).toBe("boolean");
    for (const key of ["x264", "x265", "av1"] as const) {
      expect(typeof hw.gpu[key]).toBe("string");
    }
  });

  it("GET /api/upscale/models — каталог с моделями и кнопками (не пустой)", async () => {
    const r = await fetch(`${base}/api/upscale/models`);
    expect(r.status).toBe(200);
    const st = (await r.json()) as {
      runtime: boolean;
      dir: string;
      models: { id: string; label: string; url?: string; available: boolean }[];
      manifest?: { source: string; url: string; count: number };
    };
    expect(st.runtime).toBe(true);
    expect(st.dir).toBeTruthy();
    // Каталог не пустой — иначе в UI нечего скачивать и «кнопок» не будет.
    expect(st.models.length).toBeGreaterThan(10);
    const downloadable = st.models.filter((m) => !!m.url);
    expect(downloadable.length).toBeGreaterThan(0);
    expect(st.models.every((m) => typeof m.available === "boolean")).toBe(true);
    expect(st.models.every((m) => !!m.label)).toBe(true);
    // Откуда каталог: без скачанного манифеста — вшитый, адрес обновления — GitHub.
    expect(st.manifest?.source).toBe("bundled");
    expect(st.manifest?.url).toContain("github");
    expect(st.manifest?.count).toBe(st.models.length);
  });

  it("POST /api/upscale/models/sync — каталог обновляется из сети, мусор отсекается", async () => {
    const http = require("http") as typeof import("http");
    const catalog = {
      _note: "тестовый каталог",
      models: [
        {
          id: "api-probe",
          label: "API Probe",
          file: "api-probe.onnx",
          scale: 4,
          arch: "rrdb",
          sizeMb: 5,
          license: "MIT",
          url: "https://example.com/api-probe.onnx",
          tags: ["photo"],
        },
      ],
    };
    let body = JSON.stringify(catalog);
    let code = 200;
    const src = http.createServer((_q, s) => {
      s.writeHead(code, { "content-type": "application/json" });
      s.end(body);
    });
    await new Promise<void>((r) => src.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(src.address() as { port: number }).port}/models.manifest.json`;
    const catalogFile = path.join(STORAGE, "models", "models.manifest.json");
    try {
      const r = await fetch(`${base}/api/upscale/models/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      expect(r.status).toBe(200);
      const res = (await r.json()) as {
        count: number;
        added: string[];
        removed: string[];
        manifest: { source: string; count: number; updatedAt: string };
      };
      expect(res.count).toBe(1);
      expect(res.added).toContain("api-probe");
      expect(res.manifest.source).toBe("remote");
      expect(res.manifest.updatedAt).toBeTruthy();
      // Каталог подменился для всего приложения (файл в storage).
      expect(fs.existsSync(catalogFile)).toBe(true);
      const after = (await (await fetch(`${base}/api/upscale/models`)).json()) as {
        models: { id: string }[];
      };
      expect(after.models.map((m) => m.id)).toEqual(["api-probe"]);

      // Ошибка источника не должна ломать уже скачанный каталог.
      body = "{ это не JSON";
      code = 200;
      const bad = await fetch(`${base}/api/upscale/models/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      expect(bad.status).toBe(502);
      expect(((await bad.json()) as { error: string }).error).toBe("manifest_invalid");
      code = 404;
      const gone = await fetch(`${base}/api/upscale/models/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      expect(gone.status).toBe(502);
      expect(((await gone.json()) as { error: string }).error).toBe("http_404");
      const still = (await (await fetch(`${base}/api/upscale/models`)).json()) as {
        models: { id: string }[];
      };
      expect(still.models.map((m) => m.id)).toEqual(["api-probe"]);
    } finally {
      (src as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      src.close();
      // Возвращаем вшитый каталог: тесты ниже ждут обычный список моделей.
      fs.rmSync(catalogFile, { force: true });
    }
    const back = (await (await fetch(`${base}/api/upscale/models`)).json()) as {
      manifest: { source: string };
      models: { id: string }[];
    };
    expect(back.manifest.source).toBe("bundled");
    expect(back.models.length).toBeGreaterThan(10);
  });

  it("POST /api/upscale/inputs/clean — папка загрузок очищается", async () => {
    // storage/upscale/in копит исходники: после апскейла или выбора нового файла
    // они занимают гигабайты. Роут должен реально удалять файлы (кроме тех, что
    // держат незавершённые задания).
    const inDir = path.join(STORAGE, "upscale", "in");
    fs.mkdirSync(inDir, { recursive: true });
    const junk = path.join(inDir, "clean-me.bin");
    fs.writeFileSync(junk, "junk");
    const r = await fetch(`${base}/api/upscale/inputs/clean`, { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; removed: number };
    expect(body.ok).toBe(true);
    expect(body.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(junk)).toBe(false);
  });

  it("POST /api/upscale/:id/cancel — мягкая остановка (404 на неизвестное задание)", async () => {
    // Кнопка «Стоп» у прогресса: движок проверяет stage между кадрами и
    // завершается сам. Для несуществующего id — понятная 404, а не 500.
    const r = await fetch(`${base}/api/upscale/нет-такого-id/cancel`, { method: "POST" });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe("not_found");
  });

  it("каждый файл server/routes/*.js подключён в server/ts/index.ts", () => {
    // Страховка от целого класса ошибок: роут написан, но не смонтирован.
    const root = path.resolve(__dirname, "..");
    const routes = fs
      .readdirSync(path.join(root, "server", "routes"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.replace(/\.js$/, ""));
    const index = fs.readFileSync(path.join(root, "server", "ts", "index.ts"), "utf8");
    const missing = routes.filter((name) => !index.includes(`./routes/${name}`));
    expect(missing, `не подключены в server/ts/index.ts: ${missing.join(", ")}`).toEqual([]);
    // И каждый require должен попасть в app.use, а не просто лежать в переменной.
    const required = [...index.matchAll(/require\("\.\/routes\/([^"]+)"\)/g)].map((m) => m[1]);
    const unused = required.filter((name) => {
      const varname = index.match(
        new RegExp(`const (\\w+) = require\\("\\.\\/routes\\/${name}"\\)`),
      );
      return varname ? !new RegExp(`app\\.use\\([^)]*${varname[1]}\\b`).test(index) : true;
    });
    expect(unused, `require есть, app.use нет: ${unused.join(", ")}`).toEqual([]);
  });
});

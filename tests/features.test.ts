import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import type http from "http";

/**
 * Отключаемые страницы (server/ts/features.ts + featureServices.ts + ленивые роуты в index.ts).
 *
 * Проверяем главное обещание: отключённая страница не просто пропадает из дока — её роуты
 * отвечают 404, её модули и фоновые службы вообще не загружаются, а то, чем пользуются
 * другие включённые страницы (распознавание речи в чате), продолжает работать.
 */

const ROOT = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-features-"));

beforeAll(() => {
  process.env.MOONAPP_STORAGE = tmp;
});

function features(): Promise<typeof import("../server/features")> {
  return import("../server/features");
}

describe("карта функций страниц", () => {
  it("сгенерированные файлы актуальны (node scripts/ts/genFeatureMap.mts --check)", () => {
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj < 22 || (maj === 22 && min < 18)) return; // без встроенной поддержки TS-скриптов
    execFileSync(process.execPath, ["scripts/ts/genFeatureMap.mts", "--check"], {
      cwd: ROOT,
      stdio: "pipe",
    });
  });

  it("у каждой страницы из PAGE_LOADERS есть запись, «Настройки» заблокированы", async () => {
    const f = await features();
    expect(f.PAGE_IDS).toContain("convert");
    expect(f.PAGE_IDS).toContain("aichat");
    expect(f.LOCKED_PAGES).toContain("settings");
  });
});

describe("правила: что остаётся, когда страница выключена", () => {
  it("роуты только этой страницы отключаются вместе с ней", async () => {
    const f = await features();
    f.setDisabledPages([]);
    expect(f.prefixActive("compressor")).toBe(true);
    f.setDisabledPages(["compress"]);
    expect(f.prefixActive("compressor")).toBe(false);
    expect(f.isPageEnabled("compress")).toBe(false);
  });

  it("общее остаётся: распознавание речи работает, пока включён чат ИЛИ лекторий", async () => {
    const f = await features();
    f.setDisabledPages(["lecture"]);
    expect(f.prefixActive("quicknotes")).toBe(true); // нужен голосовому вводу чата
    f.setDisabledPages(["aichat", "lecture"]);
    expect(f.prefixActive("quicknotes")).toBe(false);
    f.setDisabledPages(["aichat"]);
    expect(f.prefixActive("quicknotes")).toBe(true); // нужен лекторию
  });

  it("OCR нужен скриншотам и бюджету: отключение одной страницы его не трогает", async () => {
    const f = await features();
    f.setDisabledPages(["screenshots"]);
    expect(f.prefixActive("ocr")).toBe(true);
    f.setDisabledPages(["screenshots", "budget"]);
    expect(f.prefixActive("ocr")).toBe(false);
  });

  it("то, чем пользуется оболочка (локальные модели, поиск, задачи), не отключается", async () => {
    const f = await features();
    f.setDisabledPages(f.PAGE_IDS.filter((id) => id !== "settings"));
    for (const p of ["llamacpp", "semantic", "tasks", "companion"])
      expect(f.prefixActive(p), p).toBe(true);
    f.setDisabledPages([]);
  });

  it("«Настройки» отключить нельзя, неизвестные id игнорируются", async () => {
    const f = await features();
    f.setDisabledPages(["settings", "нет-такой", "books"]);
    expect([...f.disabledPages()]).toEqual(["books"]);
    f.setDisabledPages([]);
  });

  it("профили: оставляют свои страницы и отключают остальные", async () => {
    const f = await features();
    f.applyProfile("minimal");
    expect(f.isPageEnabled("video")).toBe(true);
    expect(f.isPageEnabled("mail")).toBe(false);
    expect(f.isPageEnabled("settings")).toBe(true);
    f.applyProfile("all");
    expect([...f.disabledPages()]).toEqual([]);
  });
});

describe("сервер: роуты и службы", () => {
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    const { createApp } = await import("../server/index");
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 60_000);

  afterAll(async () => {
    const f = await features();
    f.setDisabledPages([]);
    await new Promise<void>((r) => server?.close(() => r()));
  });

  const get = async (p: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const r = await fetch(base + p);
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };

  it("отключённая страница: 404 feature_disabled, включённая — отвечает как обычно", async () => {
    const f = await features();
    f.setDisabledPages([]);
    expect((await get("/api/compressor/nothing")).body.error).not.toBe("feature_disabled");
    f.setDisabledPages(["compress"]);
    const r = await get("/api/compressor/nothing");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("feature_disabled");
    expect(r.body.pages).toEqual(["compress"]);
  });

  it("движок распознавания в роуте лекций остаётся, пока работает голосовой ввод чата", async () => {
    const f = await features();
    f.setDisabledPages(["lecture"]);
    expect((await get("/api/lecture/engine")).body.error).not.toBe("feature_disabled");
    expect((await get("/api/lecture/sessions")).body.error).toBe("feature_disabled");
    f.setDisabledPages(["lecture", "aichat"]);
    expect((await get("/api/lecture/engine")).body.error).toBe("feature_disabled");
  });

  it("GET/PUT /api/features: профиль и список страниц", async () => {
    const put = await fetch(`${base}/api/features`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "minimal" }),
    });
    const j = (await put.json()) as { disabled: string[]; profile: string };
    expect(j.profile).toBe("minimal");
    expect(j.disabled).toContain("mail");
    expect(j.disabled).not.toContain("settings");
    const bad = await fetch(`${base}/api/features`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "nope" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("загрузка модулей при старте (отдельный процесс)", () => {
  /** Какие из модулей оказались загруженными после createApp при заданных отключённых страницах. */
  function loaded(disabled: string, probes: string[]): Record<string, boolean> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-boot-"));
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ pages: { disabled, profile: "custom" } }),
    );
    const script = `
      const idx = require(${JSON.stringify(path.join(ROOT, "server", "index.js"))});
      const app = idx.createApp();
      setTimeout(() => {
        const keys = Object.keys(require.cache).map((k) => k.replace(/\\\\/g, "/"));
        const out = {};
        for (const p of ${JSON.stringify(probes)}) out[p] = keys.some((k) => k.includes(p));
        console.log("RESULT " + JSON.stringify(out));
        process.exit(0);
      }, 1500);
    `;
    const out = execFileSync(process.execPath, ["-e", script], {
      cwd: ROOT,
      env: { ...process.env, MOONAPP_STORAGE: dir, MOONAPP_INSECURE_DEV: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    return JSON.parse(out.split("RESULT ")[1]) as Record<string, boolean>;
  }

  const PROBES = ["mail/mailService", "/server/rss.js", "/server/monitor.js", "/server/winget.js", "tgwsproxy", "/server/lecture.js"];

  it("все страницы включены — службы страниц загружены", () => {
    const r = loaded("", PROBES);
    for (const p of PROBES) expect(r[p], p).toBe(true);
  }, 90_000);

  it("минимальный профиль — модули отключённых страниц не читаются вообще", () => {
    const r = loaded(
      "mail,rss,monitor,lecture,aichat,bypass,automation,convert,compress,photo,movies,books",
      PROBES,
    );
    // «/server/lecture.js» здесь не проверяем: его тянет общий код (сводки ИИ через llmOnce)
    for (const p of ["mail/mailService", "/server/rss.js", "/server/monitor.js", "tgwsproxy"])
      expect(r[p], p).toBe(false);
    // магазин включён — его индекс (winget) нужен
    expect(r["/server/winget.js"]).toBe(true);
  }, 90_000);
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import type http from "http";

/**
 * Страница «Фото и видео»: чистые части (подготовка тензора, маска, аргументы сайдкаров)
 * и подключение роута. Тяжёлые модели и установка Python здесь не запускаются.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-photo-"));
beforeAll(() => {
  process.env.MOONAPP_STORAGE = tmp;
});

describe("удаление фона: подготовка данных", () => {
  it("тензор — CHW с ImageNet-нормализацией", async () => {
    const bg = await import("../server/photo/bgRemove");
    const px = 1024 * 1024;
    const rgb = Buffer.alloc(px * 3, 255); // белая картинка
    const t = bg.toTensorData(rgb);
    expect(t.length).toBe(3 * px);
    expect(t[0]).toBeCloseTo((1 - 0.485) / 0.229, 4);
    expect(t[px]).toBeCloseTo((1 - 0.456) / 0.224, 4);
    expect(t[2 * px]).toBeCloseTo((1 - 0.406) / 0.225, 4);
  });

  it("маска: логиты проходят через сигмоиду, значения 0..1 берутся как есть", async () => {
    const bg = await import("../server/photo/bgRemove");
    const logits = bg.toMask([-10, 0, 10]);
    expect([...logits]).toEqual([0, 128, 255]);
    const probs = bg.toMask([0, 0.5, 1]);
    expect([...probs]).toEqual([0, 128, 255]);
  });
});

describe("сайдкары InvSR и Deep-Live-Cam", () => {
  it("InvSR: шаги и тайл ограничены допустимыми значениями", async () => {
    const invsr = await import("../server/photo/invsr");
    const a = invsr.buildArgs({ input: "a.png", steps: 99, tile: 999 }, "out");
    expect(a[a.indexOf("--num_steps") + 1]).toBe("5");
    expect(a[a.indexOf("--chopping_size") + 1]).toBe("256");
    expect(a).toContain("--tiled_vae");
    const b = invsr.buildArgs({ input: "a.png", steps: 0, tile: 128, colorFix: "wavelet" }, "out");
    expect(b[b.indexOf("--num_steps") + 1]).toBe("1");
    expect(b[b.indexOf("--color_fix") + 1]).toBe("wavelet");
  });

  it("Deep-Live-Cam: провайдер, видео-качество и флаги", async () => {
    const swap = await import("../server/photo/faceSwap");
    const img = swap.buildArgs(
      { source: "s.jpg", target: "t.png", device: "cpu", enhance: true },
      "o.png",
    );
    expect(img[img.indexOf("--execution-provider") + 1]).toBe("cpu");
    expect(img).toContain("face_enhancer");
    expect(img).not.toContain("--video-quality");
    const vid = swap.buildArgs(
      { source: "s.jpg", target: "t.mp4", quality: 99, manyFaces: true },
      "o.mp4",
    );
    expect(vid[vid.indexOf("--video-quality") + 1]).toBe("51");
    expect(vid).toContain("--many-faces");
    expect(swap.isVideo("clip.MKV")).toBe(true);
    expect(swap.isVideo("a.png")).toBe(false);
  });

  it("прогресс читается из строк tqdm", async () => {
    const jobs = await import("../server/photo/jobs");
    expect(jobs.parsePercent(" 45%|████▌     | 9/20 [00:03<00:04]")).toBe(45);
    expect(jobs.parsePercent("Frame processing done")).toBeNull();
  });
});

describe("роут /api/photo", () => {
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    const { createApp } = await import("../server/index");
    server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 60_000);

  afterAll(async () => {
    const f = await import("../server/features");
    f.setDisabledPages([]);
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("каталог моделей отдаёт BiRefNet и состояние загрузки", async () => {
    const j = (await (await fetch(`${base}/api/photo/models`)).json()) as {
      models: { id: string; installed: boolean }[];
      task: { state: string };
    };
    expect(j.models.map((m) => m.id)).toContain("birefnet-lite");
    expect(j.models.every((m) => m.installed === false)).toBe(true);
    expect(j.task.state).toBe("idle");
  });

  it("без установленного инструмента задания отклоняются понятным кодом", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array([1, 2, 3])]), "a.png");
    const r = await fetch(`${base}/api/photo/invsr`, { method: "POST", body: fd });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("tool_not_installed");
  });

  it("при отключённой странице «Фото и видео» роут отвечает feature_disabled", async () => {
    const f = await import("../server/features");
    f.setDisabledPages(["photo"]);
    const r = await fetch(`${base}/api/photo/models`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe("feature_disabled");
    f.setDisabledPages([]);
  });
});

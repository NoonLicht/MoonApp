// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"fetch":{"disableSameOriginPolicy":true}}}
/**
 * Сквозная проверка распознавания PDF на реальной модели (нужны Chandra OCR 2 и сборка llama.cpp с GPU).
 * По умолчанию пропускается: запуск `OCR_E2E=1 npx vitest run tests/ocrPdfE2E.test.ts`.
 * Клиентский код (recognizePdf) работает как в приложении, только canvas подменён на @napi-rs/canvas.
 */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";

const run = !!process.env.OCR_E2E;
const req = createRequire(import.meta.url);
const root = process.cwd();

describe.skipIf(!run)("OCR PDF: клиент → сервер → llama.cpp (GPU)", () => {
  let child: ChildProcess;
  let base = "";
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    // Сервер — в настоящем Node (в окружении happy-dom pdf-parse принимает его за браузер).
    const code = `
      const express = require("express");
      const app = express();
      app.use("/api/llamacpp", require(${JSON.stringify(path.join(root, "server/routes/llamacpp"))}));
      const s = app.listen(0, "127.0.0.1", () => console.log("PORT=" + s.address().port));
    `;
    child = spawn(process.execPath, ["-e", code], {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    base = await new Promise<string>((resolve, reject) => {
      child.stdout!.on("data", (d: Buffer) => {
        const m = /PORT=(\d+)/.exec(String(d));
        if (m) resolve(`http://127.0.0.1:${m[1]}`);
      });
      child.once("exit", () => reject(new Error("сервер не запустился")));
    });
    // Относительные адреса приложения (/api/...) → наш тестовый сервер.
    globalThis.fetch = ((u: unknown, init?: RequestInit) =>
      realFetch(
        typeof u === "string" && u.startsWith("/") ? base + u : (u as string),
        init,
      )) as typeof fetch;

    // canvas и createImageBitmap, которых нет в Node.
    const { createCanvas, loadImage } = req("@napi-rs/canvas");
    const origCreate = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      if (tag !== "canvas") return origCreate(tag);
      const c = createCanvas(1, 1);
      (c as unknown as { toBlob: unknown }).toBlob = (
        cb: (b: Blob) => void,
        type: string,
        q?: number,
      ) => {
        const fmt = type === "image/jpeg" ? "jpeg" : "png";
        const buf =
          fmt === "jpeg" ? c.encodeSync("jpeg", Math.round((q ?? 0.9) * 100)) : c.encodeSync("png");
        cb(new Blob([buf], { type }));
      };
      return c;
    }) as typeof document.createElement;
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async (
      b: Blob,
    ) => {
      const img = await loadImage(Buffer.from(await b.arrayBuffer()));
      (img as unknown as { close: () => void }).close = () => undefined;
      return img;
    };
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    child.kill();
  });

  it("два листа PDF → Markdown с таблицей, формулой и вырезанным рисунком", async () => {
    const { recognizePdf } = await import("../src/lib/noteOcr");
    const pdf = fs.readFileSync("C:/Users/MoonToon/tg-probe/chandra/test.pdf");
    const uploaded: Blob[] = [];
    const pages: string[] = [];
    const progress: number[] = [];
    const r = await recognizePdf(
      new Blob([pdf], { type: "application/pdf" }),
      async (blob) => {
        uploaded.push(blob);
        return `/api/myspace/assets/fig${uploaded.length}`;
      },
      { model: "", device: "cuda" },
      {
        onProgress: (d) => progress.push(d),
        onPage: (_n, _t, md) => pages.push(md),
      },
    );
    console.log(pages.join("\n\n=====\n\n"));
    expect(r.pages).toBe(2);
    expect(progress).toEqual([0, 1, 2]);
    expect(pages).toHaveLength(2);
    for (const md of pages) {
      expect(md).toMatch(/^#+ Лекция 3/);
      expect(md).toContain("| Величина |");
      expect(md).toContain("$F = m \\cdot a$");
      expect(md).toMatch(/!\[[^\]]*\]\(\/api\/myspace\/assets\/fig\d+\)/);
    }
    expect(uploaded.length).toBe(2);
    expect(uploaded[0].type).toBe("image/png");
    expect(uploaded[0].size).toBeGreaterThan(2000);
  }, 300_000);
});

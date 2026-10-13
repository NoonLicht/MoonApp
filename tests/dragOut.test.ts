import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/** Перетаскивание наружу: пути заметок, временные файлы, защита от выхода за пределы хранилища. */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-drag-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
let server: Server;
let base = "";

beforeAll(async () => {
  const express = req("express");
  const router = req("../server/routes/dragOut");
  const app = express();
  app.use("/api/dragout", router);
  await new Promise<void>((r) => {
    server = app.listen(0, "127.0.0.1", () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dragout`;
  const notes = path.join(STORAGE, "vault", "notes");
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, "Идея.md"), "# Идея");
  fs.writeFileSync(path.join(STORAGE, "secret.txt"), "x");
});

afterAll(() => server?.close());

describe("dragout", () => {
  it("путь заметки отдаётся, выход за пределы хранилища — нет", async () => {
    const ok = await fetch(`${base}/note?path=${encodeURIComponent("Идея.md")}`);
    expect(ok.status).toBe(200);
    const j = (await ok.json()) as { path: string };
    expect(fs.readFileSync(j.path, "utf8")).toBe("# Идея");
    const bad = await fetch(`${base}/note?path=${encodeURIComponent("../../secret.txt")}`);
    expect(bad.status).toBe(404);
  });

  it("stash кладёт файл во временную папку с безопасным именем", async () => {
    const r = await fetch(`${base}/stash?name=${encodeURIComponent("../../evil:name?.png")}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(r.status).toBe(200);
    const { path: p } = (await r.json()) as { path: string };
    expect(p.startsWith(path.join(os.tmpdir(), "moonapp-dragout"))).toBe(true);
    expect(path.basename(p)).not.toMatch(/[:?]/);
    expect(fs.readFileSync(p).length).toBe(3);
  });

  it("пустое тело отклоняется", async () => {
    const r = await fetch(`${base}/stash?name=a.png`, { method: "POST", body: new Uint8Array([]) });
    expect(r.status).toBe(400);
  });
});

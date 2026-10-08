import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { createRequire } from "module";
import type { AddressInfo } from "net";

const req = createRequire(import.meta.url);

let storage: string;
let server: http.Server;
let base = "";

const doc = (title: string, frames = 1) =>
  JSON.stringify({
    groups: [{ id: "g", x: 0, y: 0, axis: "y", items: [{ id: "i", kind: "button" }] }],
    frames: Array.from({ length: frames }, (_, i) => ({
      id: `f${i}`,
      name: `S${i}`,
      x: i * 500,
      y: 0,
    })),
    paletteKey: "purple",
    frame: "phone",
    title,
    brief: "",
  });

async function call(method: string, url: string, body?: string, json = false) {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": json ? "application/json" : "text/plain" },
    body,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* текст */
  }
  return { status: res.status, data: data as any };
}

beforeAll(async () => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-m3e-"));
  process.env.MOONAPP_STORAGE = storage;
  const express = req("express");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/m3e", req("../server/routes/m3e").default);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/m3e`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(storage, { recursive: true, force: true });
});

describe("API страниц M3E", () => {
  let a = "";
  let b = "";

  it("создаёт страницы: пустую и с документом, считает экраны и элементы", async () => {
    const r1 = await call("POST", "/pages", doc("Первая", 2));
    expect(r1.status).toBe(201);
    a = r1.data.id;
    expect(r1.data).toMatchObject({ title: "Первая", screens: 2, parts: 1 });
    const r2 = await call("POST", "/pages", "");
    b = r2.data.id;
    expect(r2.data.title).toBe("");
    const list = await call("GET", "");
    expect(list.data.pages.map((p: { id: string }) => p.id)).toEqual([a, b]);
    expect(list.data.activeId).toBe(b);
  });

  it("сохраняет и читает документ, обновляя название в списке", async () => {
    const put = await call("PUT", `/pages/${a}`, doc("Переименована", 3));
    expect(put.status).toBe(200);
    expect(put.data).toMatchObject({ title: "Переименована", screens: 3 });
    const got = await call("GET", `/pages/${a}`);
    expect(got.data.title).toBe("Переименована");
    expect(got.data.frames).toHaveLength(3);
  });

  it("отклоняет не-JSON и чужие id", async () => {
    expect((await call("PUT", `/pages/${a}`, "{oops")).status).toBe(400);
    expect((await call("PUT", "/pages/zzzzzzzzzz", doc("x"))).status).toBe(404);
    expect((await call("GET", "/pages/..%2F..%2Fx")).status).toBe(404);
  });

  it("меняет порядок, закрепление, цвет и активную страницу", async () => {
    const r = await call(
      "PATCH",
      "",
      JSON.stringify({
        order: [b, a],
        activeId: a,
        pages: { [a]: { pinned: true, color: "#6750a4" }, [b]: { color: "red" } },
      }),
      true,
    );
    expect(r.data.pages.map((p: { id: string }) => p.id)).toEqual([b, a]);
    expect(r.data.activeId).toBe(a);
    const pa = r.data.pages.find((p: { id: string }) => p.id === a);
    expect(pa).toMatchObject({ pinned: true, color: "#6750a4" });
    expect(r.data.pages.find((p: { id: string }) => p.id === b).color).toBeUndefined();
  });

  it("дублирует страницу справа от оригинала с новым названием", async () => {
    const r = await call("POST", `/pages/${a}/duplicate`, JSON.stringify({ title: "Копия" }), true);
    expect(r.status).toBe(201);
    const list = await call("GET", "");
    const ids = list.data.pages.map((p: { id: string }) => p.id);
    expect(ids.indexOf(r.data.id)).toBe(ids.indexOf(a) + 1);
    expect(list.data.pages.find((p: { id: string }) => p.id === r.data.id)).toMatchObject({
      title: "Копия",
      screens: 3,
    });
  });

  it("удаляет в корзину, возвращает и удаляет насовсем", async () => {
    const del = await call("DELETE", `/pages/${a}`);
    expect(del.data.pages.some((p: { id: string }) => p.id === a)).toBe(false);
    expect(del.data.trash.map((p: { id: string }) => p.id)).toEqual([a]);
    expect((await call("GET", `/pages/${a}`)).status).toBe(404);
    const back = await call("POST", `/trash/${a}/restore`, "{}", true);
    expect(back.data.pages.some((p: { id: string }) => p.id === a)).toBe(true);
    expect(back.data.activeId).toBe(a);
    await call("DELETE", `/pages/${a}`);
    const gone = await call("DELETE", `/trash/${a}`);
    expect(gone.data.trash).toEqual([]);
    expect((await call("DELETE", `/trash/${a}`)).status).toBe(404);
  });

  it("принимает документ крупнее лимита общего JSON-парсера", async () => {
    const big = JSON.stringify({
      ...JSON.parse(doc("Большая")),
      junk: "x".repeat(3 * 1024 * 1024),
    });
    const r = await call("PUT", `/pages/${b}`, big);
    expect(r.status).toBe(200);
    expect(r.data.title).toBe("Большая");
  });
});

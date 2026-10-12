import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/** P2P: сервер и клиент синхронизации на временных каталогах (server/ts/p2pServer.ts). */
const req = createRequire(import.meta.url);
let srv: any;
let p2p: any;
beforeAll(() => {
  srv = req("../server/p2pServer");
  p2p = req("../server/p2pSync");
});

let tmp = "";
let a = "";
let b = "";
const put = (root: string, rel: string, text: string, mtimeMs?: number) => {
  const f = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  if (mtimeMs) fs.utimesSync(f, new Date(), new Date(mtimeMs));
};
const get = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-"));
  a = path.join(tmp, "a");
  b = path.join(tmp, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("синхронизация двух хранилищ", () => {
  it("обмен недостающими, конфликты с копиями, скрытое не передаётся", async () => {
    const key = p2p.newPairingKey();
    put(a, "общая.md", "одинаково");
    put(b, "общая.md", "одинаково");
    put(a, "только-a.md", "A");
    put(b, "Папка/только-b.md", "B");
    put(a, "спор.md", "старая версия A", 1_000_000_000_000);
    put(b, "спор.md", "новая версия B", 2_000_000_000_000);
    put(a, ".history/секрет.md", "скрыто");
    put(a, "картинка.png", "не md");

    const server = await srv.startServer({ root: b, secret: key, host: "127.0.0.1" });
    try {
      const r = await srv.syncWith({ root: a, host: "127.0.0.1", port: server.port, secret: key });
      expect(r.failed).toEqual([]);
      expect(r.pulled).toBe(1);
      expect(r.pushed).toBe(1);
      expect(r.conflicts).toBe(1);
      expect(r.same).toBe(1);

      expect(get(a, "Папка/только-b.md")).toBe("B");
      expect(get(b, "только-a.md")).toBe("A");
      // победила более свежая версия B; старая A сохранена копией
      expect(get(a, "спор.md")).toBe("новая версия B");
      const copies = fs.readdirSync(a).filter((n) => n.startsWith("спор (конфликт"));
      expect(copies.length).toBe(1);
      expect(get(a, copies[0])).toBe("старая версия A");
      // служебное и не-md не ушло на другую сторону
      expect(fs.existsSync(path.join(b, ".history"))).toBe(false);
      expect(fs.existsSync(path.join(b, "картинка.png"))).toBe(false);

      // копия конфликта — обычная заметка: при следующем обмене она доезжает до второго устройства
      const second = await srv.syncWith({ root: a, host: "127.0.0.1", port: server.port, secret: key });
      expect(second.pushed).toBe(1);
      expect(fs.existsSync(path.join(b, copies[0]))).toBe(true);
      // после этого наборы совпадают и обмен ничего не меняет
      const third = await srv.syncWith({ root: a, host: "127.0.0.1", port: server.port, secret: key });
      expect(third.pulled + third.pushed + third.conflicts).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("неверный ключ не даёт ни прочитать, ни записать", async () => {
    const server = await srv.startServer({ root: b, secret: p2p.newPairingKey(), host: "127.0.0.1" });
    try {
      put(a, "x.md", "X");
      await expect(
        srv.syncWith({ root: a, host: "127.0.0.1", port: server.port, secret: p2p.newPairingKey() }),
      ).rejects.toThrow("wrong_key");
      expect(fs.readdirSync(b)).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("writeNote", () => {
  it("отвергает опасные пути и слишком большие файлы", () => {
    expect(() => srv.writeNote(a, "../evil.md", Buffer.from("x"), 1)).toThrow("bad_path");
    expect(() => srv.writeNote(a, "ok.md", Buffer.alloc(6 * 1024 * 1024), 1)).toThrow("file_too_large");
    expect(srv.readNote(a, "../../etc/passwd")).toBeNull();
  });

  it("идентичное содержимое не создаёт копию конфликта", () => {
    put(a, "n.md", "одно и то же");
    expect(srv.writeNote(a, "n.md", Buffer.from("одно и то же"), 1).conflictCopy).toBeNull();
    expect(fs.readdirSync(a)).toEqual(["n.md"]);
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** P2P-синхронизация: подписи, шифрование, пути, план (server/ts/p2pSync.ts). */
const req = createRequire(import.meta.url);
let p2p: any;
beforeAll(() => {
  p2p = req("../server/p2pSync");
});

describe("подписи", () => {
  it("верная подпись проходит, изменение любого поля — нет", () => {
    const k = p2p.newPairingKey();
    const now = 1_000_000;
    const sig = p2p.sign(k, "get", "/p2p/manifest", now, "");
    expect(p2p.verify(k, "GET", "/p2p/manifest", now, "", sig, now)).toBe(true);
    expect(p2p.verify(k, "GET", "/p2p/file?path=a.md", now, "", sig, now)).toBe(false);
    expect(p2p.verify(k, "PUT", "/p2p/manifest", now, "", sig, now)).toBe(false);
    expect(p2p.verify(k, "GET", "/p2p/manifest", now, "тело", sig, now)).toBe(false);
    expect(p2p.verify(p2p.newPairingKey(), "GET", "/p2p/manifest", now, "", sig, now)).toBe(false);
  });

  it("устаревшая метка времени и мусорная подпись отвергаются", () => {
    const k = p2p.newPairingKey();
    const sig = p2p.sign(k, "GET", "/x", 1000, "");
    expect(p2p.verify(k, "GET", "/x", 1000, "", sig, 1000 + p2p.SIG_WINDOW_MS + 1)).toBe(false);
    expect(p2p.verify(k, "GET", "/x", 1000, "", "zz", 1000)).toBe(false);
    expect(p2p.verify(k, "GET", "/x", NaN, "", sig, 1000)).toBe(false);
  });
});

describe("шифрование", () => {
  it("круг seal/open и невозможность прочитать чужим ключом", () => {
    const k = p2p.newPairingKey();
    const plain = Buffer.from("Секретная заметка 😀", "utf8");
    const sealed = p2p.seal(k, plain);
    expect(sealed.includes(plain)).toBe(false);
    expect(p2p.open(k, sealed).toString("utf8")).toBe("Секретная заметка 😀");
    expect(() => p2p.open(p2p.newPairingKey(), sealed)).toThrow("bad_payload");
    sealed[sealed.length - 1] ^= 1;
    expect(() => p2p.open(k, sealed)).toThrow("bad_payload");
    expect(() => p2p.open(k, Buffer.from("коротко"))).toThrow("bad_payload");
  });
});

describe("safeRelPath", () => {
  it("принимает обычные пути заметок", () => {
    expect(p2p.safeRelPath("Папка\\Заметка.md")).toBe("Папка/Заметка.md");
    expect(p2p.safeRelPath("a.md")).toBe("a.md");
  });
  it("отвергает обход каталогов, абсолютные, скрытые, не-md", () => {
    for (const p of ["../x.md", "a/../../x.md", "/etc/x.md", "C:/x.md", ".history/a.md", "a/.git/b.md", "a.txt", "", "a//b.md"])
      expect(p2p.safeRelPath(p), p).toBeNull();
  });
});

describe("conflictPath", () => {
  it("добавляет метку и нумерует повторы", () => {
    expect(p2p.conflictPath("A/Б.md", "2026-03-05")).toBe("A/Б (конфликт 2026-03-05).md");
    const taken = new Set(["A/Б (конфликт 2026-03-05).md"]);
    expect(p2p.conflictPath("A/Б.md", "2026-03-05", (p: string) => taken.has(p))).toBe("A/Б (конфликт 2026-03-05) 2.md");
  });
});

describe("planSync", () => {
  const f = (path: string, hash: string, mtime = 1) => ({ path, hash, mtime, size: 1 });
  it("делит на pull/push/конфликты/совпадающие", () => {
    const local = [f("a.md", "1"), f("b.md", "2", 10), f("only-local.md", "3"), f("c.md", "4", 5)];
    const remote = [f("a.md", "1"), f("b.md", "X", 20), f("only-remote.md", "5"), f("c.md", "Y", 1)];
    const p = p2p.planSync(local, remote);
    expect(p.same).toBe(1);
    expect(p.push).toEqual(["only-local.md"]);
    expect(p.pull).toEqual(["only-remote.md"]);
    expect(p.conflicts).toEqual([
      { path: "b.md", winner: "remote" },
      { path: "c.md", winner: "local" },
    ]);
  });
  it("при равных наборах ничего не делает", () => {
    const l = [f("a.md", "1")];
    expect(p2p.planSync(l, l)).toEqual({ pull: [], push: [], conflicts: [], same: 1 });
  });
});

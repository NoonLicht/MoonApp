import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Веб-компаньон (server/ts/companion.ts). Проверяем именно границы безопасности:
 * сеть, Host, токены, сопряжение, перебор кода, вход файлов — и что нужное работает.
 */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-comp-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
let c: any;
let srv: http.Server;
let base = "";

beforeAll(async () => {
  c = req("../server/companion");
  srv = c.createCompanionApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => srv.once("listening", () => r()));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(() => {
  srv.close();
  req("../server/db").close();
});

describe("проверки адреса и Host", () => {
  it("частные сети проходят, публичные и мусор — нет", () => {
    for (const ok of ["192.168.0.5", "10.1.2.3", "172.16.0.1", "172.31.255.255", "127.0.0.1", "169.254.1.1", "::1", "fd12:3456::1", "fe80::1", "::ffff:192.168.1.7"]) {
      expect(c.isPrivateAddress(ok), ok).toBe(true);
    }
    for (const bad of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "100.64.0.1", "2001:db8::1", "999.1.1.1", "", undefined, "evil.example"]) {
      expect(c.isPrivateAddress(bad), String(bad)).toBe(false);
    }
  });

  it("Host — только IP-литерал или localhost (защита от DNS rebinding)", () => {
    for (const ok of ["192.168.0.5:4717", "10.0.0.2", "localhost:4717", "[::1]:4717"]) {
      expect(c.isAllowedHost(ok), ok).toBe(true);
    }
    for (const bad of ["evil.example", "evil.example:4717", "192.168.0.5.evil.com", "", undefined]) {
      expect(c.isAllowedHost(bad), String(bad)).toBe(false);
    }
  });
});

describe("имена файлов", () => {
  it("убирает путь и опасные символы, помечает исполняемые типы", () => {
    expect(c.safeFileName("../../Windows/System32/evil.exe")).toEqual({ name: "evil.exe", blocked: true });
    expect(c.safeFileName("C:\\Users\\x\\отчёт.pdf")).toEqual({ name: "отчёт.pdf", blocked: false });
    expect(c.safeFileName("a<b>:c|d?.txt").name).toBe("a_b__c_d_.txt");
    expect(c.safeFileName("script.PS1").blocked).toBe(true);
    expect(c.safeFileName("...hidden").name).toBe("hidden");
    expect(c.safeFileName("").name).toBe("file");
  });
});

describe("сопряжение", () => {
  it("код одноразовый: верный обменивается на токен, повтор не проходит", () => {
    const { code } = c.newPairingCode();
    expect(code).toMatch(/^\d{6}$/);
    const r = c.pair(code, "Pixel", "10.0.0.5");
    expect(r.token).toHaveLength(64);
    expect(c.authenticate(r.token)).toMatchObject({ name: "Pixel" });
    expect(() => c.pair(code, "again", "10.0.0.5")).toThrow("bad_code");
    // В файле только хэш токена.
    expect(fs.readFileSync(path.join(STORAGE, "companion.json"), "utf8")).not.toContain(r.token);
  });

  it("просроченный код отвергается", () => {
    const { code } = c.newPairingCode(1000);
    expect(() => c.pair(code, "x", "10.0.0.6", 1000 + c.PAIRING_TTL_MS + 1)).toThrow("bad_code");
  });

  it("перебор: после 5 неверных попыток с адреса — 429, даже с верным кодом", () => {
    const { code } = c.newPairingCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect(() => c.pair(wrong, "x", "10.0.0.9")).toThrow("bad_code");
    expect(() => c.pair(code, "x", "10.0.0.9")).toThrow("too_many_attempts");
    // другой адрес не затронут
    expect(c.pair(code, "ok", "10.0.0.10").token).toBeTruthy();
  });

  it("код сгорает после 10 неудач с разных адресов", () => {
    const { code } = c.newPairingCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 10; i++) expect(() => c.pair(wrong, "x", `10.1.0.${i}`)).toThrow();
    expect(() => c.pair(code, "x", "10.1.0.200")).toThrow("bad_code");
  });

  it("неизвестный и слишком короткий токен не проходят", () => {
    expect(c.authenticate("x".repeat(64))).toBeNull();
    expect(c.authenticate("short")).toBeNull();
    expect(c.authenticate(undefined)).toBeNull();
  });
});

async function call(method: string, p: string, opts: { token?: string; body?: unknown; form?: FormData; host?: string } = {}) {
  if (opts.host) {
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
      const u = new URL(base + p);
      const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: { Host: opts.host! } }, (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => resolve({ status: res.statusCode!, json: s ? safeJson(s) : null }));
      });
      r.on("error", reject);
      r.end();
    });
  }
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, json: text ? safeJson(text) : null };
}
const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

describe("HTTP-сервер", () => {
  let token = "";
  beforeAll(async () => {
    const { code } = c.newPairingCode();
    const r = await call("POST", "/api/pair", { body: { code, name: "Test" } });
    token = r.json.token;
  });

  it("страница и скрипты раздаются без токена, с жёстким CSP и без inline-скриптов", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(r.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(await r.text()).not.toMatch(/<script>[^<]/);
  });

  it("DNS rebinding: чужой Host отвергается даже с верным адресом клиента", async () => {
    expect((await call("GET", "/", { host: "evil.example" })).status).toBe(403);
    expect((await call("GET", "/api/me", { host: "evil.example:4717", token })).status).toBe(403);
  });

  it("все API, кроме /pair, требуют токен", async () => {
    for (const [m, p] of [["GET", "/api/notes"], ["GET", "/api/tasks"], ["GET", "/api/player"], ["POST", "/api/inbox/text"], ["POST", "/api/player/cmd"]] as const) {
      expect((await call(m, p)).status, p).toBe(401);
      expect((await call(m, p, { token: "a".repeat(64) })).status, p).toBe(401);
    }
  });

  it("чужие маршруты основного API здесь не существуют", async () => {
    for (const p of ["/api/passwords", "/api/settings", "/api/automation/tasks", "/api/backup"]) {
      expect((await call("GET", p, { token })).status, p).toBe(404);
    }
  });

  it("заметки: создать, найти, прочитать, дописать", async () => {
    const created = await call("POST", "/api/notes", { token, body: { title: "С телефона", content: "первая строка" } });
    expect(created.status).toBe(201);
    const list = await call("GET", "/api/notes?q=" + encodeURIComponent("первая"), { token });
    expect(list.json.map((n: any) => n.title)).toContain("С телефона");
    const id = created.json.id;
    expect((await call("POST", `/api/notes/${id}/append`, { token, body: { text: "вторая" } })).status).toBe(200);
    const note = await call("GET", `/api/notes/${id}`, { token });
    expect(note.json.content).toBe("первая строка\n\nвторая");
    expect((await call("GET", "/api/notes/99999", { token })).status).toBe(404);
  });

  it("входящий текст становится заметкой в папке Inbox", async () => {
    expect((await call("POST", "/api/inbox/text", { token, body: { text: "https://example.com/read" } })).status).toBe(201);
    const list = await call("GET", "/api/notes?q=example.com", { token });
    expect(list.json.some((n: any) => n.folder === "Inbox")).toBe(true);
    expect((await call("POST", "/api/inbox/text", { token, body: { text: "  " } })).status).toBe(400);
  });

  it("задачи: добавить и отметить выполненной", async () => {
    const r = await call("POST", "/api/tasks", { token, body: { title: "Купить хлеб" } });
    expect(r.status).toBe(201);
    expect((await call("POST", `/api/tasks/${r.json.id}/toggle`, { token })).json.status).toBe("completed");
    expect((await call("POST", `/api/tasks/${r.json.id}/toggle`, { token })).json.status).toBe("todo");
    const list = await call("GET", "/api/tasks", { token });
    expect(list.json.find((t: any) => t.id === r.json.id)).toMatchObject({ title: "Купить хлеб" });
  });

  it("файл принимается во входящие с безопасным именем; исполняемые типы — 415", async () => {
    const ok = new FormData();
    ok.append("file", new Blob(["hello"]), "../../фото.jpg");
    const r1 = await call("POST", "/api/inbox/file", { token, form: ok });
    expect(r1.status).toBe(201);
    expect(r1.json.name).toMatch(/фото\.jpg$/);
    expect(r1.json.name).not.toContain("..");
    const saved = fs.readdirSync(c.inboxDir());
    expect(saved.some((f) => f.endsWith("фото.jpg"))).toBe(true);

    const bad = new FormData();
    bad.append("file", new Blob(["MZ"]), "setup.exe");
    expect((await call("POST", "/api/inbox/file", { token, form: bad })).status).toBe(415);
    expect(fs.readdirSync(c.inboxDir()).some((f) => f.endsWith("setup.exe"))).toBe(false);
  });

  it("плеер: состояние с ПК видно телефону, команды доходят до ПК по очереди", async () => {
    expect((await call("GET", "/api/player", { token })).json.state).toBeNull();
    c.setPlayerState({ title: "Song", paused: false, position: 12, duration: 200, volume: 0.5 });
    expect((await call("GET", "/api/player", { token })).json.state).toMatchObject({ title: "Song", paused: false });
    expect((await call("POST", "/api/player/cmd", { token, body: { cmd: "seek", value: 10 } })).status).toBe(200);
    expect((await call("POST", "/api/player/cmd", { token, body: { cmd: "rm -rf" } })).status).toBe(400);
    const cmds = c.takeCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ cmd: "seek", value: 10 });
    expect(c.takeCommands()).toEqual([]);
  });

  it("отозванное устройство теряет доступ сразу", async () => {
    const dev = c.status().devices.find((d: any) => d.name === "Test");
    expect(c.revokeDevice(dev.id)).toBe(true);
    expect((await call("GET", "/api/me", { token })).status).toBe(401);
  });
});

describe("запуск и остановка", () => {
  it("setEnabled поднимает сервер на указанном порту и выдаёт код; выключение закрывает порт", async () => {
    const st = await c.setEnabled(true, 47123);
    try {
      expect(st).toMatchObject({ enabled: true, running: true, port: 47123 });
      expect(st.pairing.code).toMatch(/^\d{6}$/);
      const r = await fetch("http://127.0.0.1:47123/");
      expect(r.status).toBe(200);
    } finally {
      const off = await c.setEnabled(false);
      expect(off.running).toBe(false);
    }
    await expect(fetch("http://127.0.0.1:47123/")).rejects.toThrow();
  });
});

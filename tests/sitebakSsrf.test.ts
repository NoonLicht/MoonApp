import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * SSRF-защита веб-архиватора: краулер ходит по ссылкам со страницы (не только
 * по URL, который ввёл пользователь), поэтому вредоносная страница могла бы
 * направить его на localhost/внутреннюю сеть пользователя (другие сервисы на
 * этой машине, роутер/NAS в LAN). См. isBlockedHost в server/ts/sitebak.ts.
 */
const req = createRequire(import.meta.url);

beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-sitebak-ssrf-"));
});

function engine(): any {
  return req("../server/sitebak");
}

function archiveRouter(): express.Router {
  return req("../server/routes/archive");
}

describe("sitebak — SSRF: isBlockedHost", () => {
  it("блокирует loopback, приватные диапазоны и облачные метаданные", () => {
    const e = engine();
    for (const host of [
      "127.0.0.1",
      "localhost",
      "0.0.0.0",
      "169.254.169.254", // облачные метаданные (AWS/GCP/Azure)
      "192.168.1.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "::1",
    ]) {
      expect(e.isBlockedHost(host)).toBe(true);
    }
  });

  it("не блокирует обычные публичные домены", () => {
    const e = engine();
    for (const host of ["example.com", "en.wikipedia.org", "8.8.8.8", "172.32.0.1", "193.0.0.1"]) {
      expect(e.isBlockedHost(host)).toBe(false);
    }
  });
});

describe("POST /api/archive/start — отклоняет внутренние адреса", () => {
  const call = async (app: express.Express, body: unknown) => {
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    } finally {
      srv.close();
    }
  };

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/", archiveRouter());
    return app;
  };

  it("127.0.0.1 → 400 blocked_host, краул не запускается", async () => {
    const r = await call(makeApp(), { url: "http://127.0.0.1:9999/" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("blocked_host");
  });

  it("192.168.x.x → 400 blocked_host", async () => {
    const r = await call(makeApp(), { url: "http://192.168.1.1/" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("blocked_host");
  });
});

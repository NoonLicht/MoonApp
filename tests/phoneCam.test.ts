import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

/**
 * Телефон как веб-камера: самоподписанный сертификат (server/ts/selfCert.ts),
 * буфер кадров (server/ts/phoneCam.ts) и маршруты камеры в компаньоне.
 */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-cam-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
let sc: any;
let cam: any;
let comp: any;

/** Минимальный «JPEG» с корректными SOI, SOF0 и EOI — хватает для чтения размеров. */
function tinyJpeg(w: number, h: number, pad = 0): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(pad), Buffer.from([0xff, 0xd9])]);
}

beforeAll(() => {
  sc = req("../server/selfCert");
  cam = req("../server/phoneCam");
  comp = req("../server/companion");
});
afterAll(() => {
  req("../server/db").close();
});

describe("самоподписанный сертификат", () => {
  it("валидный X.509 с адресами в SAN, подписан своим ключом", () => {
    const c = sc.makeSelfSigned(["192.168.1.68", "10.0.0.5", "не-адрес"]);
    const x = new crypto.X509Certificate(c.cert);
    expect(x.checkIP("192.168.1.68")).toBe("192.168.1.68");
    expect(x.checkIP("10.0.0.5")).toBe("10.0.0.5");
    expect(x.checkIP("10.0.0.6")).toBeUndefined();
    expect(x.subjectAltName).toContain("DNS:localhost");
    expect(x.verify(x.publicKey)).toBe(true);
    expect(c.ips).toEqual(["192.168.1.68", "10.0.0.5"]);
    expect(new Date(x.validTo).getTime()).toBeGreaterThan(Date.now() + 700 * 24 * 3600 * 1000);
  });

  it("пара ключ+сертификат работает в настоящем TLS-рукопожатии", async () => {
    const c = sc.makeSelfSigned(["127.0.0.1"]);
    const s = https.createServer({ key: c.key, cert: c.cert }, (_q, r) => r.end("secure"));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as { port: number }).port;
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get({ host: "127.0.0.1", port, rejectUnauthorized: false }, (res) => {
          let d = "";
          res.on("data", (b) => (d += b));
          res.on("end", () => resolve(d));
        })
        .on("error", reject);
    });
    s.close();
    expect(body).toBe("secure");
  });
});

describe("кадры камеры", () => {
  it("читает размер JPEG и отвергает не-JPEG и слишком большое", () => {
    expect(cam.jpegSize(tinyJpeg(640, 480))).toEqual({ w: 640, h: 480 });
    expect(cam.jpegSize(Buffer.from("not a jpeg at all"))).toBeNull();
    expect(() => cam.pushFrame(Buffer.from("GIF89a...."), "t")).toThrow("bad_frame");
    expect(() => cam.pushFrame(Buffer.alloc(cam.MAX_FRAME + 1), "t")).toThrow("too_big");
  });

  it("считает fps и гасит «активна» после паузы", () => {
    cam.reset();
    const t0 = 1_000_000;
    for (let i = 0; i < 11; i++) cam.pushFrame(tinyJpeg(320, 240, 100), "Pixel", t0 + i * 100);
    const i = cam.info(t0 + 1000);
    expect(i.active).toBe(true);
    expect(i.fps).toBe(10);
    expect(i.width).toBe(320);
    expect(i.device).toBe("Pixel");
    expect(cam.info(t0 + 1000 + cam.ACTIVE_MS + 1).active).toBe(false);
  });

  it("слушатели получают кадры, отписка работает", () => {
    const got: number[] = [];
    const off = cam.subscribe((b: Buffer) => got.push(b.length));
    cam.pushFrame(tinyJpeg(8, 8, 5), "t");
    off();
    cam.pushFrame(tinyJpeg(8, 8, 50), "t");
    expect(got).toHaveLength(1);
  });

  it("ключ потока стабилен, проверяется и перевыпускается", () => {
    const k = cam.streamKey();
    expect(k).toMatch(/^[a-f0-9]{32}$/);
    expect(cam.streamKey()).toBe(k);
    expect(cam.keyMatches(k)).toBe(true);
    expect(cam.keyMatches("a".repeat(32))).toBe(false);
    expect(cam.keyMatches(undefined)).toBe(false);
    const k2 = cam.regenerateKey();
    expect(k2).not.toBe(k);
    expect(cam.keyMatches(k)).toBe(false);
  });

  it("снимок сохраняется в файл", () => {
    cam.pushFrame(tinyJpeg(16, 16, 20), "t");
    const name = cam.saveSnapshot(new Date(2026, 9, 12, 1, 2, 3));
    expect(name).toBe("cam-20261012-010203.jpg");
    expect(fs.existsSync(path.join(cam.photosDir(), name))).toBe(true);
  });

  it("часть MJPEG содержит границу и длину", () => {
    const part = cam.mjpegPart(Buffer.from([1, 2, 3])).toString("latin1");
    expect(part).toContain(`--${cam.BOUNDARY}`);
    expect(part).toContain("Content-Length: 3");
  });
});

describe("маршруты камеры в компаньоне", () => {
  let srv: http.Server;
  let base = "";
  let token = "";

  const call = (method: string, p: string, opts: { body?: Buffer; ct?: string; auth?: boolean } = {}) =>
    new Promise<{ status: number; body: Buffer; type: string }>((resolve, reject) => {
      const u = new URL(base + p);
      const r = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method,
          headers: {
            ...(opts.auth === false ? {} : { Authorization: `Bearer ${token}` }),
            ...(opts.ct ? { "Content-Type": opts.ct, "Content-Length": opts.body?.length ?? 0 } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), type: String(res.headers["content-type"] || "") }));
        },
      );
      r.on("error", reject);
      if (opts.body) r.write(opts.body);
      r.end();
    });

  beforeAll(async () => {
    srv = comp.createCompanionApp().listen(0, "127.0.0.1");
    await new Promise<void>((r) => srv.once("listening", () => r()));
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    token = comp.pair(comp.newPairingCode().code, "Test", "10.0.0.5").token;
  });
  afterAll(() => srv.close());

  it("кадр принимается только с токеном и только JPEG", async () => {
    const f = tinyJpeg(100, 50, 30);
    expect((await call("POST", "/api/cam/frame", { body: f, ct: "image/jpeg", auth: false })).status).toBe(401);
    expect((await call("POST", "/api/cam/frame", { body: Buffer.from("zzzz"), ct: "image/jpeg" })).status).toBe(400);
    expect((await call("POST", "/api/cam/frame", { body: f, ct: "image/jpeg" })).status).toBe(204);
    const info = JSON.parse((await call("GET", "/api/cam/info")).body.toString());
    expect(info.active).toBe(true);
    expect(info.width).toBe(100);
    expect(info.device).toBe("Test");
  });

  it("кадр по ключу отдаётся без токена, с чужим ключом — 403", async () => {
    const k = cam.streamKey();
    const ok = await call("GET", `/cam/frame.jpg?key=${k}`, { auth: false });
    expect(ok.status).toBe(200);
    expect(ok.type).toContain("image/jpeg");
    expect((await call("GET", `/cam/frame.jpg?key=${"0".repeat(32)}`, { auth: false })).status).toBe(403);
    expect((await call("GET", "/cam/stream", { auth: false })).status).toBe(403);
  });
});

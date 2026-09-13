import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import net from "net";
import { spawn, spawnSync } from "child_process";

/**
 * Живой пинг рабочего узла.
 *
 * Поднимаем настоящий VLESS-сервер (sing-box) + локальную HTTP-цель и проверяем,
 * что pingNode доводит дело до успеха: стартует временное ядро, открывает SOCKS,
 * реально делает запрос и возвращает измеренный TTFB.
 *
 * Оговорка про охват: локальная цель попадает под правило `ip_is_private` → в
 * клиентском конфиге она уходит в direct, поэтому здесь проверяется пайплайн
 * (ядро → SOCKS → замер), а сам VLESS-хоп проверялся живьём на внешней цели.
 *
 * Порты берём динамические: фиксированные конфликтуют с «повисшими» воркерами
 * предыдущего прогона и делают тесты флаки.
 */
const require = createRequire(import.meta.url);
process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-pinglive-"));

const core = require("../server/proxyCore");
const UUID = "11111111-2222-3333-4444-555555555555";

const portOpen = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port });
  const done = (v: boolean) => { try { s.destroy(); } catch { /* noop */ } resolve(v); };
  s.setTimeout(300, () => done(false));
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
});

/** Свободный порт (открываем на 0, запоминаем, закрываем). */
const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const port = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(port));
  });
});

describe("пинг рабочего узла (живой sing-box)", () => {
  let vlessServer: any = null;
  let httpServer: http.Server | null = null;
  let engineFound = false;
  let vlessPort = 0;
  let httpPort = 0;

  beforeAll(async () => {
    const eng = await core.detectEngine({ force: true });
    engineFound = !!eng.found;
    if (!engineFound) return;

    // Локальная цель: отдаёт 204, как generate_204.
    httpServer = http.createServer((req, res) => {
      if (req.url?.startsWith("/generate_204")) { res.statusCode = 204; res.end(); return; }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((r) => httpServer!.listen(0, "127.0.0.1", () => r()));
    httpPort = (httpServer!.address() as net.AddressInfo).port;

    // Локальный VLESS-сервер, чтобы узел был «настоящим».
    vlessPort = await freePort();
    const cfgPath = path.join(process.env.MOONAPP_STORAGE!, "vless-server.json");
    fs.writeFileSync(cfgPath, JSON.stringify({
      log: { level: "warn", output: "" },
      inbounds: [{ type: "vless", tag: "in", listen: "127.0.0.1", listen_port: vlessPort, users: [{ uuid: UUID, flow: "" }] }],
      outbounds: [{ type: "direct", tag: "direct" }],
    }, null, 2), "utf8");

    const chk = spawnSync(eng.path, ["check", "-c", cfgPath], { encoding: "utf8", windowsHide: true });
    expect(chk.status).toBe(0);

    vlessServer = spawn(eng.path, ["run", "-c", cfgPath, "--disable-color"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    vlessServer.stderr.on("data", () => {});
    for (let i = 0; i < 60 && !(await portOpen(vlessPort)); i++) await new Promise((r) => setTimeout(r, 150));
  }, 40000);

  afterAll(async () => {
    // Гасим сервер и ДОЖИДАЕМСЯ выхода: иначе воркер vitest не завершится,
    // а процесс останется держать порт.
    await core.stopChild(vlessServer).catch(() => { /* noop */ });
    try { httpServer?.close(); } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 200));
  });

  it("узел, который реально работает, получает ok=true и измеренный TTFB", async () => {
    if (!engineFound) return; // окружение без движка — пропускаем
    expect(await portOpen(vlessPort)).toBe(true);

    const node = { protocol: "vless", server: "127.0.0.1", port: vlessPort, uuid: UUID, security: "none", tag: "local" };
    const r = await core.pingNode(node, { targets: [`http://127.0.0.1:${httpPort}/generate_204`] });

    expect(r.ok).toBe(true);
    expect(r.error).toBe("");
    expect(typeof r.ttfbMs).toBe("number");
    expect(r.ttfbMs).toBeGreaterThan(0);
    expect(r.state).toBe("online");

    // Временное ядро должно быть погашено — порт пинга освободиться.
    expect(await core.isPortOpen(core.PING_SOCKS_PORT)).toBe(false);
  }, 60000);
});
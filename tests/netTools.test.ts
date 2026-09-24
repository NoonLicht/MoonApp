import { describe, it, expect } from "vitest";
import net from "net";
import { createRequire } from "module";

const req = createRequire(import.meta.url);
const engine: typeof import("../server/netTools") = req("../server/netTools");

describe("server/netTools — валидация и сканер портов", () => {
  it("ping/traceroute/portScan отвергают некорректный хост (защита от command injection)", async () => {
    await expect(engine.ping("8.8.8.8; rm -rf /")).rejects.toThrow("invalid_host");
    await expect(engine.traceroute("`whoami`")).rejects.toThrow("invalid_host");
    await expect(engine.portScan("evil && dir", 1, 10)).rejects.toThrow("invalid_host");
  });

  it("portScan отвергает слишком большой диапазон и перевёрнутый диапазон", async () => {
    await expect(engine.portScan("127.0.0.1", 1, 5000)).rejects.toThrow("range_too_large");
    await expect(engine.portScan("127.0.0.1", 100, 10)).rejects.toThrow("invalid_range");
  });

  it("portScan находит реально открытый локальный порт", async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const { results } = await engine.portScan("127.0.0.1", port, port);
      expect(results).toEqual([{ port, open: true }]);
    } finally {
      server.close();
    }
  });

  it("localInterfaces возвращает объект без падений", () => {
    const ifaces = engine.localInterfaces();
    expect(typeof ifaces).toBe("object");
  });
});

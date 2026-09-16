import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Интеграционный тест РЕАЛЬНОГО запуска ядра.
 *
 * Регресс, который он закрывает («выбрал конфиг, нажал включить — ничего не
 * происходит»): startCore возвращал состояние сразу после spawn, а признак
 * «запущено» брался из текста логов sing-box. При log.level=warn логов нет
 * вообще, поэтому ядро работало, а приложение считало прокси выключенным.
 * Теперь готовность определяется по открытию SOCKS-порта.
 *
 * Если движка в окружении нет — тест помечается пропущенным.
 */
const require = createRequire(import.meta.url);
process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-startcore-"));

const core = require("../server/proxyCore");

// Заведомо недоступный узел: sing-box всё равно стартует (соединение — ленивое),
// поэтому проверяем именно факт старта, а не связь.
const NODE = {
  protocol: "vless",
  server: "10.255.255.1",
  port: 443,
  uuid: "11111111-2222-3333-4444-555555555555",
  tls: true,
  sni: "example.com",
  tag: "test",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startCore — реальный запуск ядра", () => {
  beforeAll(async () => {
    const eng = await core.detectEngine({ force: true });
    if (!eng.found) console.warn("[startCore.test] sing-box не найден — тест пропущен");
  });

  it("startCore дожидается готовности и возвращает running=true", async () => {
    const eng = await core.detectEngine({ force: true });
    if (!eng.found) return; // окружение без движка — пропускаем

    const st = await core.startCore(NODE);
    expect(st.error).toBe("");
    // Главное утверждение: после await состояние уже истинное, без опроса извне.
    expect(st.running).toBe(true);
    expect(st.enabled).toBe(true);
    expect(st.socksPort).toBe(core.DEFAULT_SOCKS_PORT);

    // Ядро действительно приняло порт и продолжает жить.
    await sleep(300);
    expect(core.getCoreStatus().running).toBe(true);

    // stopCore обязан ДОЖДАТЬСЯ выхода процесса: иначе sing-box остаётся висеть
    // и держит 10808 (следующее включение прокси тогда молча падало).
    const after = await core.stopCore();
    expect(after.running).toBe(false);
    expect(after.enabled).toBe(false);
    expect(await core.isPortOpen(core.DEFAULT_SOCKS_PORT)).toBe(false);
  }, 30000);

  it("занятый порт даёт явную ошибку, а не молчание", async () => {
    const eng = await core.detectEngine({ force: true });
    if (!eng.found) return;

    await core.stopCore();
    const net = require("net");
    const squatter = net.createServer(() => {});
    await new Promise<void>((r) =>
      squatter.listen(core.DEFAULT_SOCKS_PORT, "127.0.0.1", () => r()),
    );
    try {
      const st = await core.startCore(NODE);
      expect(st.running).toBe(false);
      expect(st.error).toBe(`port_busy:${core.DEFAULT_SOCKS_PORT}`);
    } finally {
      squatter.close();
      await core.stopCore();
    }
  }, 30000);

  it("повторный цикл включить→выключить→включить работает (нет зависшего процесса)", async () => {
    const eng = await core.detectEngine({ force: true });
    if (!eng.found) return;

    const first = await core.startCore(NODE);
    expect(first.running).toBe(true);
    await core.stopCore();

    const second = await core.startCore(NODE);
    expect(second.error).toBe("");
    expect(second.running).toBe(true);
    await core.stopCore();
  }, 40000);
});

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Контракт входа сервера (server/ts/index.ts → server/index.js).
 *
 * Зачем тест: `require("../server")` — единственная точка входа сервера и для
 * Electron (electron/main.js: `const { startServer } = require("../server")`),
 * и для `node server/index.js`. Перевод на TS не должен её менять, а токен-защита
 * /api и listen строго на loopback — это безопасность, а не деталь реализации.
 *
 * Про окружение: сразу после require модуль поднимает фоновые задачи (автобэкапы,
 * автосинк подписок прокси, автозапуск LibreHardwareMonitor, автоиндексация
 * каталога winget). Таймеры бэкапов и подписок — unref и вреда не делают, а вот
 * LHM и winget на машине разработчика реально стартовали бы (процессы, сеть),
 * поэтому их ключи гасим ДО require. Тогда же убираем MOONAPP_TOKEN: если он
 * остался в окружении от внешнего запуска, «безтокенная» проверка стала бы врать.
 *
 * Модули грузим native-require (как в proxyCoreRoutes.test.ts): `await import()`
 * дал бы отдельный экземпляр модуля и собственные AUTH_TOKEN/settings.
 */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-index-"));
process.env.MOONAPP_STORAGE = STORAGE;
delete process.env.MOONAPP_TOKEN;

const require = createRequire(import.meta.url);
require("../server/settings").set({
  store: { wingetAutoIndex: false },
  monitor: { lhmAutoStart: false },
});
const server = require("../server");

/** Порт 0 → случайный свободный; ждём фактического listen и узнаём номер. */
async function portOf(srv: { listening: boolean; address: () => unknown }): Promise<number> {
  if (!srv.listening)
    await new Promise((r) => (srv as never as { once: unknown }).once("listening", r));
  return (srv.address() as { port: number }).port;
}

/** Закрыть сервер вместе с keep-alive-соединениями fetch (иначе тест висит). */
function stop(srv: { close: () => void; closeAllConnections?: () => void }): void {
  srv.closeAllConnections?.();
  srv.close();
}
describe("server/index — контракт входа", () => {
  it("экспортирует createApp/startServer/db и не имеет default (форма CommonJS)", () => {
    expect(typeof server.createApp).toBe("function");
    expect(typeof server.startServer).toBe("function");
    expect(server.db).toBeTruthy();
    // Форма экспорта важна: electron/main.js делает require("../server") и берёт
    // startServer; при `export default` он получил бы undefined.
    expect(server.default).toBeUndefined();
  });

  it("без токена: /api/health отвечает 200, сервер слушает только loopback", async () => {
    const srv = server.startServer(0);
    const port = await portOf(srv);
    // Только loopback: иначе к API (установка ПО, запуск файлов, ключи) получит
    // доступ вся локальная сеть — это проверка безопасности, а не деталь.
    expect((srv.address() as { address: string }).address).toBe("127.0.0.1");

    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    stop(srv);
  });

  it("с токеном: /api закрыт, ресурсные пути и статика отдаются без заголовка", async () => {
    const srv = server.startServer(0, { token: "s3cret" });
    const port = await portOf(srv);
    const base = `http://127.0.0.1:${port}`;
    const hdr = { headers: { "x-moonapp-token": "s3cret" } };

    const noHeader = await fetch(`${base}/api/health`);
    expect(noHeader.status).toBe(401);
    expect(await noHeader.json()).toEqual({ error: "unauthorized" });

    const wrong = await fetch(`${base}/api/health`, {
      headers: { "x-moonapp-token": "not-the-token" },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${base}/api/health`, hdr);
    expect(ok.status).toBe(200);

    // Ресурсный путь: браузер грузит его тегом <img>, заголовок передать нельзя,
    // поэтому токен не требуется (валидация — внутри роута movies).
    const img = await fetch(`${base}/api/movies/image?size=w92&path=/poster.jpg`);
    expect(img.status).not.toBe(401);

    // Ресурсные пути торрент-плеера: браузер грузит их тегами <video>/<track>,
    // заголовок передать нельзя, поэтому токен не требуется (валидация внутри
    // роутов). Регресс: стрим торрента раньше не был в allowlist и в собранной
    // сборке отвечал 401 — плеер не играл.
    const hash = "a".repeat(40);
    for (const p of [
      `/api/movies/torrent/stream/${hash}/0`,
      `/api/movies/torrent/remux/${hash}/0`,
      `/api/movies/torrent/subtitles/${hash}/0?track=0`,
    ]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).not.toBe(401);
    }

    // Не-/api путь (статика dist/, SPA-фолбэк) — не секрет, токен не нужен.
    const page = await fetch(`${base}/`);
    expect(page.status).not.toBe(401);
    stop(srv);
  });

  it("токен берётся из MOONAPP_TOKEN, если не передан явно", async () => {
    process.env.MOONAPP_TOKEN = "env-token";
    const srv = server.startServer(0);
    const port = await portOf(srv);
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(r.status).toBe(401);
    stop(srv);
    delete process.env.MOONAPP_TOKEN;
  });
});

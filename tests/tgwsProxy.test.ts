import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * TG WS Proxy — блок на странице Bypass (server/ts/tgwsproxy.ts).
 *
 * Тесты намеренно без сети и без запуска настоящего бинаря: telegram-прокси
 * качается с GitHub только по кнопке пользователя. Проверяем то, что можно
 * проверить локально: настройки/валидацию, поиск движка, понятные коды ошибок
 * и что запуск без движка не «зависает», а падает с tgws_not_installed.
 */
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-tgws-"));
  process.env.MOONAPP_STORAGE = path.join(dir, "storage");
  fs.mkdirSync(process.env.MOONAPP_STORAGE, { recursive: true });
  clearServerCache();
});

afterEach(() => {
  delete process.env.MOONAPP_STORAGE;
  clearServerCache();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Сбросить кэш серверных модулей: storage читается из env при импорте. */
function clearServerCache() {
  for (const key of Object.keys(require_.cache)) {
    if (key.includes(`${path.sep}server${path.sep}`)) delete require_.cache[key];
  }
}

interface TgwsModule {
  status(): Record<string, unknown>;
  statusLive(): Promise<Record<string, unknown>>;
  start(patch?: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(): Promise<Record<string, unknown>>;
  install(force?: boolean): Promise<unknown>;
  configure(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  rotateSecret(): Promise<Record<string, unknown>>;
  detectExe(): { path: string; bundled: boolean } | null;
  portFree(host: string, port: number): Promise<boolean>;
}

function tgws(): TgwsModule {
  clearServerCache();
  return require_(path.join(ROOT, "server", "tgwsproxy.js")) as TgwsModule;
}

/** Положить «движок» в storage/tgwsproxy (содержимое в тестах не запускается). */
function fakeExe(): string {
  const file = path.join(process.env.MOONAPP_STORAGE as string, "tgwsproxy", "TgWsProxy.exe");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not a real executable", "utf8");
  return file;
}
describe("tgws — статус и настройки блока", () => {
  it("по умолчанию: движка нет, порт 1443, секрет пуст (его нет смысла показывать)", async () => {
    const m = tgws();
    const st = await m.statusLive();
    expect(st.installed).toBe(false);
    expect(st.running).toBe(false);
    expect(st.port).toBe(1443);
    expect(st.host).toBe("127.0.0.1");
    expect(st.secret).toBe("");
    expect(st.link).toBe(""); // без секрета ссылку tg://proxy показать нельзя
    expect(st.autoStart).toBe(false);
  });

  it("порт и автозапуск сохраняются в настройках", async () => {
    const m = tgws();
    const st = await m.configure({ port: 2443, autoStart: true });
    expect(st.port).toBe(2443);
    expect(st.autoStart).toBe(true);
    // Значения переживают перезагрузку модуля: они лежат в settings.json.
    const again = await tgws().statusLive();
    expect(again.port).toBe(2443);
    expect(again.autoStart).toBe(true);
  });

  it("порт вне 1024..65535 отклоняется (в системе он занят или невозможен)", async () => {
    const m = tgws();
    await expect(m.configure({ port: 80 })).rejects.toThrow(/tgws_bad_port/);
    await expect(m.configure({ port: 70000 })).rejects.toThrow(/tgws_bad_port/);
    await expect(m.configure({ port: Number.NaN })).rejects.toThrow(/tgws_bad_port/);
  });

  it("секрет принимается только 32 hex-символа и в нижнем регистре", async () => {
    const m = tgws();
    await expect(m.configure({ secret: "short" })).rejects.toThrow(/tgws_bad_secret/);
    const st = await m.configure({ secret: "DD00112233445566778899AABBCCDDEEFF" });
    expect(st.secret).toBe("00112233445566778899aabbccddeeff");
    // Префикс dd (как в ссылке Telegram) пользователь может вставить целиком.
    expect(st.link).toBe(`tg://proxy?server=127.0.0.1&port=1443&secret=dd${st.secret}`);
  });

  it("новый секрет — другой, но тоже валидный", async () => {
    const m = tgws();
    const first = await m.rotateSecret();
    const second = await m.rotateSecret();
    expect(first.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(second.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(second.secret).not.toBe(first.secret);
  });
});

describe("tgws — движок", () => {
  it("detectExe находит скачанный бинарь в storage/tgwsproxy", async () => {
    const exe = fakeExe();
    const found = tgws().detectExe();
    expect(found?.path).toBe(exe);
    expect(found?.bundled).toBe(false);
    expect((await tgws().statusLive()).installed).toBe(true);
  });

  it("без движка start падает с tgws_not_installed и не запускает процессов", async () => {
    await expect(tgws().start()).rejects.toThrow(/tgws_not_installed/);
    expect((await tgws().statusLive()).running).toBe(false);
  });

  it("битый exe не поднимает порт: понятная ошибка, состояние сброшено", async () => {
    fakeExe();
    // Порт заведомо свободен, поэтому единственная причина отказа — сам exe.
    const live = tgws();
    await expect(live.start({ port: 24551 })).rejects.toThrow(/tgws_/);
    const st = await live.statusLive();
    expect(st.running).toBe(false);
    expect(st.starting).toBe(false);
    expect(String(st.error)).toMatch(/tgws_/);
  }, 90_000);

  it("autoStart по умолчанию ничего не делает (движка нет)", async () => {
    const m = tgws() as unknown as { autoStart(): Promise<void> };
    await expect(m.autoStart()).resolves.toBeUndefined();
  });
});
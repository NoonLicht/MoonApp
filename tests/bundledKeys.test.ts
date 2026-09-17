import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Вшитые в сборку ключи (server/bundled-keys.js) и их генератор
 * (scripts/gen-bundled-keys.mjs).
 *
 * Повод: страница «Фильмы и сериалы» требовала ключ TMDB от КАЖДОГО
 * пользователя, а публиковать ключ в репозитории нельзя. Ключ вшивается в
 * инсталлятор из секрета CI, а server/ts/tmdb.ts берёт его как ЗАПАСНОЙ
 * вариант: свой секрет пользователя (storage/secrets.json) всегда важнее.
 *
 * Тесты проверяют оба приоритета и поведение генератора (в т.ч. «ключа нет» —
 * файл удаляется, а не остаётся с пустым значением от прошлой сборки).
 */
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-bkeys-"));
  // Хранилище — временный каталог: секреты и настройки читаются из него.
  process.env.MOONAPP_STORAGE = path.join(dir, "storage");
  fs.mkdirSync(process.env.MOONAPP_STORAGE, { recursive: true });
});

afterEach(() => {
  delete process.env.MOONAPP_STORAGE;
  delete process.env.MOONAPP_BUNDLED_KEYS;
  delete process.env.MOONAPP_TMDB_KEY;
  delete process.env.TMDB_API_KEY;
  // Кэш серверных модулей держит старые пути/настройки — иначе следующий тест
  // увидел бы хранилище предыдущего.
  clearServerCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Сбросить require-кэш серверных модулей (config читает env при импорте). */
function clearServerCache() {
  for (const key of Object.keys(require_.cache)) {
    if (key.includes(`${path.sep}server${path.sep}`)) delete require_.cache[key];
  }
}

function req<T>(rel: string): T {
  return require_(rel) as T;
}
/** Создать «вшитый» файл ключей в temp-каталоге и вернуть его путь. */
function writeBundled(keys: Record<string, string>): string {
  const file = path.join(dir, "bundled-keys.js");
  fs.writeFileSync(file, `module.exports = ${JSON.stringify(keys)};\n`, "utf8");
  process.env.MOONAPP_BUNDLED_KEYS = file;
  return file;
}

/** Загрузить tmdb «с нуля» (после env-переменных текущего теста). */
function loadTmdb() {
  clearServerCache();
  return req<{
    hasKey(): boolean;
    keySource(): string;
    tmdbKey(): string;
  }>(path.join(ROOT, "server", "tmdb.js"));
}

describe("вшитый в сборку ключ TMDB (server/bundled-keys.js)", () => {
  it("без секрета пользователя ключ берётся из сборки", () => {
    writeBundled({ tmdb: "BUNDLED-123" });
    const m = loadTmdb();
    expect(m.keySource()).toBe("bundled");
    expect(m.hasKey()).toBe(true);
    expect(m.tmdbKey()).toBe("BUNDLED-123");
  });

  it("свой секрет переопределяет вшитый ключ", () => {
    writeBundled({ tmdb: "BUNDLED-123" });
    clearServerCache();
    req<{ setSecret(name: string, plain: string): void }>(
      path.join(ROOT, "server", "security.js"),
    ).setSecret("tmdb", "USER-KEY-777");

    const m = loadTmdb();
    expect(m.keySource()).toBe("secret");
    expect(m.tmdbKey()).toBe("USER-KEY-777");
  });

  it("нет ни секрета, ни файла — ключа нет (страница показывает форму ввода)", () => {
    process.env.MOONAPP_BUNDLED_KEYS = path.join(dir, "no-such-file.js");
    const m = loadTmdb();
    expect(m.keySource()).toBe("none");
    expect(m.hasKey()).toBe(false);
    expect(m.tmdbKey()).toBe("");
  });

  it("пустое значение в файле ключом не считается", () => {
    writeBundled({ tmdb: "   " });
    const m = loadTmdb();
    expect(m.keySource()).toBe("none");
    expect(m.hasKey()).toBe(false);
  });
});describe("scripts/gen-bundled-keys.mjs — генератор вшитых ключей", () => {
  /**
   * Скрипт пишет файл рядом с СОБОЙ (scripts/../server/bundled-keys.js), поэтому
   * запускаем копию в temp-каталоге: тест не должен тронуть настоящий
   * server/bundled-keys.js разработчика (в нём может лежать рабочий ключ).
   */
  function runGenerator(env: Record<string, string>) {
    const scripts = path.join(dir, "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(path.join(dir, "server"), { recursive: true });
    const script = path.join(scripts, "gen-bundled-keys.mjs");
    fs.copyFileSync(path.join(ROOT, "scripts", "gen-bundled-keys.mjs"), script);
    const out = execFileSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { out, file: path.join(dir, "server", "bundled-keys.js") };
  }

  it("с MOONAPP_TMDB_KEY пишет CommonJS-файл с ключом", () => {
    const { out, file } = runGenerator({ MOONAPP_TMDB_KEY: "CI-KEY-42" });
    expect(out).toContain("bundled tmdb");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain('tmdb: "CI-KEY-42"');
    // Файл — CommonJS: server/tmdb.js подхватывает его через require().
    expect(text).toContain("module.exports");
  });

  it("MOONAPP_TMDB_KEY важнее TMDB_API_KEY (порядок переменных)", () => {
    const { file } = runGenerator({ MOONAPP_TMDB_KEY: "FIRST", TMDB_API_KEY: "SECOND" });
    expect(fs.readFileSync(file, "utf8")).toContain('tmdb: "FIRST"');
  });

  it("TMDB_API_KEY тоже подходит (совместимость с секретами CI)", () => {
    const { file } = runGenerator({ TMDB_API_KEY: "ONLY-ENV" });
    expect(fs.readFileSync(file, "utf8")).toContain('tmdb: "ONLY-ENV"');
  });

  it("без ключа в окружении файл не создаётся, старый удаляется", () => {
    const first = runGenerator({ MOONAPP_TMDB_KEY: "OLD-KEY" });
    expect(fs.existsSync(first.file)).toBe(true);
    // Ключ убрали из секретов — в сборку не должен попасть старый файл.
    const second = runGenerator({ MOONAPP_TMDB_KEY: "" });
    expect(second.out).toContain("no keys in env");
    expect(fs.existsSync(second.file)).toBe(false);
  });
});
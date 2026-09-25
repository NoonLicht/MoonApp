import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/notesGit — конфиг и локальная часть (init/status) без сети.
 *
 * Полный цикл commit→pull(ff-only)→push, включая ветки "первый синк с пустым
 * удалённым репо", "клонирование на новую машину" и "конфликт при
 * разошедшейся истории", был вручную многократно проверен в разработке через
 * локальный git-http-backend (git-core, поднятый как smart-HTTP CGI-сервер) —
 * это НЕ имитация, а реальный протокол git поверх HTTP, тот же, что использует
 * GitHub/GitLab. Встраивать это в обычный vitest-прогон не стали: тест
 * спавнил бы дочерний процесс git-http-backend.exe и требовал бы системного
 * git с http-backend в PATH — риск нестабильности в CI важнее, чем польза от
 * ещё одного автотеста поверх уже пройденной вручную проверки.
 */
const req = createRequire(import.meta.url);

async function reachesGithub(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://github.com", { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

let storage: string;
let engine: typeof import("../server/notesGit");

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-notesgit-unit-"));
  process.env.MOONAPP_STORAGE = storage;
  engine = req("../server/notesGit");
});

// it.runIf() читает условие на этапе СБОРА тестов, до выполнения beforeAll —
// поэтому асинхронная проверка сети должна быть top-level await, а не внутри
// хука (см. аналогичный приём в tests/budget.test.ts).
const githubReachable = await reachesGithub();

describe("server/notesGit — конфигурация (без сети)", () => {
  it("getConfig отдаёт дефолты, пока ничего не настроено", () => {
    const cfg = engine.getConfig();
    expect(cfg.remoteUrl).toBe("");
    expect(cfg.branch).toBe("main");
    expect(cfg.hasToken).toBe(false);
  });

  it("setConfig сохраняет url/branch и не хранит токен в открытом виде в конфиге", () => {
    const cfg = engine.setConfig({
      remoteUrl: "https://example.com/repo.git",
      branch: "sync",
      authorName: "Test",
      authorEmail: "test@example.com",
      token: "ghp_secret123",
    });
    expect(cfg.remoteUrl).toBe("https://example.com/repo.git");
    expect(cfg.branch).toBe("sync");

    const full = engine.getConfig();
    expect(full.hasToken).toBe(true);
    expect(JSON.stringify(full)).not.toContain("ghp_secret123");

    const raw = fs.readFileSync(path.join(storage, "notes-git.json"), "utf8");
    expect(raw).not.toContain("ghp_secret123");
  });

  it("пустая branch откатывается на main", () => {
    const cfg = engine.setConfig({ branch: "   " });
    expect(cfg.branch).toBe("main");
  });
});

describe("server/notesGit — status() создаёт репозиторий при первом обращении", () => {
  it("status() на свежем vault без .git инициализирует репозиторий и сообщает dirty:false", async () => {
    const st = await engine.status();
    expect(st.dirty).toBe(false);
    expect(fs.existsSync(path.join(storage, "vault", ".git"))).toBe(true);
  });
});

describe("server/notesGit — testConnection() (проверка приватного/публичного репозитория)", () => {
  it("без remoteUrl отказывает честной ошибкой, без сети", async () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), "pa-notesgit-test-"));
    process.env.MOONAPP_STORAGE = s;
    for (const key of Object.keys(require.cache)) {
      if (key.includes(path.join("server"))) delete require.cache[key];
    }
    const fresh: typeof import("../server/notesGit") = req("../server/notesGit");
    const r = await fresh.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_remote_url");
    expect(r.usedAuth).toBe(false);
  });

  it.runIf(githubReachable)(
    "реальный публичный репозиторий на GitHub — ok:true, usedAuth:false, список веток",
    async () => {
      const s = fs.mkdtempSync(path.join(os.tmpdir(), "pa-notesgit-test2-"));
      process.env.MOONAPP_STORAGE = s;
      for (const key of Object.keys(require.cache)) {
        if (key.includes(path.join("server"))) delete require.cache[key];
      }
      const fresh: typeof import("../server/notesGit") = req("../server/notesGit");
      fresh.setConfig({ remoteUrl: "https://github.com/octocat/Hello-World.git" });
      const r = await fresh.testConnection();
      expect(r.ok).toBe(true);
      expect(r.usedAuth).toBe(false);
      expect(r.branches?.length).toBeGreaterThan(0);
    },
    20000,
  );
});

describe("server/notesGit — sync() без remoteUrl честно отказывает", () => {
  it("sync() возвращает remote_not_set, если URL не настроен", async () => {
    const s2 = fs.mkdtempSync(path.join(os.tmpdir(), "pa-notesgit-unit2-"));
    process.env.MOONAPP_STORAGE = s2;
    for (const key of Object.keys(require.cache)) {
      if (key.includes(path.join("server"))) delete require.cache[key];
    }
    const fresh: typeof import("../server/notesGit") = req("../server/notesGit");
    const r = await fresh.sync();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("remote_not_set");
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

beforeAll(() => {
  // Изолируем storage для тестов во временной папке (как в tests/server.test.ts).
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-bypass-"));
});

describe("zapret — пользовательские списки (ipset/hostlist)", () => {
  it("создаёт отсутствующие списки с дефолтами service.bat", async () => {
    const zapret = await import("../server/zapret");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-lists-"));
    const created = zapret.ensureUserLists(dir);
    expect(created).toContain("ipset-exclude-user.txt");
    expect(fs.readFileSync(path.join(dir, "ipset-exclude-user.txt"), "utf8").trim()).toBe(
      "203.0.113.113/32",
    ); // sentinel: пустой ipset-файл winws не принимает
    expect(fs.existsSync(path.join(dir, "list-general-user.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "list-exclude-user.txt"))).toBe(true);
    // Повторный вызов ничего не пересоздаёт (пользовательские данные не затираются).
    expect(zapret.ensureUserLists(dir)).toEqual([]);
  });

  it("находит файловые аргументы winws, которых нет на диске", async () => {
    const zapret = await import("../server/zapret");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-lists2-"));
    fs.writeFileSync(path.join(dir, "list-general-user.txt"), "example.com\n", "utf8");
    const tokens = [
      `--hostlist="${path.join(dir, "list-general-user.txt")}"`,
      `--ipset-exclude="${path.join(dir, "ipset-exclude-user.txt")}"`,
      "--hostlist-domains=example.com", // домены, не файл — не проверяем
      "--dpi-desync=fake",
      "--dpi-desync-fake-tls=missing_payload.bin", // относительный путь → в lists/
    ];
    const missing = zapret.missingListFiles(tokens, dir);
    expect(missing).toContain("ipset-exclude-user.txt");
    expect(missing).toContain("missing_payload.bin");
    expect(missing).not.toContain("list-general-user.txt");
    expect(missing).not.toContain("example.com");
  });
});

describe("zapret — разбор вывода проверки конфигов (огоньки)", () => {
  // Образец реального вывода utils/test zapret.ps1 (standard, все конфиги).
  const OUTPUT = [
    "============================================================",
    "                 ZAPRET CONFIG TESTS",
    "  [1/3] general.bat",
    "YouTubeWeb            HTTP:OK    TLS1.2:OK    TLS1.3:OK     | Ping: 12 ms",
    "  [2/3] general (ALT2).bat",
    "  > Strategy failed to start (winws process not found). Skipping...",
    "  [3/3] general (ALT3).bat",
    "YouTubeWeb            HTTP:OK    TLS1.2:UNSUP  TLS1.3:OK     | Ping: Timeout",
    "=== ANALYTICS ===",
    "general.bat             : HTTP OK:  45, ERR:   0, UNSUP:   0, Ping OK:  16, Fail:   0",
    "general (ALT3).bat      : HTTP OK:  47, ERR:   0, UNSUP:   2, Ping OK:  14, Fail:   2",
    "Best strategy: general.bat",
  ];

  it("делит конфиги на зелёный/красный", async () => {
    const zapret = await import("../server/zapret");
    const st = zapret.parseCheckOutput(OUTPUT, { persist: false });
    expect(st.best).toBe("general.bat");
    expect(st.progress.total).toBe(3);

    const ok = st.results.find((r: { strategyId: string }) => r.strategyId === "general");
    expect(ok.okCount).toBe(45);
    expect(ok.error).toBe(0);
    expect(zapret.lightOk(ok)).toBe(true);

    const failed = st.results.find((r: { strategyId: string }) => r.strategyId === "alt2");
    expect(failed.failedToStart).toBe(true);
    expect(zapret.lightOk(failed)).toBe(false);

    // ALT3: ошибок нет (UNSUP — «метод не поддержан целью», ICMP-таймауты игнорируем) → рабочий.
    const unsupOnly = st.results.find((r: { strategyId: string }) => r.strategyId === "alt3");
    expect(unsupOnly.error).toBe(0);
    expect(unsupOnly.unsup).toBe(2);
    expect(unsupOnly.pingFail).toBe(2);
    expect(zapret.lightOk(unsupOnly)).toBe(true);
  });

  it("маппит имя .bat в id плитки (как на странице)", async () => {
    const zapret = await import("../server/zapret");
    expect(zapret.strategyId("general.bat")).toBe("general");
    expect(zapret.strategyId("general (ALT12).bat")).toBe("alt12");
    expect(zapret.strategyId("general (FAKE TLS AUTO ALT2).bat")).toBe("fake-tls-auto-alt2");
  });

  it("зелёный огонёк зависит только от HTTP/TLS, а не от ICMP-пинга", async () => {
    const zapret = await import("../server/zapret");
    const st = zapret.parseCheckOutput(
      [
        "  [1/1] general.bat",
        "general.bat             : HTTP OK:  45, ERR:   0, UNSUP:   0, Ping OK:   3, Fail:  13",
        "Best config: general.bat",
      ],
      { persist: false },
    );
    const onlyPing = st.results[0];
    expect(onlyPing.pingFail).toBe(13); // ICMP режет firewall — это не приговор
    expect(zapret.lightOk(onlyPing)).toBe(true); // HTTP/TLS прошли → конфиг зелёный
    expect(st.bestId).toBe("general"); // «Best config» → id плитки для подсветки
  });

  it("«лучший» конфиг тоже зелёный, даже если в нём есть ERR", async () => {
    const zapret = await import("../server/zapret");
    // Реальный случай: у всех конфигов есть ошибки, скрипт выбирает лучший из них.
    const withErrors = {
      strategyId: "alt7",
      okCount: 33,
      error: 3,
      unsup: 0,
      failedToStart: false,
    };
    expect(zapret.lightOk(withErrors)).toBe(false); // строгий критерий: есть ERR
    expect(zapret.lightGreen(withErrors, "general")).toBe(false);
    expect(zapret.lightGreen(withErrors, "alt7")).toBe(true); // он же «Best config» → зелёный
    // Конфиг, который вообще ничего не прошёл, зелёным не станет никогда.
    const broken = { strategyId: "alt5", okCount: 0, error: 36, unsup: 0, failedToStart: false };
    expect(zapret.lightGreen(broken, "alt5")).toBe(false);
  });

  it("после прогона зелёным остаётся только лучший конфиг", async () => {
    const zapret = await import("../server/zapret");
    // Реальные цифры: у обоих конфигов есть ошибки, «Best config» назвал ALT9.
    zapret.parseCheckOutput(
      [
        "  [1/2] general (ALT9).bat",
        "general (ALT9).bat      : HTTP OK:  33, ERR:   3, UNSUP:   0, Ping OK:  12, Fail:   4",
        "  [2/2] general (ALT10).bat",
        "general (ALT10).bat     : HTTP OK:  17, ERR:  19, UNSUP:   0, Ping OK:  15, Fail:   1",
        "Best config: general (ALT9).bat",
      ],
      { persist: true },
    );
    zapret.finalizeLights();

    const lights = zapret.checkStatus().lights as Record<string, { ok: number }>;
    expect(Number(lights.alt9.ok)).toBe(1); // лучший → зелёный
    expect(Number(lights.alt10.ok)).toBe(0); // остальные → красные
  });
});

describe("zapret — детект запуска winws (elevated-процесс без пути)", () => {
  const ENGINE = "C:\\Users\\MoonToon\\Desktop\\App\\storage\\zapret";

  it("наш процесс с известным путём — стартовал, чужие считаются остановленными", async () => {
    const zapret = await import("../server/zapret");
    const det = zapret.decideWinwsStarted({
      procs: [
        { pid: 100, path: path.join(ENGINE, "bin", "winws.exe") },
        { pid: 200, path: "C:\\Other\\zapret\\bin\\winws.exe" },
      ],
      engineDir: ENGINE,
      logStarted: false,
    });
    expect(det.started).toBe(true);
    expect(det.pid).toBe(100);
    expect(det.killed).toBe(1);
    expect(det.reason).toBe("path");
  });

  it("пустой путь (процесс elevated) — всё равно считаем стартовавшим", async () => {
    const zapret = await import("../server/zapret");
    // Реальность: Get-Process → Path='', CIM → ExecutablePath='', но PID виден.
    const det = zapret.decideWinwsStarted({
      procs: [{ pid: 5976, path: "" }],
      engineDir: ENGINE,
      logStarted: false,
    });
    expect(det.started).toBe(true);
    expect(det.pid).toBe(5976);
    expect(det.reason).toBe("elevated_path_unknown");
  });

  it("процесса нет, но в логе есть маркер захвата — стартовал", async () => {
    const zapret = await import("../server/zapret");
    const det = zapret.decideWinwsStarted({ procs: [], engineDir: ENGINE, logStarted: true });
    expect(det.started).toBe(true);
    expect(det.pid).toBeNull();
    expect(det.reason).toBe("log");
  });

  it("чужой путь без маркеров и пустой список — не стартовал", async () => {
    const zapret = await import("../server/zapret");
    const foreign = zapret.decideWinwsStarted({
      procs: [{ pid: 7, path: "C:\\Other\\zapret\\bin\\winws.exe" }],
      engineDir: ENGINE,
      logStarted: false,
    });
    expect(foreign.started).toBe(false);
    expect(foreign.reason).toBe("not_found");
    expect(
      zapret.decideWinwsStarted({ procs: [], engineDir: ENGINE, logStarted: false }).started,
    ).toBe(false);
  });
  describe("zapret — запуск конфига через сам .bat движка", () => {
    it("оболочка гасит прежний winws и вызывает нужный .bat с <nul", async () => {
      const zapret = await import("../server/zapret");
      const bat = "C:\\Users\\MoonToon\\Desktop\\App\\storage\\zapret\\general (ALT11).bat";
      const engine = "C:\\Users\\MoonToon\\Desktop\\App\\storage\\zapret";
      const s = zapret.buildBatLaunchScript(bat, engine);
      const lines = s.split("\r\n");
      expect(lines[0]).toBe("@echo off");
      expect(lines[1]).toBe("chcp 65001 >nul");
      // vendor-проверку обновлений (до ~9 c сетевого запроса) отключаем: у приложения своя
      expect(lines[2]).toBe('set "NO_UPDATE_CHECK=1"');
      expect(lines[3]).toBe(`cd /d "${engine}"`);
      // Чистый старт: иначе два winws дерутся за драйвер WinDivert.
      expect(s).toContain("taskkill /IM winws.exe /F");
      // Ключевое: запускается именно .bat конфига (со всеми его пред-шагами).
      expect(lines[lines.length - 1]).toBe(`call "${bat}" <nul`);
      // .bat в кавычках — путь содержит пробелы («general (ALT11).bat»).
      expect(s).toContain(
        'call "C:\\Users\\MoonToon\\Desktop\\App\\storage\\zapret\\general (ALT11).bat"',
      );
    });
  });
});
describe("zapret — порядок конфигов как в vendor utils/test zapret.ps1", () => {
  it("нумерует ALT перед ALT10 и держит general.bat последним (как PowerShell)", async () => {
    const zapret = await import("../server/zapret");
    const files = [
      "general.bat",
      "general (ALT).bat",
      "general (ALT2).bat",
      "general (ALT10).bat",
      "general (EXP).bat",
      "service.bat", // служебный — отфильтровывается вызывающим, не участвует в сортировке
    ].filter((f) => !/^service/i.test(f));
    const order = zapret.vendorOrder(files);
    expect(order).toEqual([
      "general (ALT).bat",
      "general (ALT2).bat",
      "general (ALT10).bat",
      "general (EXP).bat",
      "general.bat",
    ]);
  });
});

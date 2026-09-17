import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import EventEmitter from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Установка Python-окружения озвучки (server/ts/pyEnv.ts + POST /api/tts/env/*).
 *
 * Что проверяем: «пользователю не надо ничего вводить в консоль» — приложение
 * само запускает pip нужной сборкой (CUDA 13.2 для RTX, CUDA 12.6 для карт без
 * RT-ядер, CPU), показывает прогресс и умеет отменять установку. pip подменён
 * заглушкой: тест не должен качать гигабайты;
 * python-проба тоже подменена (её ответ — JSON-строка).
 *
 * Проверяем и «цену ошибки»: сбой pip оставляет понятную ошибку шага, отмена
 * гасит процесс (на Windows — taskkill дерева), интерпретатор из установки
 * сохраняется в настройки (voice.pythonCmd), иначе проверка окружения смотрела
 * бы на другой python и «модулей всё ещё нет».
 */
const req = createRequire(import.meta.url);

/** Правдоподобный вывод pip: по нему считается прогресс и наполняется лог. */
const PIP_LINES = [
  "Collecting torch",
  "  Downloading torch-2.5.1-cp313-cp313-win_amd64.whl (200.0 MB)",
  "Installing collected packages: torch",
  "Successfully installed torch-2.5.1",
];

describe("Установка Python-окружения (/api/tts/env/*)", () => {
  let srv: any = null;
  let base = "";
  let storage = "";
  let pyEnv: any;
  let tts: any;
  let settings: any;
  let cp: any;
  /** Все вызовы spawn: [cmd, ...args] — по ним видно, что именно запускалось. */
  let calls: string[][] = [];
  /** Ручной режим: pip не закрывается сам, пока тест его не «завершит». */
  let manualPip: { child: any } | null = null;
  let pipCloseCode = 0;
  /**
   * Имя карты для nvidia-smi-заглушки. По умолчанию — RTX; тест про старые карты
   * подменяет на GTX, чтобы проверить выбор сборки cu126 вместо cu132.
   */
  let gpuOverride: string | null = null;

  const api = async (route: string, init?: RequestInit) => {
    const res = await fetch(`${base}/api/tts${route}`, init);
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* пустое тело */
    }
    return { status: res.status, body };
  };

  const post = (route: string, body: unknown) =>
    api(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  /** Дождаться состояния задачи (working/done/error) — с таймаутом. */
  async function waitState(state: string, ms = 4000): Promise<any> {
    const t0 = Date.now();
    for (;;) {
      const snap = pyEnv.installSnapshot();
      if (snap.state.state === state) return snap;
      if (Date.now() - t0 > ms)
        throw new Error(`задача не дошла до ${state}, сейчас ${snap.state.state}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  beforeAll(async () => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-pyenv-"));
    process.env.MOONAPP_STORAGE = storage;

    const express = require("express");
    settings = req("../server/settings");
    tts = req("../server/tts");
    pyEnv = req("../server/pyEnv");
    const router = require("../server/routes/tts");

    // python-проба и nvidia-smi подменены: тест не ходит в систему.
    tts.pythonEnv = async () => ({
      ok: true,
      error: "",
      detail: "",
      cmd: "python",
      python: "3.13.5",
      executable: "C:/Python313/python.exe",
      modules: { torch: true, torchaudio: true, f5_tts: true, TTS: false },
      missingF5: [],
      missingXtts: ["TTS"],
      installF5: "",
      installXtts: "pip install TTS",
      checkedAt: Date.now(),
      cached: false,
    });
    tts.detectHardware = async () => ({
      gpu: { found: true, name: gpuOverride || "RTX 5060 Ti" },
      cpu: { name: "CPU", cores: 8 },
      platform: "win32",
      optimal: {},
    });

    cp = require("child_process");
    cp.spawn = (cmd: string, args: string[] = []) => {
      calls.push([cmd, ...args]);
      const child: any = new EventEmitter();
      child.pid = 1000 + calls.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        child.killed = true;
      };
      const emit = (lines: string[], code = 0, delay = 5) => {
        setTimeout(() => {
          for (const l of lines) child.stdout.emit("data", Buffer.from(`${l}\n`));
          child.emit("close", code);
        }, delay);
      };
      const joined = args.join(" ");
      if (joined.includes("python_env.py")) {
        // Проба интерпретатора: JSON, как у server/engines/python_env.py.
        emit([
          JSON.stringify({
            python: "3.13.5",
            executable: "C:/Python313/python.exe",
            modules: { torch: true, torchaudio: true, f5_tts: true, TTS: true, pynvml: false },
          }),
        ]);
      } else if (joined.includes("-0p")) {
        emit([" -V:3.13 *        C:\\Python313\\python.exe"]);
      } else if (cmd === "where" || cmd === "which") {
        emit(["C:\\Python313\\python.exe"]);
      } else if (joined.includes("-m pip")) {
        if (manualPip) {
          manualPip = { child };
          return child;
        }
        emit(PIP_LINES, pipCloseCode);
      } else {
        emit([], 0, 0); // taskkill и прочие служебные вызовы
      }
      return child;
    };

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/tts", router);
    await new Promise<void>((resolve) => {
      srv = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  afterAll(() => {
    try {
      srv?.close();
    } catch {
      /* noop */
    }
    try {
      fs.rmSync(storage, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  beforeEach(async () => {
    calls = [];
    manualPip = null;
    pipCloseCode = 0;
    settings.set({ voice: { pythonCmd: "python" } });
    pyEnv.cancel();
    await new Promise((r) => setTimeout(r, 30));
  });

  it("команда pip собирается под выбранную сборку", () => {
    const cpu = pyEnv.pipCommand("f5", "cpu", "py");
    const cuda = pyEnv.pipCommand("xtts", "cuda", "py");
    const legacy = pyEnv.pipCommand("f5", "cudaLegacy", "py");
    expect(cpu).toContain(
      "py -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu",
    );
    expect(cpu).toContain("py -m pip install f5-tts");
    // Актуальный стабильный индекс (PyTorch 2.14): CUDA 13.2.
    expect(cuda).toContain("https://download.pytorch.org/whl/cu132");
    expect(cuda).toContain("py -m pip install TTS");
    // Карты без RT-ядер (Maxwell/Pascal/Volta) получают CUDA 12.6: сборки на
    // CUDA 12.8+ собраны только под sm_75+ и на таких картах не запускаются.
    expect(legacy).toContain("https://download.pytorch.org/whl/cu126");
    expect(legacy).not.toContain("cu132");
    // Монитор VRAM (pynvml) осмысленен только с видеокартой.
    expect(cuda).toContain("nvidia-ml-py");
    expect(legacy).toContain("nvidia-ml-py");
    expect(cpu).not.toContain("nvidia-ml-py");
  });

  it("устаревшие ссылки на cu121 не остались нигде", () => {
    const legacy = pyEnv.pipCommand("f5", "cuda", "py");
    expect(legacy).not.toContain("cu121");
  });

  it("движок и устройство из запроса нормализуются (мусор → безопасные значения)", () => {
    expect(pyEnv.engineOf("xtts")).toBe("xtts");
    expect(pyEnv.engineOf("что-то")).toBe("f5");
    expect(pyEnv.deviceOf("cpu")).toBe("cpu");
    expect(pyEnv.deviceOf("cudaLegacy")).toBe("cudaLegacy");
    expect(pyEnv.deviceOf("cuda")).toBe("cuda");
    expect(pyEnv.deviceOf("../../etc/passwd")).toBe("cuda");
    expect(pyEnv.deviceOf(undefined)).toBe("cuda");
  });

  it("карты без RT-ядер отличаются от RTX (иначе cu132 не запустится)", () => {
    for (const legacy of [
      "NVIDIA GeForce GTX 1060 6GB",
      "NVIDIA GeForce GTX 970",
      "NVIDIA GeForce GTX 750 Ti",
      "TITAN X (Pascal)",
      "TITAN V",
      "Quadro P2000",
      "Tesla V100-SXM2-16GB",
    ]) {
      expect(pyEnv.isLegacyGpu(legacy), legacy).toBe(true);
    }
    for (const modern of [
      "NVIDIA GeForce RTX 5060 Ti",
      "NVIDIA GeForce RTX 3060",
      "NVIDIA GeForce GTX 1660 Ti", // 16xx — уже Turing (sm_75)
      "Quadro RTX 4000",
      "NVIDIA H100 PCIe",
      "",
    ]) {
      expect(pyEnv.isLegacyGpu(modern), modern).toBe(false);
    }
  });

  it("план установки отдаёт все три сборки и рекомендацию по железу", async () => {
    const { status, body } = await api("/env/install?engine=f5&device=cpu");
    expect(status).toBe(200);
    expect(body.recommended).toBe("cuda"); // nvidia-smi видит RTX 5060 Ti
    expect(body.gpuName).toBe("RTX 5060 Ti");
    expect(body.chosen).toBe("cpu");
    expect(Object.keys(body.plans).sort()).toEqual(["cpu", "cuda", "cudaLegacy"]);
    expect(body.plans.cpu.command).toContain("whl/cpu");
    expect(body.plans.cuda.command).toContain("cu132");
    expect(body.plans.cudaLegacy.command).toContain("cu126");
    // CPU-сборка torch заметно легче — по этим числам UI показывает объём.
    expect(body.plans.cpu.approxMb).toBeLessThan(body.plans.cuda.approxMb);
    expect(body.plans.cudaLegacy.approxMb).toBe(body.plans.cuda.approxMb);
    expect(body.plans.cuda.steps).toEqual(["torch", "engine", "monitor"]);
    expect(body.plans.cudaLegacy.steps).toEqual(["torch", "engine", "monitor"]);
    expect(body.plans.cpu.steps).toEqual(["torch", "engine"]);
  });

  it("для старой карты рекомендация — сборка cu126, а не cu132", async () => {
    // Та же машина, но nvidia-smi отдаёт GTX 1060 (Pascal, без RT-ядер).
    gpuOverride = "NVIDIA GeForce GTX 1060 6GB";
    try {
      const { body } = await api("/env/install?engine=f5&device=cuda");
      expect(body.recommended).toBe("cudaLegacy");
      expect(body.plans[body.recommended].command).toContain("cu126");
    } finally {
      gpuOverride = null;
    }
  });

  it("установка идёт шагами, прогресс и лог пишутся в состояние, интерпретатор сохраняется", async () => {
    const py = "C:\\Python313\\python.exe";
    const start = await post("/env/install", { engine: "f5", device: "cpu", python: py });
    expect(start.status).toBe(201);
    expect(start.body.state.state).toBe("working");
    expect(start.body.steps).toEqual(["torch", "engine"]);
    expect(start.body.step).toBe("torch");
    expect(start.body.python).toBe(py);

    // Вторая установка параллельно невозможна: одна задача за раз.
    const again = await post("/env/install", { engine: "f5", device: "cpu" });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("busy");

    const done = await waitState("done");
    expect(done.state.progress).toBe(100);
    expect(done.log.join("\n")).toContain("Successfully installed torch-2.5.1");
    // Первым шагом — именно pip выбранного интерпретатора и CPU-индекс.
    const pipCall = calls.find((c) => c.includes("-m") && c.includes("pip") && c.includes("torch"));
    expect(pipCall?.[0]).toBe(py);
    expect(pipCall?.join(" ")).toContain("--index-url https://download.pytorch.org/whl/cpu");
    expect(pipCall?.join(" ")).toContain("--no-input");
    // Интерпретатор записан в настройки: иначе проверка окружения смотрела бы
    // на другой python и модули «всё ещё не находились».
    expect(settings.get("voice").pythonCmd).toBe(py);
    // В ответе /env прогресс установки виден странице без отдельного запроса.
    const env = await api("/env");
    expect(env.body.install.state.state).toBe("done");
  });

  it("сбой pip — ошибка шага, окружение не считается установленным", async () => {
    pipCloseCode = 1;
    await post("/env/install", { engine: "xtts", device: "cuda" });
    const failed = await waitState("error");
    expect(failed.state.error).toBe("pip_failed: torch");
    expect(failed.state.kind).toBe("pyenv");
  });

  it("отмена гасит процесс pip и завершает задачу со статусом cancelled", async () => {
    manualPip = { child: null };
    await post("/env/install", { engine: "f5", device: "cuda" });
    await new Promise((r) => setTimeout(r, 40));
    const cancelled = await post("/env/cancel", {});
    expect(cancelled.status).toBe(200);
    // Процесс гасится по-настоящему: на Windows — через taskkill дерева.
    if (process.platform === "win32") {
      expect(calls.some((c) => c[0] === "taskkill")).toBe(true);
    }
    // pip «доигрывает»: задача обязана закрыться с ошибкой cancelled, а не висеть.
    manualPip?.child.emit("close", 0);
    const failed = await waitState("error");
    expect(failed.state.error).toBe("cancelled");
  });

  it("интерпретатор сохраняется отдельным запросом, пустой — отклоняется", async () => {
    const ok = await post("/env/python", { cmd: "C:\\Python313\\python.exe" });
    expect(ok.status).toBe(200);
    expect(ok.body.cmd).toBe("C:\\Python313\\python.exe");
    expect(settings.get("voice").pythonCmd).toBe("C:\\Python313\\python.exe");

    const bad = await post("/env/python", { cmd: "   " });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("empty_python");
  });

  it("поиск интерпретаторов проверяет каждый и показывает его модули", async () => {
    const { status, body } = await api("/env/interpreters");
    expect(status).toBe(200);
    expect(body.list.length).toBeGreaterThanOrEqual(1);
    const first = body.list[0];
    expect(first.ok).toBe(true);
    expect(first.python).toBe("3.13.5");
    // Проба возвращает установленные модули — по ним UI рисует бейджи.
    expect(first.modules.torch).toBe(true);
    expect(first.missingF5).toEqual([]);
    expect(first.missingXtts).toEqual([]);
    // Дубли одного и того же python.exe из разных источников не показываем.
    const execs = body.list.map((i: any) => (i.executable || i.cmd).toLowerCase());
    expect(new Set(execs).size).toBe(execs.length);
  });
});

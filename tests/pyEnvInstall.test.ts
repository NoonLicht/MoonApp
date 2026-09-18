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
 * само запускает pip нужной сборкой (CUDA 12.8 или CPU), показывает прогресс и
 * умеет отменять установку. pip подменён заглушкой: тест не должен качать
 * гигабайты; python-проба тоже подменена (её ответ — JSON-строка).
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
      gpu: { found: true, name: "RTX 5060 Ti" },
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
    expect(cpu).toContain(
      "py -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu",
    );
    expect(cpu).toContain("py -m pip install f5-tts");
    // Индекс CUDA 12.8: в cu132 пакета torchaudio нет вовсе, и pip падал на
    // шаге «torch» с «No matching distribution found for torchaudio».
    expect(cuda).toContain(
      "py -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128",
    );
    expect(cuda).toContain("py -m pip install coqui-tts");
    // Классический `TTS` (coqui-ai) заморожен на Python < 3.12 и публикуется
    // только исходниками, а его setup.py требует numpy: без этого pip падает на
    // «ModuleNotFoundError: No module named 'numpy'». Такой вариант остаётся лишь
    // для Python 3.9 и старше — и собирается без изоляции (numpy уже стоит шагом
    // «torch»).
    const legacy = pyEnv.pipCommand("xtts", "cuda", "py", "3.9.13");
    expect(legacy).toContain("py -m pip install TTS --no-build-isolation");
    expect(legacy).not.toContain("coqui-tts");
    // Монитор VRAM (pynvml) осмысленен только с видеокартой.
    expect(cuda).toContain("nvidia-ml-py");
    expect(cpu).not.toContain("nvidia-ml-py");
  });

  it("чужих CUDA-индексов в командах нет (только cu128)", () => {
    const cuda = pyEnv.pipCommand("f5", "cuda", "py");
    for (const bad of ["cu121", "cu126", "cu132"]) expect(cuda).not.toContain(bad);
  });

  it("движок и устройство из запроса нормализуются (мусор → безопасные значения)", () => {
    expect(pyEnv.engineOf("xtts")).toBe("xtts");
    expect(pyEnv.engineOf("что-то")).toBe("f5");
    expect(pyEnv.deviceOf("cpu")).toBe("cpu");
    expect(pyEnv.deviceOf("cuda")).toBe("cuda");
    // Незнакомое значение (в т.ч. старый cudaLegacy) → обычная CUDA-сборка.
    expect(pyEnv.deviceOf("cudaLegacy")).toBe("cuda");
    expect(pyEnv.deviceOf("../../etc/passwd")).toBe("cuda");
    expect(pyEnv.deviceOf(undefined)).toBe("cuda");
  });

  it("план установки отдаёт обе сборки и рекомендацию по железу", async () => {
    const { status, body } = await api("/env/install?engine=f5&device=cpu");
    expect(status).toBe(200);
    expect(body.recommended).toBe("cuda"); // nvidia-smi видит карту
    expect(body.gpuName).toBe("RTX 5060 Ti");
    expect(body.chosen).toBe("cpu");
    expect(Object.keys(body.plans).sort()).toEqual(["cpu", "cuda"]);
    expect(body.plans.cpu.command).toContain("whl/cpu");
    expect(body.plans.cuda.command).toContain("cu128");
    // CPU-сборка torch заметно легче — по этим числам UI показывает объём.
    expect(body.plans.cpu.approxMb).toBeLessThan(body.plans.cuda.approxMb);
    // «stress» — установка RUAccent (расстановка ударений, server/engines/ru_accent.py):
    // идёт вместе с движком, чтобы тумблер «Ударения» работал сразу.
    expect(body.plans.cuda.steps).toEqual(["torch", "engine", "stress", "monitor"]);
    expect(body.plans.cpu.steps).toEqual(["torch", "engine", "stress"]);
  });

  it("установка идёт шагами, прогресс и лог пишутся в состояние, интерпретатор сохраняется", async () => {
    const py = "C:\\Python313\\python.exe";
    const start = await post("/env/install", { engine: "f5", device: "cpu", python: py });
    expect(start.status).toBe(201);
    expect(start.body.state.state).toBe("working");
    expect(start.body.steps).toEqual(["torch", "engine", "stress"]);
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

/**
 * OCR PDF (PaddleOCR) + PDF → JPG (PyMuPDF) для PDF-тулкита конвертера.
 *
 * Тот же Python-интерпретатор, что уже настроен для озвучки (voice.pythonCmd,
 * см. server/ts/pyEnv.ts) — отдельного окружения заводить не нужно, GPU/CPU
 * выбирается тем же способом (nvidia-smi через detectHardware из tts.ts).
 * Мост — server/engines/ocr_paddle.py: rasterize (PyMuPDF, лёгкий, без
 * PaddleOCR) и ocr/rasterize_ocr (PaddleOCR, тяжелее — модели ~30-100 МБ
 * качаются самим paddleocr при первом запуске, как и модели whisper/F5-TTS).
 *
 * Установка — тот же паттерн "тихая установка" (InstallState), что у ffmpeg
 * в server/ts/convertEngine.ts: pip install по шагам, прогресс через
 * installStatus(), UI опрашивает GET /api/pdf/ocr/install.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import config from "./config";
import logger from "./logger";
import settings from "./settings";

const { DIRS } = config;

const PY_ENV = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
const SCRIPT = path.join(__dirname, "engines", "ocr_paddle.py");

/* eslint-disable @typescript-eslint/no-require-imports */
const { detectHardware } = require("./tts") as { detectHardware: () => Promise<{ gpu: { found: boolean } }> };

function pythonFor(): string {
  return String(settings.get("voice")?.pythonCmd || "python").trim() || "python";
}

function ocrWorkDir(): string {
  const dir = path.join(DIRS.storage, "ocr");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Быстрая проверка: какие модули уже стоят у текущего интерпретатора. */
function probeModules(python: string): Promise<{ fitz: boolean; paddleocr: boolean }> {
  return new Promise((resolve) => {
    const code =
      "import json,importlib.util as u;" +
      "print(json.dumps({'fitz': u.find_spec('fitz') is not None, " +
      "'paddleocr': u.find_spec('paddleocr') is not None}))";
    const proc = spawn(python, ["-c", code], { windowsHide: true, env: PY_ENV });
    let out = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve({ fitz: false, paddleocr: false });
    }, 15000);
    proc.stdout?.on("data", (d) => {
      out += String(d);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ fitz: false, paddleocr: false });
    });
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim().split(/\r?\n/).pop() || "{}");
        resolve({ fitz: !!j.fitz, paddleocr: !!j.paddleocr });
      } catch {
        resolve({ fitz: false, paddleocr: false });
      }
    });
  });
}

export interface OcrStatus {
  python: string;
  fitz: boolean;
  paddleocr: boolean;
  gpu: boolean;
  gpuChecked: boolean;
}

export async function status(): Promise<OcrStatus> {
  const python = pythonFor();
  const [mods, hw] = await Promise.all([
    probeModules(python),
    detectHardware().catch(() => null),
  ]);
  return {
    python,
    fitz: mods.fitz,
    paddleocr: mods.paddleocr,
    gpu: !!hw?.gpu?.found,
    gpuChecked: !!hw,
  };
}

/* ------------------------- Тихая установка (тот же паттерн, что ffmpeg) ------------------------- */

export interface OcrInstallState {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  phase: string;
  error: string;
}

let installState: OcrInstallState = { state: "idle", progress: 0, phase: "", error: "" };

export async function installStatusFull(): Promise<OcrInstallState & OcrStatus> {
  return { ...installState, ...(await status()) };
}

function runPip(python: string, args: string[], onLine: (l: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      python,
      ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "--no-input", ...args],
      { windowsHide: true, env: PY_ENV },
    );
    let tail = "";
    const onData = (d: Buffer) => {
      tail += String(d);
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() || "";
      for (const l of lines) onLine(l);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => resolve(code ?? 0));
  });
}

/**
 * Ставит PyMuPDF (лёгкий, для PDF→JPG) и, если запрошено, PaddleOCR + paddle
 * (CPU или GPU-сборку — выбор пользователя, по умолчанию по detectHardware).
 */
export function install(withOcr: boolean, device: "cpu" | "gpu" | "auto" = "auto"): OcrInstallState {
  if (installState.state === "working") return installState;
  installState = { state: "working", progress: 0, phase: "pymupdf", error: "" };
  const python = pythonFor();
  void (async () => {
    try {
      let code = await runPip(python, ["pymupdf"], () => {
        installState.progress = Math.max(installState.progress, 20);
      });
      if (code !== 0) throw new Error("pip_failed: pymupdf");
      installState.progress = withOcr ? 30 : 100;

      if (withOcr) {
        let dev: "cpu" | "gpu" = device === "auto" ? "cpu" : device;
        if (device === "auto") {
          const hw = await detectHardware().catch(() => null);
          dev = hw?.gpu?.found ? "gpu" : "cpu";
        }
        installState.phase = "paddlepaddle";
        const paddlePkg = dev === "gpu" ? "paddlepaddle-gpu" : "paddlepaddle";
        code = await runPip(python, [paddlePkg], () => {
          installState.progress = Math.max(installState.progress, 60);
        });
        if (code !== 0) throw new Error(`pip_failed: ${paddlePkg}`);
        installState.progress = 75;

        installState.phase = "paddleocr";
        code = await runPip(python, ["paddleocr"], () => {
          installState.progress = Math.max(installState.progress, 90);
        });
        if (code !== 0) throw new Error("pip_failed: paddleocr");
      }

      installState = { state: "done", progress: 100, phase: "", error: "" };
      logger.info("ocr.install.done", { python, withOcr });
    } catch (e) {
      installState = { state: "error", progress: 0, phase: "", error: (e as Error).message };
      logger.error("ocr.install.error", { error: (e as Error).message });
    }
  })();
  return installState;
}

/* ------------------------- Вызов моста ------------------------- */

interface BridgeConfig {
  mode: "rasterize" | "ocr" | "rasterize_ocr";
  pdfPath?: string;
  imagePaths?: string[];
  outDir?: string;
  dpi?: number;
  device?: "cpu" | "gpu";
  lang?: string;
}

interface BridgePage {
  index: number;
  imagePath?: string;
  text?: string;
}

function runBridge(cfg: BridgeConfig, timeoutMs: number): Promise<{ pages: BridgePage[] }> {
  return new Promise((resolve, reject) => {
    const cfgPath = path.join(DIRS.tmp, `ocr-cfg-${crypto.randomBytes(6).toString("hex")}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
    const python = pythonFor();
    const proc = spawn(python, [SCRIPT, cfgPath], { windowsHide: true, env: PY_ENV });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      reject(new Error("ocr_timeout"));
    }, timeoutMs);
    proc.stdout?.on("data", (d) => {
      out += String(d);
    });
    proc.stderr?.on("data", (d) => {
      err += String(d);
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      fs.rmSync(cfgPath, { force: true });
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      fs.rmSync(cfgPath, { force: true });
      if (code !== 0) {
        reject(new Error(`ocr_bridge_failed: ${err.slice(-500) || `exit ${code}`}`));
        return;
      }
      // PyMuPDF (и другие C-расширения) иногда пишут предупреждения в stdout
      // ПЕРЕД JSON-строкой (напр. "the `fitz` API is deprecated") — ищем с
      // конца, как pyEnv.ts::probe() уже делает для python_env.py.
      for (const line of out.split(/\r?\n/).reverse()) {
        try {
          resolve(JSON.parse(line));
          return;
        } catch {
          /* строка не JSON — пробуем предыдущую */
        }
      }
      reject(new Error("ocr_bridge_bad_output"));
    });
  });
}

/** Растеризует все страницы PDF в PNG (для PDF→JPG/PNG в конвертере). */
export async function rasterizePdf(pdfPath: string, dpi = 200): Promise<string[]> {
  const outDir = path.join(ocrWorkDir(), `raster-${crypto.randomBytes(6).toString("hex")}`);
  const res = await runBridge({ mode: "rasterize", pdfPath, outDir, dpi }, 5 * 60 * 1000);
  return res.pages.map((p) => p.imagePath as string);
}

/**
 * OCR всего PDF: растеризация + распознавание за один проход моста (модель
 * PaddleOCR грузится один раз на весь документ, не на страницу).
 */
export async function ocrPdf(
  pdfPath: string,
  opts: { dpi?: number; lang?: string; device?: "cpu" | "gpu" } = {},
): Promise<{ pages: { index: number; text: string }[] }> {
  const outDir = path.join(ocrWorkDir(), `ocr-${crypto.randomBytes(6).toString("hex")}`);
  let device = opts.device;
  if (!device) {
    const hw = await detectHardware().catch(() => null);
    device = hw?.gpu?.found ? "gpu" : "cpu";
  }
  try {
    const res = await runBridge(
      {
        mode: "rasterize_ocr",
        pdfPath,
        outDir,
        dpi: opts.dpi ?? 200,
        device,
        lang: opts.lang || "ru",
      },
      // OCR на CPU может идти долго на многостраничных документах.
      30 * 60 * 1000,
    );
    return { pages: res.pages.map((p) => ({ index: p.index, text: p.text || "" })) };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

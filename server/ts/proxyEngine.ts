/**
 * Выделено из proxyCore.ts при разбиении крупного файла (поведение не менялось).
 */
import fs from "fs";
import path from "path";
import logger from "./logger";
import {
  BUNDLED_BIN,
  BUNDLED_LEGACY_BIN,
  CORE_DIR,
  ENGINE_URL,
  VENDOR_BIN,
  VENDOR_LEGACY_BIN,
  resourcesBins,
} from "./proxyCore";

// --- Жизненный цикл движка ---

/** Кандидаты пути к sing-box.exe: extraResources → пользовательский → вендор → PATH. */
function binCandidates() {
  return [
    ...resourcesBins(),
    BUNDLED_BIN,
    VENDOR_BIN,
    VENDOR_LEGACY_BIN,
    BUNDLED_LEGACY_BIN,
    "sing-box",
  ];
}

/** Первый существующий путь к движку (без проверки запуском) или null. */
function existingEnginePath() {
  for (const c of binCandidates()) {
    if (c === "sing-box") continue;
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* путь недоступен */
    }
  }
  return null;
}

let detectCache: any = null;
let detectAt = 0;

function runEngineVersion(bin: any) {
  return new Promise<any>((resolve) => {
    const { execFile } = require("child_process") as typeof import("child_process");
    execFile(
      bin,
      ["version"],
      { timeout: 8000, windowsHide: true, maxBuffer: 256 * 1024 },
      (e, o) => {
        resolve(e ? null : String(o || "").split(/[\r\n]+/)[0] || "unknown");
      },
    );
  });
}

/** Поиск рабочего движка (кэш 12 c). → { found, path, version } */
export async function detectEngine({ force = false } = {}) {
  const now = Date.now();
  if (!force && detectCache && now - detectAt < 12000) return detectCache;
  let res: { found: boolean; path: string | null; version: string | null } = {
    found: false,
    path: null,
    version: null,
  };
  for (const c of binCandidates()) {
    if (c.includes("/") || c.includes("\\")) {
      if (!fs.existsSync(c)) continue;
    }
    const v = await runEngineVersion(c);
    if (v) {
      res = { found: true, path: c, version: v };
      break;
    }
  }
  detectCache = res;
  detectAt = now;
  return res;
}

let installState: {
  state: string;
  progress: number;
  phase: string;
  error: string;
  errorDetail?: string;
} = { state: "idle", progress: 0, phase: "", error: "" };

export function installStatus() {
  // Полный список проверенных путей: если движка нет, UI показывает, где искали,
  // а не просто «не найден» (по этому списку сразу видно, чего не хватает).
  const candidates = binCandidates()
    .filter((c) => c !== "sing-box")
    .map((p) => ({ path: p, exists: fileExists(p) }));
  const found = candidates.find((c) => c.exists);
  return { ...installState, installed: !!found, path: found ? found.path : null, candidates };
}

/** existsSync без исключений (битый/недоступный путь не должен ронять статус). */
function fileExists(p: any) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Скачивание и распаковка sing-box в пользовательский каталог (storage/proxyCore). */
export async function installEngine() {
  if (installState.state === "working") return installStatus();
  // Движок уже есть (комплект инсталлятора / storage / PATH) — качать нечего.
  const already = await detectEngine({ force: true });
  if (already.found) {
    installState = { state: "done", progress: 100, phase: "bundled", error: "" };
    return installStatus();
  }
  installState = { state: "working", progress: 0, phase: "download", error: "" };
  fs.mkdirSync(CORE_DIR, { recursive: true });
  // Хвосты прошлой неудачной попытки: иначе распаковка может взять старый архив.
  try {
    fs.rmSync(path.join(CORE_DIR, "engine.zip"), { force: true });
  } catch {
    /* нет файла */
  }
  try {
    fs.rmSync(path.join(CORE_DIR, "_tmp_extract"), { recursive: true, force: true });
  } catch {
    /* нет каталога */
  }
  try {
    installState.phase = "download";
    const res = await fetch(ENGINE_URL, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") || 0);
    const zipPath = path.join(CORE_DIR, "engine.zip");
    let rcvd = 0;
    const ws = fs.createWriteStream(zipPath);
    ws.on("error", () => {});
    for await (const chunk of res.body as any) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rcvd += buf.length;
      installState.progress = declared ? Math.min(100, Math.round((100 * rcvd) / declared)) : 0;
      if (!ws.write(buf)) await new Promise<void>((r) => ws.once("drain", r));
    }
    await new Promise<void>((resolve, reject) =>
      ws.end((err: any) => (err ? reject(err) : resolve())),
    );

    installState.phase = "extract";
    installState.progress = 0;
    const AdmZip = require("adm-zip") as typeof import("adm-zip");
    const zip = new AdmZip(zipPath);
    const tmpDir = path.join(CORE_DIR, "_tmp_extract");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    zip.extractAllTo(tmpDir, true);
    const findExe = (dir: any) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (findExe(p)) return true;
        } else if (e.name.toLowerCase() === "sing-box.exe") {
          fs.copyFileSync(p, BUNDLED_BIN);
          return true;
        }
      }
      return false;
    };
    if (!findExe(tmpDir)) throw new Error("sing-box.exe not found after extraction");
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    detectCache = null;
    installState = { state: "done", progress: 100, phase: "", error: "" };
    logger.info("proxyCore.install.done", { path: BUNDLED_BIN });
  } catch (e: any) {
    // GitHub может быть недоступен (блокировка, нет сети) — если движок уже есть
    // в комплекте, честнее им и воспользоваться, чем показывать ошибку.
    const fallback = existingEnginePath();
    if (fallback) {
      detectCache = null;
      installState = { state: "done", progress: 100, phase: "bundled", error: "" };
      logger.warn("proxyCore.install.fallback", { path: fallback, error: e.message });
    } else {
      // Код вместо сырого текста — UI переводит его (proxy.installFailed).
      installState = {
        state: "error",
        progress: 0,
        phase: "",
        error: "download_failed",
        errorDetail: e.message,
      };
      logger.error("proxyCore.install.error", { error: e.message });
    }
  }
  return installStatus();
}

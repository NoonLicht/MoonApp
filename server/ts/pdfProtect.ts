/**
 * Защита PDF паролем / снятие пароля — через qpdf (тот же принцип, что
 * LibreOffice/ffmpeg: реальный локальный движок, а не заглушка). pdf-lib
 * сознательно не покрывает шифрование PDF — это не пробел в реализации, а
 * ограничение самой библиотеки (нет write-поддержки /Encrypt).
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import config from "./config";
import logger from "./logger";
import settings from "./settings";

const { DIRS } = config;

function qpdfCandidates(): string[] {
  const cfg = (settings.get("converter") || {}) as { qpdfPath?: string };
  const explicit = String(cfg.qpdfPath || "").trim();
  const list: string[] = [];
  if (explicit) list.push(explicit);
  if (process.platform === "win32") {
    list.push(
      "C:\\Program Files\\qpdf\\bin\\qpdf.exe",
      "C:\\Program Files (x86)\\qpdf\\bin\\qpdf.exe",
      path.join(os.homedir(), "scoop", "shims", "qpdf.exe"),
    );
  } else {
    list.push("/usr/bin/qpdf", "/usr/local/bin/qpdf");
  }
  list.push("qpdf");
  return list;
}

let detectCache: string | null | undefined;
let detectAt = 0;

function runVersion(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, ["--version"], { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

export interface QpdfInfo {
  found: boolean;
  path: string | null;
}

export async function detectQpdf({ force = false }: { force?: boolean } = {}): Promise<QpdfInfo> {
  const now = Date.now();
  if (!force && detectCache !== undefined && now - detectAt < 12000)
    return { found: !!detectCache, path: detectCache ?? null };
  for (const cmd of qpdfCandidates()) {
    if (cmd.includes("/") || cmd.includes("\\")) {
      if (!fs.existsSync(cmd)) continue;
    }
    if (await runVersion(cmd)) {
      detectCache = cmd;
      detectAt = now;
      return { found: true, path: cmd };
    }
  }
  detectCache = null;
  detectAt = now;
  return { found: false, path: null };
}

export function qpdfSearchPaths(): string[] {
  return qpdfCandidates();
}

function runQpdf(qpdf: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(qpdf, args, { timeout: 2 * 60 * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _o, stderr) => {
      // qpdf возвращает 2 на "warnings" (напр. чуть повреждённый, но читаемый
      // PDF) — это не провал операции, файл на выходе валиден.
      if (err && (err as NodeJS.ErrnoException & { code?: number }).code !== 2) {
        return reject(new Error(`qpdf_failed: ${String(stderr || err.message).slice(0, 400)}`));
      }
      resolve();
    });
  });
}

async function withTempFiles<T>(buf: Buffer, fn: (inPath: string, outPath: string) => Promise<T>): Promise<T> {
  const id = crypto.randomBytes(6).toString("hex");
  const dir = path.join(DIRS.tmp, `qpdf-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const inPath = path.join(dir, "in.pdf");
  const outPath = path.join(dir, "out.pdf");
  fs.writeFileSync(inPath, buf);
  try {
    return await fn(inPath, outPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Ставит пароль открытия (user) — 256-битный AES, как в современных PDF. */
export async function protectPdf(buf: Buffer, password: string): Promise<Buffer> {
  const qpdf = await detectQpdf();
  if (!qpdf.found || !qpdf.path) throw new Error("qpdf_missing");
  const pw = String(password || "");
  if (!pw) throw new Error("missing_password");
  return withTempFiles(buf, async (inPath, outPath) => {
    await runQpdf(qpdf.path as string, [
      "--encrypt",
      pw,
      pw,
      "256",
      "--",
      inPath,
      outPath,
    ]);
    const out = fs.readFileSync(outPath);
    logger.info("pdf.protect", { size: out.length });
    return out;
  });
}

/** Снимает пароль (требует знать сам пароль — это открытие, не взлом). */
export async function unlockPdf(buf: Buffer, password: string): Promise<Buffer> {
  const qpdf = await detectQpdf();
  if (!qpdf.found || !qpdf.path) throw new Error("qpdf_missing");
  return withTempFiles(buf, async (inPath, outPath) => {
    await runQpdf(qpdf.path as string, [
      `--password=${String(password || "")}`,
      "--decrypt",
      inPath,
      outPath,
    ]);
    const out = fs.readFileSync(outPath);
    logger.info("pdf.unlock", { size: out.length });
    return out;
  });
}

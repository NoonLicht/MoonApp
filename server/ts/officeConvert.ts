/**
 * Word/PowerPoint/Excel ⇄ PDF через LibreOffice headless (`soffice --headless
 * --convert-to`) — тот же принцип, что у ffmpeg/git в этом приложении: движок
 * ищется локально (PATH + стандартные каталоги установки), ничего не
 * подделывается заглушкой. LibreOffice не тянем автоматически (инсталлятор
 * ~300 МБ, тихая установка под Windows не так надёжна, как zip-архив ffmpeg) —
 * если не найден, отдаём понятную ошибку с путём, куда его поставить (как
 * "FFmpeg не найден" в конвертере).
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

/** office-формат → аргумент --convert-to LibreOffice. */
const EXT_TO_FILTER: Record<string, string> = {
  pdf: "pdf",
  docx: "docx",
  doc: "doc",
  pptx: "pptx",
  ppt: "ppt",
  xlsx: "xlsx",
  xls: "xls",
  odt: "odt",
  odp: "odp",
  ods: "ods",
};

function sofficeCandidates(): string[] {
  const cfg = (settings.get("converter") || {}) as { officePath?: string };
  const explicit = String(cfg.officePath || "").trim();
  const list: string[] = [];
  if (explicit) list.push(explicit);
  if (process.platform === "win32") {
    list.push(
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
      path.join(os.homedir(), "AppData", "Local", "Programs", "LibreOffice", "program", "soffice.exe"),
    );
  } else {
    list.push("/usr/bin/soffice", "/usr/bin/libreoffice", "/opt/libreoffice/program/soffice");
  }
  list.push("soffice");
  return list;
}

let detectCache: { path: string | null; version: string | null } | null = null;
let detectAt = 0;

function runVersion(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, ["--version"], { timeout: 10000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout || "").trim().split(/\r?\n/)[0] || "unknown");
      });
    } catch {
      resolve(null);
    }
  });
}

export interface OfficeInfo {
  found: boolean;
  path: string | null;
  version: string | null;
}

/** Ищет soffice: явный путь из настроек → стандартные каталоги → PATH. Кэш 12с. */
export async function detectOffice({ force = false }: { force?: boolean } = {}): Promise<OfficeInfo> {
  const now = Date.now();
  if (!force && detectCache && now - detectAt < 12000)
    return { found: !!detectCache.path, path: detectCache.path, version: detectCache.version };
  for (const cmd of sofficeCandidates()) {
    if (cmd.includes("/") || cmd.includes("\\")) {
      if (!fs.existsSync(cmd)) continue;
    }
    const version = await runVersion(cmd);
    if (version) {
      detectCache = { path: cmd, version };
      detectAt = now;
      return { found: true, path: cmd, version };
    }
  }
  detectCache = { path: null, version: null };
  detectAt = now;
  return { found: false, path: null, version: null };
}

export function officeSearchPaths(): string[] {
  return sofficeCandidates();
}

/**
 * Конвертирует один файл через LibreOffice headless в изолированный профиль
 * (-env:UserInstallation) — иначе параллельные конвертации толкаются за один
 * профиль soffice и падают со "soffice already running".
 */
export async function convertOffice(
  buf: Buffer,
  origName: string,
  toExt: string,
): Promise<{ buf: Buffer; name: string }> {
  const target = String(toExt || "").toLowerCase().replace(/^\./, "");
  const filter = EXT_TO_FILTER[target];
  if (!filter) throw new Error(`unsupported_target: ${target}`);

  const office = await detectOffice();
  if (!office.found || !office.path) throw new Error("office_engine_missing");

  const jobId = crypto.randomBytes(6).toString("hex");
  const workDir = path.join(DIRS.tmp, `office-${jobId}`);
  const profileDir = path.join(workDir, "profile");
  fs.mkdirSync(profileDir, { recursive: true });

  const srcExt = path.extname(origName) || ".bin";
  const srcPath = path.join(workDir, `input${srcExt}`);
  fs.writeFileSync(srcPath, buf);

  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        `-env:UserInstallation=file:///${profileDir.replace(/\\/g, "/")}`,
        "--headless",
        "--norestore",
        "--convert-to",
        filter,
        "--outdir",
        workDir,
        srcPath,
      ];
      execFile(
        office.path as string,
        args,
        { timeout: 5 * 60 * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) return reject(new Error(`soffice_failed: ${String(stderr || err.message).slice(0, 500)}`));
          resolve();
        },
      );
    });

    const outName = `input.${filter}`;
    const outPath = path.join(workDir, outName);
    if (!fs.existsSync(outPath)) throw new Error("office_no_output");
    const outBuf = fs.readFileSync(outPath);
    const baseName = path.basename(origName, srcExt);
    logger.info("office.convert", { from: srcExt, to: filter, size: outBuf.length });
    return { buf: outBuf, name: `${baseName}.${filter}` };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Word/PowerPoint/Excel ⇄ PDF — ДВА возможных движка:
 *  1) уже установленный MS Office (COM-автоматизация через PowerShell,
 *     New-Object -ComObject Word.Application/Excel.Application/PowerPoint.Application)
 *     — если у пользователя и так стоит Office, ничего докачивать не нужно;
 *  2) LibreOffice headless (`soffice --headless --convert-to`) — если MS
 *     Office не найден. LibreOffice не тянем автоматически (инсталлятор
 *     ~300 МБ, тихая установка под Windows не так надёжна, как zip-архив
 *     ffmpeg) — на странице конвертера вместо этого кнопка «Установить»
 *     через встроенный winget (см. server/ts/winget.ts, id LibreOffice.LibreOffice),
 *     как в «Магазине приложений».
 * Движки ищутся локально, ничего не подделывается заглушкой.
 */
import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import config from "./config";
import logger from "./logger";
import settings from "./settings";

const { DIRS } = config;

/** COM ProgID → расширения, которые этот компонент Office умеет открывать. */
const MSOFFICE_APPS = {
  word: { progId: "Word.Application", exts: ["doc", "docx", "rtf", "odt"] },
  excel: { progId: "Excel.Application", exts: ["xls", "xlsx", "csv", "ods"] },
  powerpoint: { progId: "PowerPoint.Application", exts: ["ppt", "pptx", "odp"] },
};

let msDetectCache: Record<string, boolean> | null = null;
let msDetectAt = 0;

/** Пробует создать и сразу закрыть COM-объект — это и есть проверка, что
 *  соответствующий компонент Office установлен и зарегистрирован. */
function probeComObject(progId: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(false);
    const script = `
try {
  $o = New-Object -ComObject ${progId}
  $o.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($o) | Out-Null
  Write-Output "OK"
} catch {
  Write-Output "FAIL"
}
`;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => resolve(!err && /OK/.test(String(stdout || ""))),
    );
  });
}

/** Кэш на 30с — сама проверка не бесплатна (реально дёргает COM). */
export async function detectMsOffice({
  force = false,
}: { force?: boolean } = {}): Promise<{ word: boolean; excel: boolean; powerpoint: boolean; any: boolean }> {
  const now = Date.now();
  if (!force && msDetectCache && now - msDetectAt < 30000) {
    const c = msDetectCache;
    return { word: c.word, excel: c.excel, powerpoint: c.powerpoint, any: c.word || c.excel || c.powerpoint };
  }
  const [word, excel, powerpoint] = await Promise.all([
    probeComObject(MSOFFICE_APPS.word.progId),
    probeComObject(MSOFFICE_APPS.excel.progId),
    probeComObject(MSOFFICE_APPS.powerpoint.progId),
  ]);
  msDetectCache = { word, excel, powerpoint };
  msDetectAt = now;
  return { word, excel, powerpoint, any: word || excel || powerpoint };
}

/** Какой компонент Office открывает данное расширение (null — ни один). */
function msOfficeAppFor(ext: string): keyof typeof MSOFFICE_APPS | null {
  for (const [app, info] of Object.entries(MSOFFICE_APPS)) {
    if (info.exts.includes(ext)) return app as keyof typeof MSOFFICE_APPS;
  }
  return null;
}

/**
 * Конвертация в PDF через COM-автоматизацию установленного MS Office.
 * ТОЛЬКО в PDF — обратное (PDF → docx/xlsx/pptx) через Office автоматизацию
 * не поддерживается надёжно, для этого направления используется LibreOffice.
 *
 * PowerPoint не умеет полностью скрытую автоматизацию (Visible=false у него
 * ненадёжен на части версий) — окно презентации может на мгновение мелькнуть,
 * это ограничение самого PowerPoint, не костыль этого кода.
 */
async function convertViaMsOffice(
  srcPath: string,
  outPath: string,
  app: keyof typeof MSOFFICE_APPS,
): Promise<void> {
  const src = srcPath.replace(/'/g, "''");
  const out = outPath.replace(/'/g, "''");
  const scripts: Record<keyof typeof MSOFFICE_APPS, string> = {
    word: `
$w = New-Object -ComObject Word.Application
$w.Visible = $false
try {
  $doc = $w.Documents.Open('${src}', $false, $true)
  $doc.SaveAs([ref]'${out}', [ref] 17)
  $doc.Close([ref] $false)
} finally {
  $w.Quit()
}
`,
    excel: `
$x = New-Object -ComObject Excel.Application
$x.Visible = $false
$x.DisplayAlerts = $false
try {
  $wb = $x.Workbooks.Open('${src}')
  $wb.ExportAsFixedFormat(0, '${out}')
  $wb.Close($false)
} finally {
  $x.Quit()
}
`,
    powerpoint: `
$p = New-Object -ComObject PowerPoint.Application
try {
  $pres = $p.Presentations.Open('${src}', $true, $false, $false)
  $pres.SaveAs('${out}', 32)
  $pres.Close()
} finally {
  $p.Quit()
}
`,
  };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", scripts[app]],
      { windowsHide: true },
    );
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const killer = setTimeout(() => {
      child.kill();
      reject(new Error("msoffice_timeout"));
    }, 90000);
    child.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new Error(`msoffice_failed: ${stderr.slice(-500)}`));
    });
  });
  if (!fs.existsSync(outPath)) throw new Error("msoffice_no_output");
}

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

/** Общий статус обоих движков — страница конвертера решает, что показать
 *  (кнопку "Установить LibreOffice" или просто работающий конвертер). */
export async function officeEngineStatus(): Promise<{
  libre: OfficeInfo;
  msoffice: { word: boolean; excel: boolean; powerpoint: boolean; any: boolean };
  found: boolean;
}> {
  const [libre, msoffice] = await Promise.all([detectOffice(), detectMsOffice()]);
  return { libre, msoffice, found: libre.found || msoffice.any };
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
): Promise<{ buf: Buffer; name: string; engine: "msoffice" | "libreoffice" }> {
  const target = String(toExt || "").toLowerCase().replace(/^\./, "");
  const filter = EXT_TO_FILTER[target];
  if (!filter) throw new Error(`unsupported_target: ${target}`);

  const srcExt = (path.extname(origName) || "").replace(/^\./, "").toLowerCase();
  const jobId = crypto.randomBytes(6).toString("hex");
  const workDir = path.join(DIRS.tmp, `office-${jobId}`);
  fs.mkdirSync(workDir, { recursive: true });
  const srcPath = path.join(workDir, `input.${srcExt || "bin"}`);
  fs.writeFileSync(srcPath, buf);
  const baseName = path.basename(origName, path.extname(origName));

  try {
    // MS Office (COМ) — только для конвертации В pdf, и только если у
    // пользователя уже есть нужный компонент (Word/Excel/PowerPoint).
    // Обратное направление (pdf → docx/xlsx/pptx) и остальные пары форматов
    // всегда идут через LibreOffice — если не найден ни один движок, вот тут
    // и всплывает понятная ошибка с указанием, чего не хватает.
    if (filter === "pdf") {
      const app = msOfficeAppFor(srcExt);
      if (app) {
        const ms = await detectMsOffice();
        if (ms[app]) {
          const outPath = path.join(workDir, "input.pdf");
          await convertViaMsOffice(srcPath, outPath, app);
          const outBuf = fs.readFileSync(outPath);
          logger.info("office.convert", { from: srcExt, to: filter, size: outBuf.length, engine: "msoffice" });
          return { buf: outBuf, name: `${baseName}.pdf`, engine: "msoffice" };
        }
      }
    }

    const office = await detectOffice();
    // Сюда попадаем и когда MS Office вовсе не установлен, и когда установлен,
    // но не для этой пары форматов (например, обратное pdf → docx) — в обоих
    // случаях без LibreOffice конвертация невозможна.
    if (!office.found || !office.path) throw new Error("office_engine_missing");

    const profileDir = path.join(workDir, "profile");
    fs.mkdirSync(profileDir, { recursive: true });
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

    const outPath = path.join(workDir, `input.${filter}`);
    if (!fs.existsSync(outPath)) throw new Error("office_no_output");
    const outBuf = fs.readFileSync(outPath);
    logger.info("office.convert", { from: srcExt, to: filter, size: outBuf.length, engine: "libreoffice" });
    return { buf: outBuf, name: `${baseName}.${filter}`, engine: "libreoffice" };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

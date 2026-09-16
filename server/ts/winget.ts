/**
 * winget: поиск пакетов, установка, скачивание установщика без установки и
 * фоновый индексатор полного каталога (по буквам/цифрам).
 *
 * Тонкости, ради которых модуль существует отдельно: winget отдаёт Unicode
 * (UTF-8 либо UTF-16LE — определяем по BOM и NUL-байтам), таблицу печатает
 * «широкими» пробелами, а полного листинга не отдаёт вовсе — поэтому каталог
 * собирается запросами и кэшируется в storage/winget_index.json.
 *
 * TS-исходник, как server/ts/downloads.ts: компилируется в server/winget.js
 * командой `npm run compile:server`, поэтому `require("./winget")` из обычных
 * .js-модулей продолжает работать без изменений.
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import config from "./config";
import { resolveDestDir } from "./downloads";
import logger from "./logger";

const { DIRS } = config;

const INDEX_FILE = path.join(DIRS.storage, "winget_index.json");
const MAX_INDEX = 4000; // столько записей держится в каталоге, чтобы UI не тормозил

/** Строка каталога winget (совпадает с колонками его таблицы). */
export interface WingetRow {
  name: string;
  id: string;
  version: string;
  source: string;
}

/** Запись стартового (курируемого) списка: та же строка + категория для UI. */
export interface WingetSeedRow extends WingetRow {
  category: string;
}

/** Состояние фонового индексатора каталога. */
export interface WingetIndexState {
  state: "none" | "indexing" | "ready";
  done: number;
  total: number;
  current: string;
}

function runWinget(args: string[]): Promise<{ stdout: Buffer; code: number }> {
  return new Promise((resolve) => {
    execFile(
      "winget",
      args,
      { maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => {
        // err.code бывает и строкой (ENOENT), и числом — приводим к числу,
        // сохраняя прежнее поведение: код ошибки или 1.
        resolve({ stdout: stdout || Buffer.alloc(0), code: err ? (err.code as number) || 1 : 0 });
      },
    );
  });
}

/** winget отдаёт Unicode — декодируется аккуратно (UTF-8 / UTF-16LE). */
function decode(buf: Buffer | Uint8Array | string): string {
  const b = Buffer.from(buf);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.toString("utf16le");
  if (b.length > 0 && b.includes(0)) return b.toString("utf16le");
  return b.toString("utf8");
}

/**
 * Парсинг таблицы winget. Колонки: Name | Id | Version | (Match) | Source.
 * Упор на надёжность: поиск идёт по токену-ИД (в нём есть точка), имя = текст до него,
 * версия = следующий токен, источник = последний. Переносы и «Совпадение» игнорируются.
 */
export function parseTable(out: Buffer | Uint8Array | string): WingetRow[] {
  const text = decode(out);
  const rows: WingetRow[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const toks = raw
      .replace(/\u0000/g, "")
      .split(/\s{2,}/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (toks.length < 4) continue;
    const idIdx = toks.findIndex((t) => t.includes(".") && !/^\d/.test(t));
    if (idIdx < 1 || idIdx > toks.length - 3) continue;
    const id = toks[idIdx];
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      name: toks.slice(0, idIdx).join(" "),
      id,
      version: toks[idIdx + 1],
      source: toks[toks.length - 1],
    });
  }
  return rows;
}

/** Живой поиск по winget. */
export async function search(query: string): Promise<WingetRow[]> {
  const { stdout } = await runWinget([
    "search",
    query,
    "--accept-source-agreements",
    "--disable-interactivity",
  ]);
  return parseTable(stdout);
}

/**
 * Курируемый seed популярных пакетов winget.
 * Проблема: полный листинг winget CLI не отдаёт (нужен запрос), поэтому
 * стартовый список — популярные приложения; поиск расширяет его.
 */
const SEED: [string, string, string][] = [
  ["Google Chrome", "Google.Chrome", "Browser"],
  ["Mozilla Firefox", "Mozilla.Firefox", "Browser"],
  ["Opera", "Opera.Opera", "Browser"],
  ["Brave", "Brave.Brave", "Browser"],
  ["Vivaldi", "Vivaldi.Vivaldi", "Browser"],
  ["Tor Browser", "TorProject.TorBrowser", "Browser"],
  ["Visual Studio Code", "Microsoft.VisualStudioCode", "Dev Tools"],
  ["Git", "Git.Git", "Dev Tools"],
  ["Node.js LTS", "OpenJS.NodeJS.LTS", "Dev Tools"],
  ["Python 3.12", "Python.Python.3.12", "Dev Tools"],
  ["Docker Desktop", "Docker.DockerDesktop", "Dev Tools"],
  ["GitHub Desktop", "GitHub.GitHubDesktop", "Dev Tools"],
  ["Notepad++", "Notepad++.NotepadPlusPlus", "Dev Tools"],
  ["Windows Terminal", "Microsoft.WindowsTerminal", "Dev Tools"],
  ["PowerShell 7", "Microsoft.PowerShell", "Dev Tools"],
  ["VLC", "VideoLAN.VLC", "Media"],
  ["OBS Studio", "OBSProject.OBSStudio", "Media"],
  ["Audacity", "Audacity.Audacity", "Media"],
  ["GIMP", "GIMP.GIMP", "Media"],
  ["Kdenlive", "KDE.Kdenlive", "Media"],
  ["Spotify", "Spotify.Spotify", "Media"],
  ["Discord", "Discord.Discord", "Comms"],
  ["Telegram", "Telegram.TelegramDesktop", "Comms"],
  ["WhatsApp", "WhatsApp.WhatsApp", "Comms"],
  ["Signal", "Signal.Signal", "Comms"],
  ["Slack", "Slack.Slack", "Comms"],
  ["Zoom", "Zoom.Zoom", "Comms"],
  ["7-Zip", "7zip.7zip", "Utilities"],
  ["WinRAR", "RARLab.WinRAR", "Utilities"],
  ["PowerToys", "Microsoft.PowerToys", "Utilities"],
  ["Everything", "voidtools.Everything", "Utilities"],
  ["KeePassXC", "KeePassXCTeam.KeePassXC", "Security"],
  ["Rufus", "Rufus.Rufus", "Utilities"],
  ["qBittorrent", "qBittorrent.qBittorrent", "Media"],
  ["LibreOffice", "LibreOffice.LibreOffice", "Office"],
  ["OnlyOffice", "ONLYOFFICE.DesktopEditors", "Office"],
  ["SumatraPDF", "SumatraPDF.SumatraPDF", "Office"],
  ["Foxit Reader", "Foxit.FoxitReader", "Office"],
  ["Steam", "Valve.Steam", "Other"],
  ["Epic Games Launcher", "EpicGames.EpicGamesLauncher", "Other"],
  ["GOG Galaxy", "GOG.Galaxy", "Other"],
  ["Thunderbird", "Mozilla.Thunderbird", "Comms"],
  ["Malwarebytes", "Malwarebytes.Malwarebytes", "Security"],
  ["Wireshark", "WiresharkFoundation.Wireshark", "Dev Tools"],
  ["Postman", "Postman.Postman", "Dev Tools"],
  ["JetBrains Toolbox", "JetBrains.Toolbox", "Dev Tools"],
  ["OpenVPN", "OpenVPNTechnologies.OpenVPN", "Security"],
  ["Ventoy", "Ventoy.Ventoy", "Utilities"],
  ["PeaZip", "PeaZip.PeaZip", "Utilities"],
  ["Krita", "KDE.Krita", "Media"],
];

/** Стартовый список каталога: seed + пустые version/source как у живого поиска. */
export function seed(): WingetSeedRow[] {
  return SEED.map(([name, id, category]) => ({
    name,
    id,
    version: "",
    source: "winget",
    category,
  }));
}

/** Пакет ставится через winget (тихо). */
export async function install(id: string): Promise<{ ok: boolean; id: string; tail: string }> {
  const { stdout, code } = await runWinget([
    "install",
    id,
    "--silent",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--disable-interactivity",
  ]);
  logger.action("winget.install", { id, code });
  return { ok: code === 0, id, tail: decode(stdout).slice(-2000) };
}

function listDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Результат скачивания установщика: файл может не определиться (file = null). */
export interface WingetDownloadResult {
  ok: boolean;
  id: string;
  file: string | null;
  dir: string;
  tail: string;
}

/**
 * Установщик пакета скачивается в каталог загрузок БЕЗ установки.
 * `winget download` доступен с winget 1.6 (Win 10 22H2+/Win 11 обычно есть).
 */
export async function downloadPackage(id: string): Promise<WingetDownloadResult> {
  const destDir = resolveDestDir();
  fs.mkdirSync(destDir, { recursive: true });
  const before = new Set(listDirSafe(destDir));
  const { stdout, code } = await runWinget([
    "download",
    "--id",
    id,
    "--download-directory",
    destDir,
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--disable-interactivity",
  ]);
  const tail = decode(stdout).slice(-2000);
  // Свежих файлов может быть несколько (манифест .yaml + установщик) —
  // выбираем только установочные расширения.
  const exts = [".exe", ".msi", ".msix", ".appx", ".zip"];
  const fresh = listDirSafe(destDir).filter(
    (f) => !before.has(f) && exts.includes(path.extname(f).toLowerCase()),
  );
  const file = fresh.length ? path.join(destDir, fresh[fresh.length - 1]) : null;
  logger.action("winget.download", { id, code, files: fresh.length });
  return { ok: code === 0, id, file, dir: destDir, tail };
}

/* ------------------------------------------------------------------ */
//  Полный каталог: фоновый индексатор по буквам/цифрам с кэшем
/* ------------------------------------------------------------------ */

let indexState: WingetIndexState = { state: "none", done: 0, total: 0, current: "" };
let indexRun: Promise<WingetIndexState> | null = null;

/** Статус индексатора + размер уже собранного кэша. */
export function indexStatus(): WingetIndexState & { cached: number } {
  return { ...indexState, cached: readIndex()?.length || 0 };
}

/** Кэш каталога (null, если файла нет или он битый). */
export function readIndex(): WingetRow[] | null {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** Запускается фоновая индексация (повторный вызов не дублирует). */
export function startIndexing(): Promise<WingetIndexState> {
  if (indexRun) return indexRun;
  const queries: string[] = [];
  for (let i = 0; i < 26; i++) queries.push(String.fromCharCode(97 + i)); // a-z
  for (let i = 0; i < 10; i++) queries.push(String(i)); // 0-9

  indexState = { state: "indexing", done: 0, total: queries.length, current: "" };
  const seen = new Set<string>();
  const all: WingetRow[] = [];

  indexRun = (async () => {
    for (const q of queries) {
      indexState.current = q;
      try {
        const rows = await search(q);
        for (const r of rows) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            all.push(r);
            if (all.length >= MAX_INDEX) break;
          }
        }
      } catch {
        /* запрос упал — буква пропускается */
      }
      indexState.done++;
      fs.writeFileSync(INDEX_FILE, JSON.stringify(all), "utf8"); // инкрементальный кэш
      if (all.length >= MAX_INDEX) break;
    }
    indexState.state = "ready";
    indexState.current = "";
    logger.info("winget.index_done", { count: all.length });
    return indexState;
  })();

  return indexRun;
}

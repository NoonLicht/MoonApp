/**
 * Выделено из zapret.ts при разбиении крупного файла (поведение не менялось).
 */
import fs from "fs";
import path from "path";
import { downloadToFile } from "./download";
import logger from "./logger";
import { DIRS, engineStatus, findEngineDir, installDir, probeEngineDir, stop } from "./zapret";
import { USER_LISTS } from "./zapretLists";
import { ensureUserLists, gameFilterFile, writeGameFilter } from "./zapretStrategies";

/* ------------------------- Загрузка/обновление с GitHub ------------------------- */

/**
 * Движок берём напрямую из релизов Flowseal/zapret-discord-youtube
 * (ассет *.zip распаковываем adm-zip'ом). Пользовательские списки
 * (lists/*-user.txt) и флаг GameFilter при обновлении сохраняются.
 */
export const GITHUB_REPO = "Flowseal/zapret-discord-youtube";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;
const GITHUB_DL = `https://github.com/${GITHUB_REPO}/releases/download`;
const GH_HEADERS = { "User-Agent": "MoonApp", Accept: "application/vnd.github+json" };
const VERSION_FILE = ".pa-bypass.json";

let installState = { state: "idle", progress: 0, phase: "", error: "", tag: null, at: 0 };
let releaseCache: any = null;

/** Установленная версия: .pa-bypass.json → LOCAL_VERSION в service.bat. */
export function localVersion() {
  const dir = findEngineDir();
  if (!dir) return { tag: null, installedAt: null, dir: null };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, VERSION_FILE), "utf8"));
    if (j && j.tag) return { tag: String(j.tag), installedAt: j.installedAt || null, dir };
  } catch {
    /* нет файла — смотрим service.bat */
  }
  try {
    const m = /set\s+"LOCAL_VERSION=([^"]+)"/i.exec(
      fs.readFileSync(path.join(dir, "service.bat"), "utf8"),
    );
    if (m) return { tag: m[1].trim(), installedAt: null, dir };
  } catch {
    /* ignore */
  }
  return { tag: null, installedAt: null, dir };
}

/** Последний релиз на GitHub (кэш 10 минут). */
async function fetchLatestRelease(force = false) {
  if (!force && releaseCache && Date.now() - releaseCache.at < 10 * 60 * 1000) return releaseCache;
  const res = await fetch(`${GITHUB_API}/releases/latest`, {
    headers: GH_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`github_http_${res.status}`);
  const data = await res.json();
  const zip = (data.assets || []).find((a: any) => /\.zip$/i.test(a.name || ""));
  if (!zip) throw new Error("no_zip_asset");
  releaseCache = {
    tag: data.tag_name,
    name: data.name || data.tag_name,
    publishedAt: data.published_at,
    notes: String(data.body || "").slice(0, 2000),
    zipName: zip.name,
    zipUrl: zip.browser_download_url,
    sizeBytes: zip.size || 0,
    htmlUrl: data.html_url,
    at: Date.now(),
  };
  return releaseCache;
}

/** Проверка обновлений: что установлено vs что в последнем релизе. */
export async function checkUpdate() {
  const local = localVersion();
  const out = {
    engine: engineStatus(),
    installed: local.tag,
    installedAt: local.installedAt,
    latest: null,
    hasUpdate: false,
    downloadUrl: null,
    assetName: null,
    sizeBytes: 0,
    publishedAt: null,
    htmlUrl: `https://github.com/${GITHUB_REPO}/releases`,
    notes: "",
    error: "",
    repo: GITHUB_REPO,
  };
  try {
    const rel = await fetchLatestRelease();
    out.latest = rel.tag;
    out.downloadUrl = rel.zipUrl;
    out.assetName = rel.zipName;
    out.sizeBytes = rel.sizeBytes;
    out.publishedAt = rel.publishedAt;
    out.notes = rel.notes;
    out.htmlUrl = rel.htmlUrl;
    out.hasUpdate = !local.tag || local.tag !== rel.tag;
  } catch (e: any) {
    out.error = String(e.message || e);
  }
  return out;
}

/** Прогресс установки/обновления для UI-поллинга. */
export function installStatus() {
  return { ...installState, engine: engineStatus(), installed: localVersion().tag };
}

/** Рекурсивное копирование каталога (без зависимостей). */
function copyDir(src: any, dst: any) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else {
      try {
        fs.copyFileSync(from, to);
      } catch {
        /* занятый файл пропускаем */
      }
    }
  }
}

/**
 * Скачать и установить/обновить движок с GitHub (асинхронно, с прогрессом).
 * Пользовательские списки и флаг GameFilter сохраняются.
 * @param {{ tag?: string, force?: boolean }} opts
 */
export function installEngine(opts: Record<string, any> = {}) {
  if (installState.state === "working") return installState;
  installState = {
    state: "working",
    progress: 0,
    phase: "resolve",
    error: "",
    tag: opts.tag || null,
    at: Date.now(),
  };
  const target = installDir();
  const tmpRoot = path.join(DIRS.tmp, `zapret_dl_${Date.now()}`);
  (async () => {
    try {
      // 1. Останавливаем движок: файлы релиза иначе залочены.
      //    killForeign=false — чужую копию zapret не трогаем (она в другой папке).
      installState.phase = "stop";
      try {
        await stop({ killForeign: false });
      } catch {
        /* не запущен */
      }

      // 2. Определяем релиз (или конкретный тег).
      installState.phase = "resolve";
      const rel = opts.tag
        ? {
            tag: opts.tag,
            zipName: `zapret-discord-youtube-${opts.tag}.zip`,
            zipUrl: `${GITHUB_DL}/${opts.tag}/zapret-discord-youtube-${opts.tag}.zip`,
          }
        : await fetchLatestRelease(true);
      installState.tag = rel.tag;

      // 3. Скачиваем zip с прогрессом (общий потоковый загрузчик).
      installState.phase = "download";
      fs.mkdirSync(tmpRoot, { recursive: true });
      const zipPath = path.join(tmpRoot, rel.zipName || "release.zip");
      await downloadToFile(rel.zipUrl, zipPath, {
        userAgent: "Mozilla/5.0",
        timeoutMs: 300000,
        onProgress: ({ total, received }) => {
          installState.progress = total ? Math.min(100, Math.round((100 * received) / total)) : 0;
        },
      });

      // 4. Распаковка (релиз лежит во вложенной папке zapret-discord-youtube-<ver>/).
      installState.phase = "extract";
      installState.progress = 0;
      const AdmZip = require("adm-zip") as typeof import("adm-zip");
      const raw = path.join(tmpRoot, "raw");
      new AdmZip(zipPath).extractAllTo(raw, true);
      const payload = probeEngineDir(raw) || raw;

      // 5. Сохраняем пользовательское: списки + флаг GameFilter.
      const keep: Record<string, any> = {};
      const oldEngine = findEngineDir();
      if (oldEngine) {
        for (const name of USER_LISTS) {
          try {
            const p = path.join(oldEngine, "lists", name);
            if (fs.existsSync(p)) keep[name] = fs.readFileSync(p, "utf8");
          } catch {
            /* ignore */
          }
        }
        try {
          const gf = gameFilterFile(oldEngine);
          if (fs.existsSync(gf)) keep.__gameFilter = fs.readFileSync(gf, "utf8");
        } catch {
          /* ignore */
        }
      }

      // 6. Заменяем каталог установки.
      installState.phase = "install";
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* частично занят */
      }
      fs.mkdirSync(target, { recursive: true });
      copyDir(payload, target);

      // 7. Возвращаем пользовательское + метка версии.
      for (const [name, content] of Object.entries(keep)) {
        if (name === "__gameFilter") continue;
        const p = path.join(target, "lists", name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
      }
      if (keep.__gameFilter) {
        const p = gameFilterFile(target);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, keep.__gameFilter, "utf8");
      } else {
        writeGameFilter();
      }
      // Пользовательские списки движка: их ждут конфиги general*.bat
      // (без них winws не стартует — "cannot access ipset file ...").
      try {
        ensureUserLists();
      } catch {
        /* ignore */
      }
      fs.writeFileSync(
        path.join(target, VERSION_FILE),
        JSON.stringify(
          {
            tag: rel.tag,
            installedAt: new Date().toISOString(),
            source: GITHUB_REPO,
            asset: rel.zipName || "",
          },
          null,
          2,
        ),
        "utf8",
      );

      installState = {
        state: "done",
        progress: 100,
        phase: "",
        error: "",
        tag: rel.tag,
        at: Date.now(),
      };
      logger.action("zapret.install.done", { tag: rel.tag, dir: target });
    } catch (e: any) {
      installState = {
        state: "error",
        progress: 0,
        phase: "",
        error: String(e.message || e),
        tag: installState.tag,
        at: Date.now(),
      };
      logger.error("zapret.install.error", { error: installState.error });
    } finally {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        /* ignore */
      }
    }
  })();
  return installState;
}

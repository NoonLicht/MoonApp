/**
 * Бэкапы данных приложения: storage/backups/<timestamp>/ со снимком data.db,
 * settings.json, secrets.json и meta.json; плюс ротация «последние N» и
 * автобэкап по расписанию.
 *
 * TS-исходник, как server/ts/settings.ts: компилируется в server/backup.js
 * командой `npm run compile:server`, поэтому `require("./backup")` из
 * обычных .js-модулей продолжает работать без изменений.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import settings from "./settings";
import logger from "./logger";
import {
  copySources,
  restoreFiles,
  verifyBackup,
  writeManifest,
  type RestoreResult,
  type VerifyResult,
} from "./backupManifest";

const { DIRS, FILES } = config;

/** Содержимое meta.json внутри каталога бэкапа (list() отдаёт его целиком). */
export interface BackupMeta {
  trigger: string;
  at: string;
  /** Имя каталога бэкапа — по нему вызываются verify/restore. */
  id?: string;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Собирает бэкап: данные + настройки + секреты в storage/backups/<timestamp>/.
 * Возвращает путь или null, если что-то упало.
 */
export function createBackup(trigger = "manual"): string | null {
  try {
    const dir = path.join(DIRS.backups, stamp());
    fs.mkdirSync(dir, { recursive: true });

    // Снимок БД делает сама БД (VACUUM INTO): он консистентен даже при записи
    // и не тянет за собой WAL-файлы. Persist дебаунсится — backupTo сбрасывает
    // буфер перед снимком. db грузится лениво (require, а не import): бэкап не
    // должен падать там, где БД не открыта.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require("./db") as typeof import("./db")).backupTo(path.join(dir, "data.db"));
    } catch (e) {
      logger.warn("backup.db_failed", { error: (e as Error).message });
    }
    if (fs.existsSync(FILES.settings))
      fs.copyFileSync(FILES.settings, path.join(dir, "settings.json"));
    if (fs.existsSync(FILES.secrets))
      fs.copyFileSync(FILES.secrets, path.join(dir, "secrets.json"));

    // Файловые хранилища (заметки, дневник, доски, закладки…) и манифест с хэшами.
    try {
      const skipped = copySources(DIRS.storage, dir);
      if (skipped.length) logger.warn("backup.skipped_large", { files: skipped.slice(0, 20) });
    } catch (e) {
      logger.warn("backup.files_failed", { error: (e as Error).message });
    }

    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ trigger, at: new Date().toISOString() }, null, 2),
    );
    writeManifest(dir);

    rotate();
    logger.info("backup.created", { trigger, dir });
    return dir;
  } catch (e) {
    logger.error("backup.failed", { trigger, error: (e as Error).message });
    return null;
  }
}

/** Оставляем только последние N бэкапов. */
export function rotate(): void {
  // Копии «Машины времени» (trigger: time-machine) делает пользователь вручную —
  // ротация их не считает и не удаляет, иначе снимок вытеснял бы автобэкапы.
  const isManualSnapshot = (n: string): boolean => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(DIRS.backups, n, "meta.json"), "utf8"));
      return m?.trigger === "time-machine";
    } catch {
      return false;
    }
  };
  const all = fs
    .readdirSync(DIRS.backups)
    .filter((n) => !isManualSnapshot(n))
    .map((n) => ({ n, t: fs.statSync(path.join(DIRS.backups, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const keep: number = settings.get("backup").keep ?? 5;
  all.slice(keep).forEach(({ n }) => {
    try {
      fs.rmSync(path.join(DIRS.backups, n), { recursive: true, force: true });
    } catch {
      /* каталог мог исчезнуть из-под нас — ротация не повод падать */
    }
  });
}

let timer: NodeJS.Timeout | null = null;

/** Автобэкапы по расписанию (интервал в часах из настроек). */
export function startAuto(): void {
  if (timer) clearInterval(timer);
  const hours: number = settings.get("backup").intervalHours;
  const ms = Math.max(1, hours) * 60 * 60 * 1000;
  timer = setInterval(() => {
    if (settings.get("backup").auto) createBackup("auto");
  }, ms);
  timer.unref?.();
  logger.info("backup.scheduler", { intervalHours: hours });
}

/** Список бэкапов по meta.json; каталог без меты отдаётся по времени правки. */
export function list(): BackupMeta[] {
  return fs
    .readdirSync(DIRS.backups)
    .filter((n) => fs.existsSync(path.join(DIRS.backups, n, "meta.json")))
    .map((n): BackupMeta => {
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(DIRS.backups, n, "meta.json"), "utf8"),
        ) as BackupMeta;
        return { ...meta, id: n };
      } catch {
        return {
          at: new Date(fs.statSync(path.join(DIRS.backups, n)).mtimeMs).toISOString(),
          trigger: "?",
          id: n,
        };
      }
    })
    .reverse();
}

const ID_RE = /^[\w.-]+$/;

function dirOf(id: string): string {
  if (!ID_RE.test(id) || id.includes("..")) throw new Error("backup.bad_id");
  const dir = path.join(DIRS.backups, id);
  if (!fs.existsSync(dir)) throw new Error("backup.not_found");
  return dir;
}

/** Проверка целостности бэкапа по манифесту. */
export function verify(id: string): VerifyResult {
  return verifyBackup(dirOf(id));
}

/**
 * Восстановление из бэкапа. Порядок: проверка → страховочный бэкап текущего
 * состояния → возврат файлов. БД подменяется при следующем запуске.
 */
export function restore(id: string): RestoreResult & { safety: string | null } {
  const dir = dirOf(id);
  const v = verifyBackup(dir);
  if (!v.ok) throw new Error(v.hasManifest ? "backup.corrupted" : "backup.no_manifest");
  const safety = createBackup("pre-restore");
  const res = restoreFiles(dir, DIRS.storage);
  logger.info("backup.restored", { id, ...res, safety });
  return { ...res, safety };
}

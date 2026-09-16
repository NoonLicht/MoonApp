/**
 * Бэкапы данных приложения: storage/backups/<timestamp>/ с копиями data.json,
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

const { DIRS, FILES } = config;

/** Содержимое meta.json внутри каталога бэкапа (list() отдаёт его целиком). */
export interface BackupMeta {
  trigger: string;
  at: string;
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
    // Persist дебаунсится — перед копированием сбрасываем буфер на диск.
    try {
      // db — legacy .js и грузится лениво: бэкап не должен падать без него.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require("./db") as { flush(): void }).flush();
    } catch {
      /* noop */
    }
    const dir = path.join(DIRS.backups, stamp());
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(FILES.data)) fs.copyFileSync(FILES.data, path.join(dir, "data.json"));
    if (fs.existsSync(FILES.settings))
      fs.copyFileSync(FILES.settings, path.join(dir, "settings.json"));
    if (fs.existsSync(FILES.secrets))
      fs.copyFileSync(FILES.secrets, path.join(dir, "secrets.json"));

    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ trigger, at: new Date().toISOString() }, null, 2),
    );

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
  const all = fs
    .readdirSync(DIRS.backups)
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
        return JSON.parse(fs.readFileSync(path.join(DIRS.backups, n, "meta.json"), "utf8"));
      } catch {
        return {
          at: new Date(fs.statSync(path.join(DIRS.backups, n)).mtimeMs).toISOString(),
          trigger: "?",
        };
      }
    })
    .reverse();
}

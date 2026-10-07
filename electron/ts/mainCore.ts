/**
 * Выделено из main.ts при разбиении крупного файла (поведение не менялось).
 */
import path from "path";
import { STORAGE_DIR } from "./storagePath";
import { serverModule } from "./serverApi";
import fs from "fs";
import net from "net";

// --- Логирование main-процесса ---
// Всё, что Electron пишет в console.warn/error (обновления, трей, окно),
// дублируется в storage/logs/main.log. Этот файл попадает в диагностический
// отчёт кнопки «Собрать логи» в Настройках. Ротация: >2 МБ → main.1.log.
// Дополнительно ключевые события main уходят в общий журнал audit.log —
// тогда они видны в отчёте в общей хронологии с действиями пользователя.
const MAIN_LOG = path.join(STORAGE_DIR, "logs", "main.log");
let mainLogSize = -1;

// require("../server/logger") безопасен: storagePath уже выставил
// MOONAPP_STORAGE, поэтому logger пишет в правильный storage.
const serverLogger = (() => {
  try {
    return serverModule("../server/logger");
  } catch {
    return null;
  }
})();

export function mlog(level: any, event: any, data: any) {
  try {
    serverLogger?.log?.(level, event, data);
  } catch {
    /* ignore */
  }
}

function appendMainLog(level: any, args: any) {
  try {
    fs.mkdirSync(path.dirname(MAIN_LOG), { recursive: true });
    const text = args
      .map((a: any) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    const line = `${new Date().toISOString()}  ${level}  ${text}\n`;
    if (mainLogSize < 0) mainLogSize = fs.existsSync(MAIN_LOG) ? fs.statSync(MAIN_LOG).size : 0;
    if (mainLogSize > 2 * 1024 * 1024) {
      try {
        fs.renameSync(MAIN_LOG, MAIN_LOG.replace(/\.log$/, ".1.log"));
      } catch {
        /* ignore */
      }
      mainLogSize = 0;
    }
    fs.appendFileSync(MAIN_LOG, line);
    mainLogSize += Buffer.byteLength(line);
  } catch {
    /* приложение не должно падать из-за лога */
  }
}

for (const lvl of ["warn", "error"] as const) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...args: any[]) => {
    appendMainLog(lvl.toUpperCase(), args);
    orig(...args);
  };
}

// Порт больше не статичный 4000: он предсказуем (любой процесс мог просто
// постучаться в 127.0.0.1:4000), а токен сам по себе статику не защищал (см.
// authMiddleware в server/ts/index.ts). Стартуем поиск со случайного порта в
// диапазоне 20000-59999 и, как раньше, идём вверх, пока не найдём свободный.
export function findFreePort(start = 20000 + Math.floor(Math.random() * 40000), maxTry = 100) {
  return new Promise<any>((resolve, reject) => {
    const port = start;
    const tryListen = (p: any, attempt: any) => {
      if (attempt > maxTry) return reject(new Error("no free port"));
      const srv = net.createServer();
      srv.once("error", () => {
        tryListen(p + 1, attempt + 1);
      });
      srv.listen(p, () => {
        srv.close(() => resolve(p));
      });
    };
    tryListen(port, 0);
  });
}

// --- Чтение настроек (settings.json) ---
// Файл читается на каждое событие (без кэша): настройки меняются в UI, а
// подписываться на их изменения из main-процесса некуда — файл маленький,
// события происходят редко (закрытие/сворачивание окна, старт приложения).
export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

// Точечная запись в settings.json (мержим в существующий объект, чтобы не
// затирать секции, сохранённые сервером). Файл пишут два процесса (main и
// Express-роуты), поэтому берём короткий lock-файл: кто не смог захватить за
// 2 секунды — пропускает запись (потеря размера окна не критична).
function withSettingsLock(fn: any) {
  const lock = path.join(STORAGE_DIR, "settings.lock");
  let fd = null;
  for (let i = 0; i < 20 && fd === null; i++) {
    try {
      fd = fs.openSync(lock, "wx");
    } catch {
      const t0 = Date.now();
      while (Date.now() - t0 < 100) {
        /* busy-wait 100 мс */
      }
    }
  }
  if (fd === null) return false;
  try {
    return fn() !== false;
  } finally {
    try {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function patchSettings(patch: any) {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true }); // storage может ещё не существовать
    const file = path.join(STORAGE_DIR, "settings.json");
    withSettingsLock(() => {
      let cur = {};
      try {
        cur = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        /* файла ещё нет */
      }
      const merged: Record<string, any> = { ...cur };
      for (const [section, values] of Object.entries(patch as Record<string, any>)) {
        merged[section] = { ...(merged[section] || {}), ...values };
      }
      fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
      return true;
    });
  } catch {
    /* окно не должно падать из-за неудачной записи размера */
  }
}

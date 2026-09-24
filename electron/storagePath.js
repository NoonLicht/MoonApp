/**
 * Единая точка вычисления пути к папке данных приложения (storage/).
 *
 * ГЛАВНОЕ ПРАВИЛО: данные пользователя (настройки, секреты, скачанные паки,
 * модели апскейла, журналы) живут ТОЛЬКО в %APPDATA%\MoonApp\storage и не
 * зависят от того, куда установлено приложение. Инсталлятор/деинсталлятор
 * работает с папкой установки и %APPDATA% не трогает НИКОГДА (см. build/
 * installer.nsh: перед удалением старой версии Storage переносится в
 * %APPDATA%\MoonApp\storage, а не удаляется), поэтому обновление и
 * переустановка приложения не могут стереть паки, модели и настройки.
 *
 * Порядок приоритета:
 *  1. Собранное приложение (app.isPackaged) — storage/ в %APPDATA%\MoonApp\storage
 *     (userData). Раньше storage/ лежала внутри папки установки
 *     (<install>\storage), и это было ОПАСНО: полный NSIS-инсталлятор
 *     (Setup.exe, который пользователь запускает вручную поверх старой версии)
 *     перед копированием новых файлов сначала тихо вызывает деинсталлятор
 *     ПРЕДЫДУЩЕЙ версии, а тот удаляет всё содержимое папки установки целиком —
 *     включая storage/ с настройками, секретами и скачанными паками апскейла.
 *     Тихое автообновление через electron-updater (без деинсталляции, просто
 *     докопирование файлов) этой проблемы не имело, поэтому баг проявлялся
 *     только при ручной переустановке — что и произошло: 0.3.2 → 0.3.3 стёрло
 *     всё. %APPDATA% инсталлятор не трогает никогда, поэтому это единственное
 *     по-настоящему безопасное место.
 *     Для обновлений с версий, где storage/ ещё лежала в папке установки,
 *     работает перенос данных из старого места — см. migrateLegacy().
 *     Если даже userData недоступна на запись (экзотика: политики, антивирус),
 *     берём %LOCALAPPDATA%\MoonApp\storage — тоже вне папки установки. Папка
 *     установки рассматривается последней и только как самый крайний случай:
 *     там данные может стереть следующее обновление, о чём пишем в журнал.
 *  2. MOONAPP_STORAGE — явный оверрайд, только для dev/тестов/CI.
 *  3. Dev-режим — storage/ рядом с проектом.
 *
 * Модуль вычисляет путь один раз при первом обращении и экспортирует
 * константы, поэтому его можно безопасно require'ить в любом порядке.
 */
const path = require("path");
const fs = require("fs");

let _electron = null;
try {
  // В чистом Node (тесты, start:server) require("electron") вернёт строку-путь —
  // игнорируем, работаем как в dev.
  const e = require("electron");
  if (e && typeof e === "object") _electron = e;
} catch {
  /* не в Electron-рантайме */
}

function probeWritableOnce(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * probeWritable с ретраями (синхронными, короткими) — раньше единственная
 * попытка `probeWritable` могла упасть из-за ВРЕМЕННОЙ блокировки файлов
 * антивирусом/Windows Defender сразу после того, как NSIS-инсталлятор
 * перезаписал файлы в папке установки при автообновлении (electron-updater).
 * Один неудачный проб в этот момент навсегда переключал STORAGE_DIR на
 * пустую папку в %APPDATA% — пользователь видел «всё сбросилось», хотя
 * реальные настройки/паки лежали рядом с exe целые, просто были на секунду
 * недоступны. Несколько попыток с паузой устраняют этот ложный срабатыватель.
 */
function probeWritable(dir, attempts = 5, delayMs = 200) {
  for (let i = 0; i < attempts; i++) {
    if (probeWritableOnce(dir)) return true;
    if (i < attempts - 1) {
      // Синхронная пауза: это происходит один раз при старте приложения,
      // до создания окна, поэтому короткая блокировка event loop не заметна,
      // а Atomics.wait не годится (нет SharedArrayBuffer под рукой).
      const until = Date.now() + delayMs;
      while (Date.now() < until) {
        /* busy-wait короткого интервала */
      }
    }
  }
  return false;
}

/**
 * Есть ли в папке признаки уже существующих пользовательских данных
 * (настройки/секреты/паки). Нужно только для понятных сообщений в журнале.
 */
function hasExistingData(dir) {
  try {
    return (
      fs.existsSync(path.join(dir, "settings.json")) ||
      fs.existsSync(path.join(dir, "secrets.json"))
    );
  } catch {
    return false;
  }
}

/** Одинаковый ли это путь (сравнение без учёта регистра и лишних слэшей). */
function samePath(a, b) {
  const norm = (p) =>
    path
      .resolve(String(p || ""))
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Слить дерево «источник → цель», НЕ перетирая то, что уже есть в цели.
 *
 * Почему именно так: перенос/миграция не должны затирать актуальные данные
 * пользователя. Копируем только те файлы, которых в цели нет («есть обновлённые
 * файлы» — вернее, отсутствующие), а существующие оставляем как есть: если
 * настройки уже лежат в новом месте, они и остаются главными.
 *
 * → число реально скопированных файлов.
 */
function mergeMissing(from, to) {
  let copied = 0;
  const walk = (srcDir, dstDir) => {
    let entries;
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch {
      return; // недоступный/исчезнувший каталог — пропускаем, не роняем старт
    }
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of entries) {
      const src = path.join(srcDir, entry.name);
      const dst = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        // Файл на месте каталога (или наоборот) — не трогаем чужое.
        if (fs.existsSync(dst) && !fs.statSync(dst).isDirectory()) continue;
        walk(src, dst);
        continue;
      }
      if (fs.existsSync(dst)) continue; // уже есть — не перетираем
      try {
        fs.copyFileSync(src, dst);
        copied++;
      } catch {
        /* занят/нет прав — пропускаем файл, остальные переносим */
      }
    }
  };
  walk(from, to);
  return copied;
}

/** Файл-маркер: разовый перенос из старых мест уже выполнялся. */
const LEGACY_MARKER = ".legacy-migrated";

/**
 * Разовый перенос данных из СТАРЫХ мест хранения в текущее.
 *
 * Источники (в порядке проверки):
 *  - <папка установки>\storage      — версии ≤ 0.3.3 держали данные рядом с exe;
 *  - <папка установки>\storage.legacy — так данные может сохранить инсталлятор;
 *  - %LOCALAPPDATA%\MoonApp\storage — прошлый аварийный фолбэк.
 *
 * Зачем это нужно, если инсталлятор уже переносит storage (см. build/installer.nsh):
 * перенос в инсталляторе срабатывает только при установке НОВОЙ версии поверх
 * старой. Если папку установки удалили/перенесли вручную, или данные остались
 * от portable-раскладки, — здесь они подхватятся при первом запуске.
 *
 * Ничего не удаляем: лишняя копия файлов безвредна, а «чужой» каталог может
 * использоваться другой копией приложения.
 */
function migrateLegacy(target, legacyDirs) {
  try {
    if (fs.existsSync(path.join(target, LEGACY_MARKER))) return; // уже переносили
    let total = 0;
    for (const dir of legacyDirs) {
      if (!dir || samePath(dir, target)) continue;
      if (!hasExistingData(dir) && !fs.existsSync(dir)) continue;
      total += mergeMissing(dir, target);
    }
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, LEGACY_MARKER),
      `migrated ${new Date().toISOString()} files=${total}\n`,
    );
    if (total) console.error(`[storagePath] перенёс ${total} файл(ов) данных в "${target}".`);
  } catch (e) {
    console.error(`[storagePath] перенос данных из старого места не удался: ${e?.message || e}`);
  }
}

function resolveStorageDir() {
  // 1) Упакованное приложение → данные в %APPDATA%\MoonApp\storage (userData),
  //    НЕ в папке установки — см. комментарий к файлу. Оверрайд из окружения
  //    здесь не применяется намеренно (иначе запущенная копия подхватывала бы
  //    данные другого места).
  if (_electron?.app?.isPackaged) {
    const installDir = path.dirname(_electron.app.getPath("exe"));
    const appData = path.join(_electron.app.getPath("userData"), "storage");
    const localAppData = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "MoonApp", "storage")
      : "";
    const portable = path.join(installDir, "storage");

    // Данные от версий, где storage лежала рядом с exe (или от прошлого фолбэка).
    migrateLegacy(appData, [portable, `${portable}.legacy`, localAppData]);

    if (probeWritable(appData)) return appData;
    if (localAppData && probeWritable(localAppData)) {
      console.error(
        `[storagePath] "${appData}" недоступна для записи — работаю в "${localAppData}".`,
      );
      return localAppData;
    }
    // Крайний случай: и Roaming, и Local недоступны (политики/антивирус).
    // Папка установки — плохое место (её стирает переустановка), поэтому
    // сообщаем об этом явно, а не молча.
    console.error(
      `[storagePath] ни "${appData}", ни "${localAppData}" недоступны для записи — ` +
        `переключаюсь на "${portable}" (данные могут пропасть при переустановке!). ` +
        `Проверьте права доступа/антивирус.`,
    );
    if (probeWritable(portable)) return portable;
    try {
      fs.mkdirSync(appData, { recursive: true });
    } catch {
      /* отдаём как есть */
    }
    return appData;
  }

  // 2) Явный оверрайд (dev-скрипты, тесты, ручной запуск сервера).
  if (process.env.MOONAPP_STORAGE) return process.env.MOONAPP_STORAGE;

  // 3) Dev — storage/ рядом с проектом.
  return path.join(__dirname, "..", "storage");
}

const STORAGE_DIR = resolveStorageDir();

// Подставляем путь дочернему серверному коду ДО его require. server/config.js
// и server/ts/monitor.ts читают эту переменную — серверные модули трогать не нужно.
process.env.MOONAPP_STORAGE = STORAGE_DIR;

module.exports = { STORAGE_DIR, resolveStorageDir, probeWritable, mergeMissing };

/**
 * Файловые операции с «хитростями Windows».
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ: fs.rmSync на Windows МОЛЧА не удаляет файл, в имени
 * которого есть не-ASCII символы (кириллица, акценты). Вызов проходит без
 * ошибки и без исключения, а файл остаётся на диске:
 *
 *     fs.rmSync("storage\\notes\\3-лекция-история.md"); // файл НА МЕСТЕ
 *     fs.unlinkSync("storage\\notes\\3-лекция-история.md"); // файл удалён
 *
 * Проверено на Node v24.4.0 / win32: rmSync не срабатывает ни с force, ни с
 * Buffer-путём, ни с префиксом \\?, ни в рекурсивном виде (рекурсивный вариант
 * проходит, только если САМ путь ASCII, а не-ASCII только внутри). unlinkSync
 * работает всегда, поэтому каталоги обходим вручную: readdir + unlink + rmdir.
 *
 * Чем это било: заметки и лекции почти всегда названы по-русски, поэтому
 * удаление возвращало «успех», а .md файл оставался; при переименовании
 * (slug файла зависит от заголовка) копились дубли.
 *
 * Второе, зачем модуль: removeOlderThan — общая TTL-уборка каталогов-хранилищ.
 * Она была скопирована в compressor.js, tts.js и sitebak.js (три почти
 * идентичных цикла, отличались только каталогом и списком исключений).
 * Уборка идёт через removePath, поэтому корректно переживает кириллические
 * имена внутри временных папок — штатный rmSync здесь как раз и спотыкался.
 */
import fs from "fs";
import path from "path";

/** Код ошибки файловой системы (ENOENT/EBUSY/EACCES/EPERM). */
function codeOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

/** Удалить один файл (или симлинк). true — путь исчез. */
function removeSingle(target: string): boolean {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (e) {
    if (codeOf(e) === "ENOENT") return true; // уже нет — цель достигнута
    // Дальше — файл под блокировкой (антивирус/индексатор) или нет прав.
  }
  try {
    fs.rmSync(target, { force: true, maxRetries: 2 });
  } catch {
    /* ignore */
  }
  return !fs.existsSync(target);
}

/** Рекурсивно удалить каталог, обходя дерево сами (см. комментарий выше). */
function removeDirTree(dir: string): boolean {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) removeDirTree(full);
      else removeSingle(full);
    }
    fs.rmdirSync(dir);
  } catch (e) {
    if (codeOf(e) === "ENOENT") return true;
    // Права/занятость: ниже пробуем штатный рекурсивный rm.
  }
  if (!fs.existsSync(dir)) return true;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* ignore */
  }
  return !fs.existsSync(dir);
}

/**
 * Удалить файл или каталог.
 * @returns true — путь действительно исчез с диска (не «вызов прошёл»)
 */
export function removePath(target: string): boolean {
  let isDir = false;
  try {
    isDir = fs.lstatSync(target).isDirectory();
  } catch (e) {
    if (codeOf(e) === "ENOENT") return true;
  }
  return isDir ? removeDirTree(target) : removeSingle(target);
}

export interface TtlCleanupOptions {
  /** Каталог-хранилище. Если его нет — уборка молча ничего не делает. */
  dir: string;
  /** Возраст (по mtime), после которого запись считается мусором. */
  ttlMs: number;
  /** Имена, которые трогать нельзя (например, profiles.json и presets.json). */
  keep?: string[];
  /** Текущее время: параметр нужен только тестам, в бою берётся Date.now(). */
  now?: number;
}

/**
 * Удаляет из каталога всё, что старше ttlMs (по времени последней модификации).
 * @returns имена реально удалённых записей — удобно для логов и тестов
 */
export function removeOlderThan({
  dir,
  ttlMs,
  keep = [],
  now = Date.now(),
}: TtlCleanupOptions): string[] {
  const removed: string[] = [];
  try {
    if (!fs.existsSync(dir)) return removed;
    const keepSet = new Set(keep);
    for (const name of fs.readdirSync(dir)) {
      if (keepSet.has(name)) continue;
      const target = path.join(dir, name);
      try {
        if (now - fs.statSync(target).mtimeMs <= ttlMs) continue;
        if (removePath(target)) removed.push(name);
      } catch {
        /* занят (антивирус/индексатор) — пропускаем */
      }
    }
  } catch {
    /* не критично: уборка не должна ломать запуск движка */
  }
  return removed;
}

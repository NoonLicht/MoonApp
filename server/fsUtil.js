"use strict";

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
 */

const fs = require("fs");
const path = require("path");

/** Удалить один файл (или симлинк). true — путь исчез. */
function removeSingle(target) {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return true; // уже нет — цель достигнута
    // Дальше — файл под блокировкой (антивирус/индексатор) или нет прав.
  }
  try { fs.rmSync(target, { force: true, maxRetries: 2 }); } catch { /* ignore */ }
  return !fs.existsSync(target);
}

/** Рекурсивно удалить каталог, обходя дерево сами (см. комментарий выше). */
function removeDirTree(dir) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) removeDirTree(full);
      else removeSingle(full);
    }
    fs.rmdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return true;
    // Права/занятость: ниже пробуем штатный рекурсивный rm.
  }
  if (!fs.existsSync(dir)) return true;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* ignore */ }
  return !fs.existsSync(dir);
}

/**
 * Удалить файл или каталог.
 * @returns {boolean} true — путь действительно исчез с диска (не «вызов прошёл»)
 */
function removePath(target) {
  let isDir = false;
  try { isDir = fs.lstatSync(target).isDirectory(); }
  catch (e) { if (e.code === "ENOENT") return true; }
  return isDir ? removeDirTree(target) : removeSingle(target);
}

module.exports = { removePath };

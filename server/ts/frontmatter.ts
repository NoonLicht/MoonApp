/**
 * Разбор YAML-frontmatter в .md-файлах хранилищ.
 *
 * Зачем модуль: один и тот же цикл разбора был скопирован в notes-fs.js
 * (заметки storage/notes) и myspace-vault.js (файлы MySpace). Копии успели
 * разойтись обработкой кавычек, а формат-то общий: блок между двумя строками
 * "---", строки вида `ключ: "значение"`. Любая правка формата требовала бы
 * синхронной правки в обоих местах — и однажды разъехалась бы.
 *
 * Модуль трогает ТОЛЬКО чтение: запись frontmatter у двух хранилищ различается
 * (в заметках id пишется числом, в MySpace — строкой в кавычках), и менять то,
 * что уже лежит на диске у пользователей, здесь нельзя.
 */

export interface ParsedMarkdown {
  /** Найден ли блок frontmatter (обе строки "---" на месте). */
  hasFrontmatter: boolean;
  /** Плоская карта ключ → значение; значения без обрамляющих кавычек. */
  frontmatter: Record<string, string>;
  /** Тело документа (без блока frontmatter). Если блока нет — исходный текст. */
  content: string;
}

/**
 * Отделяет frontmatter от тела документа.
 *
 * Если блок не найден (файл начинается не с "---" или закрывающая строка
 * отсутствует), возвращает hasFrontmatter=false, пустую карту и весь текст как
 * content: на диск могли положить .md, созданный другим редактором.
 */
export function parseFrontmatter(raw: string): ParsedMarkdown {
  const frontmatter: Record<string, string> = {};
  let content = raw;
  let hasFrontmatter = false;

  if (raw.startsWith("---")) {
    const endIdx = raw.indexOf("---", 3);
    if (endIdx > 0) {
      hasFrontmatter = true;
      const block = raw.slice(3, endIdx).trim();
      content = raw.slice(endIdx + 3).trimStart();
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        let val = trimmed.slice(colonIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        frontmatter[key] = val;
      }
    }
  }

  return { hasFrontmatter, frontmatter, content };
}

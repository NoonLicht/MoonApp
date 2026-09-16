/**
 * Локальные настройки интерфейса и страниц (localStorage).
 *
 * Часть настроек страниц живёт НЕ в settings.json, а в localStorage: прогресс
 * панели задач, конфиг ИИ-чата (системный промпт, температура), кастомные
 * пресеты моделей, последняя выбранная модель. Экспорт настроек обязан
 * переносить и их, иначе «все настройки со всех страниц» будут неполными.
 *
 * Значения отдаём СЫРЫМИ строками (как лежат в localStorage): импорт пишет их
 * обратно один в один, без разбора и обратной сборки JSON — иначе чужой формат
 * значения мог бы пострадать от нормализации.
 *
 * Ключи с секретами (token/secret/password/apikey) в файл не попадают: токен
 * доступа к серверу приложения — не настройка, и переносить его нельзя.
 */

const SECRET_KEY_RE = /token|secret|password|passwd|apikey/i;

/** Снимок настроек интерфейса: { ключ: сырая строка }. */
export function collectUiSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || SECRET_KEY_RE.test(k)) continue;
      out[k] = localStorage.getItem(k) ?? "";
    }
  } catch {
    /* localStorage недоступен — отдаём пустой снимок */
  }
  return out;
}

/**
 * Применить настройки интерфейса из импортируемого файла.
 * @returns сколько ключей записано
 */
export function applyUiSettings(ui: unknown): number {
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(ui as Record<string, unknown>)) {
    if (typeof v !== "string" || SECRET_KEY_RE.test(k)) continue;
    try {
      localStorage.setItem(k, v);
      n++;
    } catch {
      /* квота переполнена — пропускаем */
    }
  }
  return n;
}

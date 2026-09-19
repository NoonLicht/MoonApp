/**
 * Пресеты форумов-трекеров: один движок поиска, разные площадки.
 *
 * Зачем отдельный модуль: server/ts/trackerScraper.ts — сеть и сессия, а различия
 * между трекерами (адреса, кодировка, способ поиска, нужен ли вход, разметка
 * выдачи) удобнее держать данными, а не ветвлениями внутри функций. Пресет —
 * это полный набор настроек, который роут «/tracker/preset» кладёт в
 * settings.trackers целиком, поэтому переключение трекера в UI не оставляет
 * «хвостов» от предыдущего.
 *
 * Модуль ЧИСТЫЙ (ни сети, ни настроек, ни БД) — покрыт tests/trackerProviders.test.ts.
 *
 * TS-исходник, как server/ts/trackerParse.ts: компилируется в
 * server/trackerProviders.js командой `npm run compile:server`.
 */

/** Движок разбора выдачи и способа поиска. */
export type TrackerEngine = "rutracker" | "rutor";

export interface TrackerPreset {
  id: string;
  engine: TrackerEngine;
  /** Название для UI (в i18n есть переводы movies.trackerPreset<Id>). */
  label: string;
  baseUrl: string;
  loginPath: string;
  /**
   * Путь поиска. Если содержит `{q}` — запрос подставляется в САМ ПУТЬ
   * (rutor: /search/0/0/000/0/{q}), иначе используется searchMethod+searchParam.
   */
  searchPath: string;
  searchMethod: "get" | "post";
  searchParam: string;
  topicPath: string;
  torrentPath: string;
  encoding: string;
  /** Нужен ли вход для поиска: rutracker — да, rutor — нет. */
  requiresLogin: boolean;
  /** Куки, которые означают «вход выполнен» (пусто — вход не нужен). */
  loginCookies: string[];
  /** Короткая подсказка для UI/логов. */
  note: string;
}

/**
 * RuTracker: phpBB-форум, cp1251, POST-поиск по `nm`, выдача в `#tor-tbl`.
 * Вход обязателен, а `tracker.php` закрыт Cloudflare Bot Management.
 */
const RUTRACKER: TrackerPreset = {
  id: "rutracker",
  engine: "rutracker",
  label: "RuTracker",
  baseUrl: "https://rutracker.org",
  loginPath: "/forum/login.php",
  searchPath: "/forum/tracker.php",
  searchMethod: "post",
  searchParam: "nm",
  topicPath: "/forum/viewtopic.php?t={id}",
  torrentPath: "/forum/dl.php?t={id}",
  encoding: "windows-1251",
  requiresLogin: true,
  loginCookies: ["bb_data"],
  note: "phpBB-форум: вход обязателен, tracker.php закрыт Cloudflare",
};

/**
 * RuTor (rutor.info): utf-8, поиск уходит в путь `/search/0/0/000/0/<запрос>`,
 * вход для поиска и .torrent не нужен, выдача — строки `tr.gai`/`tr.tum`,
 * .torrent отдаёт отдельный хост d.rutor.info.
 */
const RUTOR: TrackerPreset = {
  id: "rutor",
  engine: "rutor",
  label: "RuTor",
  baseUrl: "https://rutor.info",
  loginPath: "/users.php",
  searchPath: "/search/0/0/000/0/{q}",
  // Способ поиска: у rutor строка запроса — часть пути, поэтому GET с шаблоном {q}.
  // searchParam задан для кодирования значения (см. sendSearch).
  searchMethod: "get",
  searchParam: "q",
  topicPath: "/torrent/{id}",
  // .torrent лежит на поддомене: абсолютный URL, потому что шаблон подставляется
  // напрямую в href (см. toRelease в trackerScraper).
  torrentPath: "https://d.rutor.info/download/{id}",
  encoding: "utf-8",
  requiresLogin: false,
  loginCookies: [],
  note: "utf-8, поиск без входа, выдача tr.gai/tum",
};

/** Все пресеты в порядке показа в UI (первый — по умолчанию). */
export const TRACKER_PRESETS: TrackerPreset[] = [RUTOR, RUTRACKER];

/** Пресет по умолчанию: rutor — отвечает без Cloudflare и не требует входа. */
export const DEFAULT_PRESET: TrackerPreset = RUTOR;

/** Ярлык движка из чего угодно: неизвестное значение — rutracker (совместимость). */
export function normEngine(value: unknown): TrackerEngine {
  return String(value || "").trim().toLowerCase() === "rutor" ? "rutor" : "rutracker";
}

/** Пресет по id (регистр не важен). null — такого пресета нет. */
export function presetById(id: unknown): TrackerPreset | null {
  const key = String(id || "").trim().toLowerCase();
  return TRACKER_PRESETS.find((p) => p.id === key) || null;
}

/**
 * Пресет движка: нужен, когда из settings пришёл только engine. Неизвестное или
 * пустое значение — пресет ПО УМОЛЧАНИЮ (rutor); для старых настроек без `engine`
 * движок выводится из адреса площадки ещё при загрузке (см. settings.ts).
 */
export function presetForEngine(engine: unknown): TrackerPreset {
  const key = String(engine || "").trim().toLowerCase();
  if (!key) return DEFAULT_PRESET;
  return TRACKER_PRESETS.find((p) => p.id === key || p.engine === key) || DEFAULT_PRESET;
}

/**
 * Пресеты для API/UI: что показать в списке выбора трекера. Настройки (адреса,
 * кодировки) не отдаём — их применяет роут по id.
 */
export function trackerPresetList(): Array<{
  id: string;
  label: string;
  baseUrl: string;
  requiresLogin: boolean;
}> {
  return TRACKER_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    requiresLogin: p.requiresLogin,
  }));
}

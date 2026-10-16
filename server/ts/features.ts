/**
 * Отключаемые страницы: что именно перестаёт работать вместе со страницей.
 *
 * Пользователь выключает страницу в Настройки → «Страницы» (settings.pages.disabled — id через
 * запятую). Тогда:
 *   • роуты, которые нужны ТОЛЬКО ей, отвечают 404 `feature_disabled` и даже не загружаются
 *     (роуты подключаются лениво — модуль с его тяжёлыми зависимостями читается при первом
 *     запросе, поэтому у отключённой страницы он не читается никогда);
 *   • её фоновые службы (почта, ленты, мониторинг…) останавливаются и не стартуют при запуске;
 *   • всё, чем пользуются другие включённые страницы или сама оболочка, остаётся: например,
 *     распознавание речи нужно голосовому вводу чата, поэтому его роуты работают, пока
 *     включён чат ИЛИ лекторий.
 *
 * Кто чем пользуется — в featureMap.generated.ts (его строит scripts/ts/genFeatureMap.mts
 * по исходникам клиента; тест tests/featureMap.test.ts следит, чтобы карта не устарела).
 */
import type express from "express";
import settings from "./settings";
import logger from "./logger";
import { FEATURE_MAP } from "./featureMap.generated";

export const PAGE_IDS: string[] = Object.keys(FEATURE_MAP.pages);

/** Без «Настроек» нельзя ни вернуть страницы, ни поменять что-либо: их отключить нельзя. */
export const LOCKED_PAGES: readonly string[] = ["settings"];

/**
 * Профили: какие страницы остаются включёнными. `all` — всё. Остальное отключается.
 * Названия профилей переводятся на клиенте (settings.pages.profile.<id>).
 */
export const PROFILES: Record<string, string[] | null> = {
  all: null,
  media: [
    "store", "convert", "compress", "photo", "video", "movies", "music", "books",
    "monitor", "screenshots", "archive", "tools", "settings",
  ],
  study: [
    "store", "aichat", "voice", "lecture", "myspace", "diary", "translate", "books", "rss",
    "tools", "settings",
  ],
  minimal: ["store", "video", "music", "settings"],
};

/** Страницы, которые профиль оставляет включёнными (null — все). */
function enabledByProfile(profile: string): string[] | null {
  const list = PROFILES[profile];
  return list === undefined ? null : list;
}

export function disabledPages(): Set<string> {
  const raw = String((settings.get("pages") as { disabled?: unknown } | undefined)?.disabled ?? "");
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      // страница «Апскейл» стала вкладкой «Фото и видео» (id photo)
      .map((s) => (s === "upscale" ? "photo" : s))
      .filter((s) => PAGE_IDS.includes(s) && !LOCKED_PAGES.includes(s)),
  );
}

export const isPageEnabled = (id: string): boolean => !disabledPages().has(id);

/** Сохранить набор отключённых страниц (профиль — только пометка для интерфейса). */
export function setDisabledPages(ids: string[], profile = "custom"): void {
  const clean = [...new Set(ids)].filter((s) => PAGE_IDS.includes(s) && !LOCKED_PAGES.includes(s));
  settings.set({ pages: { disabled: clean.join(","), profile } });
  logger.action("features.pages_changed", { disabled: clean, profile });
  reconcileServices();
}

/** Отключить всё, кроме страниц профиля. */
export function applyProfile(profile: string): void {
  const keep = enabledByProfile(profile);
  const off = keep ? PAGE_IDS.filter((id) => !keep.includes(id)) : [];
  setDisabledPages(off, profile in PROFILES ? profile : "custom");
}

// ───────────────────────────── роуты ─────────────────────────────

/** Страницы, которым нужен роут (настройки не считаются для блоков «следующих» за чужой страницей). */
function ownersOf(prefix: string): string[] {
  const follow = FEATURE_MAP.follow.includes(prefix);
  return Object.entries(FEATURE_MAP.pages)
    .filter(([id, list]) => list.includes(prefix) && !(follow && id === "settings"))
    .map(([id]) => id);
}

/** Нужен ли роут `/api/<prefix>`: хозяин-страница включена, либо им пользуется оболочка. */
export function prefixActive(prefix: string): boolean {
  if (FEATURE_MAP.core.includes(prefix) && !FEATURE_MAP.soft.includes(prefix)) return true;
  const owners = ownersOf(prefix);
  if (!owners.length) return true; // никто не владеет — общая функция
  const off = disabledPages();
  return owners.some((id) => !off.has(id));
}

/**
 * Движок распознавания речи живёт в роуте лекций (`/api/lecture/engine*`), но нужен и голосовому
 * вводу чата и быстрым заметкам, поэтому остаётся доступным, пока работает хоть один из них.
 */
function routeActive(prefix: string, rest: string): boolean {
  if (prefixActive(prefix)) return true;
  if (prefix === "lecture" && rest.startsWith("/engine")) return prefixActive("quicknotes");
  return false;
}

/** Страницы, из-за которых роут нужен (для сообщения об ошибке). */
export const pagesFor = (prefix: string): string[] => ownersOf(prefix);

type Loader = () => express.RequestHandler;

/** Все ленивые роуты: нужны, чтобы прогреть включённые в фоне (warmRoutes). */
const lazyRegistry: { mount: string; prefix: string; ensure(): void }[] = [];

/**
 * Роутер, который читает свой модуль при первом запросе и отвечает 404 `feature_disabled`,
 * пока все страницы-владельцы выключены. `mount` — путь монтирования («/api/convert»).
 */
export function lazyRouter(mount: string, load: Loader): express.RequestHandler {
  const prefix = mount.split("/")[2] ?? "";
  let handler: express.RequestHandler | null = null;
  lazyRegistry.push({
    mount,
    prefix,
    ensure() {
      handler ??= load();
    },
  });
  return (req, res, next) => {
    if (prefix && !routeActive(prefix, req.path)) {
      res.status(404).json({ error: "feature_disabled", feature: prefix, pages: pagesFor(prefix) });
      return;
    }
    try {
      handler ??= load();
    } catch (e) {
      logger.error("features.route_load_failed", { mount, error: (e as Error).message });
      next(e);
      return;
    }
    handler(req, res, next);
  };
}

/**
 * Прогреть в фоне модули включённых роутов (по одному, с паузами, чтобы не занимать цикл
 * событий): первый запрос к странице не ждёт чтения модуля. У отключённых страниц модули
 * по-прежнему не читаются — они пропускаются здесь и загрузятся лишь при включении.
 */
export function warmRoutes(): void {
  const queue = lazyRegistry.filter((r) => !r.prefix || prefixActive(r.prefix));
  const step = (): void => {
    const r = queue.shift();
    if (!r) return;
    try {
      r.ensure();
    } catch (e) {
      logger.warn("features.route_warm_failed", { mount: r.mount, error: (e as Error).message });
    }
    setTimeout(step, 15).unref();
  };
  setTimeout(step, 250).unref();
}

// ───────────────────────────── фоновые службы ─────────────────────────────

export interface Service {
  id: string;
  /** Службе нужна хотя бы одна из этих страниц. */
  pages: string[];
  start(): void | Promise<void>;
  /** Без stop служба остановится только после перезапуска приложения. */
  stop?(): void | Promise<void>;
  running?: boolean;
}

const services: Service[] = [];

export function defineService(s: Service): void {
  services.push(s);
}

/** Запустить службы включённых страниц и остановить службы отключённых. */
export function reconcileServices(): void {
  const off = disabledPages();
  for (const s of services) {
    const want = s.pages.some((p) => !off.has(p));
    try {
      if (want && !s.running) {
        s.running = true;
        void Promise.resolve(s.start()).catch((e) =>
          logger.warn("features.service_start_failed", { id: s.id, error: (e as Error).message }),
        );
      } else if (!want && s.running) {
        s.running = false;
        void Promise.resolve(s.stop?.()).catch(() => undefined);
        logger.info("features.service_stopped", { id: s.id, hasStop: !!s.stop });
      }
    } catch (e) {
      logger.warn("features.service_failed", { id: s.id, error: (e as Error).message });
    }
  }
}

export const serviceStates = (): { id: string; running: boolean; pages: string[] }[] =>
  services.map((s) => ({ id: s.id, running: !!s.running, pages: s.pages }));

// ───────────────────────────── сводка для интерфейса ─────────────────────────────

export interface PageFeatureInfo {
  id: string;
  enabled: boolean;
  locked: boolean;
  /** Роуты, которые остановятся вместе со страницей (больше ими никто не пользуется). */
  stops: string[];
  /** Роуты страницы, которые останутся: ими пользуется ещё кто-то. */
  keeps: { prefix: string; by: string[] }[];
}

export function summary(): {
  profile: string;
  disabled: string[];
  pages: PageFeatureInfo[];
  profiles: Record<string, string[]>;
} {
  const off = disabledPages();
  const pages: PageFeatureInfo[] = PAGE_IDS.map((id) => {
    const stops: string[] = [];
    const keeps: { prefix: string; by: string[] }[] = [];
    for (const prefix of FEATURE_MAP.pages[id]) {
      const others = ownersOf(prefix).filter((o) => o !== id);
      const shell = FEATURE_MAP.core.includes(prefix) && !FEATURE_MAP.soft.includes(prefix);
      const stay = shell ? ["shell"] : others;
      if (stay.length) keeps.push({ prefix, by: stay });
      else stops.push(prefix);
    }
    return { id, enabled: !off.has(id), locked: LOCKED_PAGES.includes(id), stops, keeps };
  });
  const profiles: Record<string, string[]> = {};
  for (const [name, keep] of Object.entries(PROFILES)) profiles[name] = keep ?? PAGE_IDS;
  return {
    profile: String((settings.get("pages") as { profile?: unknown } | undefined)?.profile ?? "all"),
    disabled: [...off],
    pages,
    profiles,
  };
}

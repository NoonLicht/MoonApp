/**
 * Store / каталог приложений — Linux-реализация. Тот же контракт, что у
 * server/ts/winget.ts (WingetRow-совместимые поля name/id/version/source,
 * seed()/search()/install()/indexStatus()/readIndex()/startIndexing()), но
 * вместо winget используются системные CLI Flatpak (основной источник —
 * Flathub, самый широкий кроссдистрибутивный каталог) и snap (фолбэк, если
 * flatpak не установлен). Сырой REST Flathub API сознательно не используется:
 * `flatpak` сам умеет говорить с любым настроенным remote (не только Flathub),
 * это меньше кода и меньше сюрпризов с авторизацией/рейт-лимитами.
 *
 * `id` в возвращаемых строках несёт префикс источника ("flatpak:org.mozilla.
 * firefox" / "snap:firefox"), чтобы install() знал, каким бэкендом ставить —
 * один и тот же короткий id может существовать в обоих источниках сразу.
 *
 * TS-исходник: компилируется в server/appStoreLinux.js командой
 * `npm run compile:server`, требуется из server/routes/apps.js через тот же
 * Proxy-диспетчер, что и zapret/killSwitch (см. комментарий там).
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";

const { DIRS } = config;
const INDEX_FILE = path.join(DIRS.storage, "appstore_index.json");

export interface AppRow {
  name: string;
  id: string;
  version: string;
  source: "flatpak" | "snap";
}

export interface AppSeedRow extends AppRow {
  category: string;
}

export interface AppIndexState {
  state: "none" | "indexing" | "ready";
  done: number;
  total: number;
  current: string;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve({ stdout: String(stdout || ""), code: err ? (typeof err.code === "number" ? err.code : 1) : 0 });
    });
  });
}

let flatpakAvailable: boolean | null = null;
let snapAvailable: boolean | null = null;

async function hasFlatpak(): Promise<boolean> {
  if (flatpakAvailable === null) flatpakAvailable = (await run("flatpak", ["--version"])).code === 0;
  return flatpakAvailable;
}

async function hasSnap(): Promise<boolean> {
  if (snapAvailable === null) snapAvailable = (await run("snap", ["version"])).code === 0;
  return snapAvailable;
}

/** Явная и понятная ошибка вместо тихого падения, если нет ни одного бэкенда. */
async function requireAnyBackend(): Promise<void> {
  if (!(await hasFlatpak()) && !(await hasSnap())) {
    throw new Error(
      "no_package_manager: не найден ни flatpak, ни snap — установите один из них через " +
        "менеджер пакетов вашего дистрибутива (например `apt install flatpak` + " +
        "`flatpak remote-add flathub https://dl.flathub.org/repo/flathub.flatpakrepo`)",
    );
  }
}

/** `flatpak search <query> --columns=name,application,version` — табуляция колонок. */
function parseFlatpakSearch(text: string): AppRow[] {
  const rows: AppRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const cols = raw.split("\t");
    if (cols.length < 3) continue;
    const [name, id, version] = cols;
    if (!id || !id.includes(".")) continue; // заголовок таблицы/пустая строка
    rows.push({ name: name.trim(), id: `flatpak:${id.trim()}`, version: (version || "").trim(), source: "flatpak" });
  }
  return rows;
}

/** `snap find <query>` — фиксированные колонки, разделены произвольным числом пробелов. */
function parseSnapFind(text: string): AppRow[] {
  const rows: AppRow[] = [];
  const lines = text.split(/\r?\n/).slice(1); // первая строка — заголовок Name Version Publisher...
  for (const raw of lines) {
    const m = /^(\S+)\s+(\S+)\s+(\S+)/.exec(raw);
    if (!m) continue;
    const [, name, version] = m;
    rows.push({ name, id: `snap:${name}`, version, source: "snap" });
  }
  return rows;
}

export async function search(query: string): Promise<AppRow[]> {
  await requireAnyBackend();
  const out: AppRow[] = [];
  if (await hasFlatpak()) {
    const r = await run("flatpak", ["search", query, "--columns=name,application,version"]);
    if (r.code === 0) out.push(...parseFlatpakSearch(r.stdout));
  }
  if (await hasSnap()) {
    const r = await run("snap", ["find", query]);
    if (r.code === 0) out.push(...parseSnapFind(r.stdout));
  }
  return out;
}

/**
 * Аварийный seed на случай, если Flathub API недоступен ВООБЩЕ на первом
 * запуске (нет сети) — до этого момента дожидаться нечего, а показать пустой
 * Store нельзя. В нормальных условиях реальный, живой каталог с проверенными
 * app-id, названиями и категориями приходит из fetchFlathubCatalog() ниже
 * (см. startIndexing()) — она дёргает официальный REST API Flathub
 * (https://flathub.org/api/v2/collection/{popular,category/<cat>}), а не
 * список, вручную угаданный по памяти. Этот список НЕ обновляется тем же
 * путём и может отставать/содержать переименованные id — он существует
 * только для первой отрисовки Store до завершения фоновой индексации.
 */
const FALLBACK_SEED: [string, string, string][] = [
  ["Firefox", "org.mozilla.firefox", "Browser"],
  ["Chromium", "org.chromium.Chromium", "Browser"],
  ["Brave Browser", "com.brave.Browser", "Browser"],
  ["Opera", "com.opera.Opera", "Browser"],
  ["Visual Studio Code", "com.visualstudio.code", "Dev Tools"],
  ["GitHub Desktop", "io.github.shiftey.Desktop", "Dev Tools"],
  ["Postman", "com.getpostman.Postman", "Dev Tools"],
  ["VLC", "org.videolan.VLC", "Media"],
  ["OBS Studio", "com.obsproject.Studio", "Media"],
  ["Audacity", "org.audacityteam.Audacity", "Media"],
  ["GIMP", "org.gimp.GIMP", "Media"],
  ["Kdenlive", "org.kde.kdenlive", "Media"],
  ["Spotify", "com.spotify.Client", "Media"],
  ["Discord", "com.discordapp.Discord", "Comms"],
  ["Telegram", "org.telegram.desktop", "Comms"],
  ["Signal", "org.signal.Signal", "Comms"],
  ["Slack", "com.slack.Slack", "Comms"],
  ["Zoom", "us.zoom.Zoom", "Comms"],
  ["Thunderbird", "org.mozilla.Thunderbird", "Comms"],
  ["KeePassXC", "org.keepassxc.KeePassXC", "Security"],
  ["qBittorrent", "org.qbittorrent.qBittorrent", "Media"],
  ["LibreOffice", "org.libreoffice.LibreOffice", "Office"],
  ["OnlyOffice Desktop Editors", "org.onlyoffice.desktopeditors", "Office"],
  ["Wireshark", "org.wireshark.Wireshark", "Dev Tools"],
];

export function seed(): AppSeedRow[] {
  return FALLBACK_SEED.map(([name, id, category]) => ({
    name,
    id: `flatpak:${id}`,
    version: "",
    source: "flatpak",
    category,
  }));
}

/* ------------------------- Живой каталог Flathub (REST API v2) ------------------------- */

const FLATHUB_API = "https://flathub.org/api/v2";
/** Полный официальный список категорий Flathub — проверено живым запросом
 * к /collection/category 2026-09-29 (13:xx), см. отчёт прохода. */
const FLATHUB_CATEGORIES = [
  "audiovideo", "development", "education", "healthfitness",
  "game", "graphics", "network", "office", "science", "system", "utility",
];
/** Приблизительное сведение таксономии Flathub к категориям, которые уже
 * понимает фильтр на странице Store (см. CATEGORIES в StorePage.tsx). */
const FLATHUB_CATEGORY_LABEL: Record<string, string> = {
  audiovideo: "Media",
  development: "Dev Tools",
  education: "Other",
  healthfitness: "Other",
  game: "Other",
  graphics: "Media",
  network: "Comms",
  office: "Office",
  science: "Other",
  system: "Utilities",
  utility: "Utilities",
};
/** Flathub не выделяет браузеры отдельной категорией (они лежат в "network"
 * вместе с мессенджерами/torrent-клиентами) — несколько самых частых id
 * переопределяем вручную, чтобы фильтр "Browser" не был пустым. */
const KNOWN_BROWSER_APP_IDS = new Set([
  "org.mozilla.firefox", "org.chromium.Chromium", "com.brave.Browser", "com.opera.Opera",
  "com.microsoft.Edge", "org.gnome.Epiphany", "io.github.zen_browser.zen",
  "one.ablaze.floorp", "net.mullvad.MullvadBrowser", "org.qutebrowser.qutebrowser",
]);

interface FlathubHit {
  app_id: string;
  name: string;
  main_categories?: string;
}
interface FlathubSearchResponse {
  hits?: FlathubHit[];
}

async function fetchFlathubJson(pathAndQuery: string): Promise<FlathubSearchResponse> {
  const res = await fetch(`${FLATHUB_API}${pathAndQuery}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`flathub_http_${res.status}`);
  return (await res.json()) as FlathubSearchResponse;
}

function flathubHitToRow(hit: FlathubHit): AppSeedRow {
  const category = KNOWN_BROWSER_APP_IDS.has(hit.app_id)
    ? "Browser"
    : FLATHUB_CATEGORY_LABEL[hit.main_categories || ""] || "Other";
  return { name: hit.name, id: `flatpak:${hit.app_id}`, version: "", source: "flatpak", category };
}

/**
 * Реальный каталог Flathub: "популярное" + все 11 официальных категорий,
 * объединённые по app_id (без дублей). Каждая категория запрашивается
 * отдельно и независимо — сбой одной (сеть моргнула на середине) не должен
 * лишать пользователя остальных десяти, поэтому ошибки внутри цикла гасятся
 * и логируются по отдельности, а не прерывают всю индексацию.
 */
async function fetchFlathubCatalog(): Promise<AppSeedRow[]> {
  const seen = new Map<string, AppSeedRow>();
  try {
    const popular = await fetchFlathubJson("/collection/popular");
    for (const h of popular.hits || []) seen.set(h.app_id, flathubHitToRow(h));
  } catch (e) {
    logger.error("appstore.flathub_popular_failed", { error: (e as Error).message });
  }
  for (const cat of FLATHUB_CATEGORIES) {
    try {
      const r = await fetchFlathubJson(`/collection/category/${cat}`);
      for (const h of r.hits || []) if (!seen.has(h.app_id)) seen.set(h.app_id, flathubHitToRow(h));
    } catch (e) {
      logger.error("appstore.flathub_category_failed", { category: cat, error: (e as Error).message });
    }
  }
  return [...seen.values()];
}

function splitSourceId(prefixedId: string): { source: "flatpak" | "snap"; id: string } {
  if (prefixedId.startsWith("snap:")) return { source: "snap", id: prefixedId.slice(5) };
  if (prefixedId.startsWith("flatpak:")) return { source: "flatpak", id: prefixedId.slice(8) };
  // Без префикса (например, id пришёл откуда-то ещё) — считаем flatpak, это основной бэкенд.
  return { source: "flatpak", id: prefixedId };
}

/**
 * Установка без интерактивных вопросов: flatpak --system обычно требует root
 * (тот же уровень прав, что и `apt install`) — элевация через pkexec (Polkit),
 * тот же приём, что в killSwitchLinux/zapretLinux. snap install всегда root.
 */
export async function install(prefixedId: string): Promise<{ ok: boolean; id: string; tail: string }> {
  const { source, id } = splitSourceId(prefixedId);
  if (source === "snap") {
    const r = await run("pkexec", ["snap", "install", id]);
    logger.action("appstore.install", { id: prefixedId, source, code: r.code });
    return { ok: r.code === 0, id: prefixedId, tail: r.stdout.slice(-2000) };
  }
  const r = await run("pkexec", ["flatpak", "install", "-y", "flathub", id]);
  logger.action("appstore.install", { id: prefixedId, source, code: r.code });
  return { ok: r.code === 0, id: prefixedId, tail: r.stdout.slice(-2000) };
}

/**
 * winget умеет скачать установщик без установки — у flatpak/snap нет прямого
 * аналога («скачать .flatpak-бандл» — это отдельный экспорт с сервера
 * приложения, не общий кейс для произвольного пакета). Честно отказываем,
 * а не имитируем работу: вызывающий код (routes/apps.js) уже оборачивает
 * все методы в try/catch и превращает исключение в понятный HTTP-ответ.
 */
export async function downloadPackage(id: string): Promise<never> {
  throw new Error(
    "not_supported_on_linux: скачивание установщика без установки недоступно для flatpak/snap " +
      `(id=${id}) — используйте install()`,
  );
}

let indexState: AppIndexState = { state: "none", done: 0, total: 0, current: "" };
let indexRun: Promise<AppIndexState> | null = null;

export function indexStatus(): AppIndexState & { cached: number } {
  return { ...indexState, cached: readIndex()?.length || 0 };
}

export function readIndex(): AppRow[] | null {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Полный каталог: сначала реальный список app-id/названий/категорий с
 * официального REST API Flathub (fetchFlathubCatalog — не зависит от того,
 * установлен ли flatpak вообще, каталог можно листать даже до его
 * установки), затем, если flatpak в PATH есть, версии дополняются из
 * `flatpak remote-ls` (единственное, чего нет в ответе API). Сбой первого
 * источника не должен убивать второй и наоборот — оба обёрнуты отдельно.
 * В отличие от winget (нет полного листинга, только посимвольный перебор),
 * здесь оба источника отдают весь каталог одним вызовом — индексация
 * одношаговая, без перебора букв.
 */
export function startIndexing(): Promise<AppIndexState> {
  if (indexRun) return indexRun;
  indexState = { state: "indexing", done: 0, total: 2, current: "flathub" };
  indexRun = (async () => {
    let rows: AppSeedRow[] = [];
    try {
      rows = await fetchFlathubCatalog();
      logger.info("appstore.flathub_catalog_done", { count: rows.length });
    } catch (e) {
      logger.error("appstore.flathub_catalog_failed", { error: (e as Error).message });
    }
    indexState = { ...indexState, done: 1, current: "flatpak-versions" };
    try {
      if (await hasFlatpak()) {
        const r = await run("flatpak", ["remote-ls", "flathub", "--app", "--columns=application,version"]);
        if (r.code === 0) {
          const versionById = new Map<string, string>();
          for (const raw of r.stdout.split(/\r?\n/)) {
            const [id, version] = raw.split("\t");
            if (id && id.includes(".")) versionById.set(id.trim(), (version || "").trim());
          }
          rows = rows.map((row) => {
            const bareId = row.id.startsWith("flatpak:") ? row.id.slice(8) : row.id;
            const v = versionById.get(bareId);
            return v ? { ...row, version: v } : row;
          });
        }
      }
    } catch (e) {
      logger.error("appstore.flatpak_versions_failed", { error: (e as Error).message });
    }
    if (rows.length) fs.writeFileSync(INDEX_FILE, JSON.stringify(rows), "utf8");
    indexState = { state: "ready", done: 2, total: 2, current: "" };
    return indexState;
  })();
  return indexRun;
}

/**
 * Выделено из main.ts при разбиении крупного файла (поведение не менялось).
 */
import { session, ipcMain, BrowserWindow } from "electron";
import { mlog } from "./mainCore";

/* ------------------ Окно входа на форум (Cloudflare) ------------------
 * ПРОБЛЕМА: rutracker закрыт Cloudflare Bot Management — `tracker.php` и
 * `login.php` отдают страницу-проверку всем, кто не похож на браузер (проверено:
 * Node/undici получает 403 на tracker.php, хотя index.php отдаётся). Взять куки из
 * браузера пользователя тоже нельзя: Chrome/Edge 127+ шифруют их app-bound ключом
 * (v20), который доступен только самому браузеру.
 *
 * РЕШЕНИЕ: вход выполняется в Chromium САМОГО приложения. Куки остаются в его
 * session (расшифровка не нужна — их отдаёт Chromium), а прокси у окна тот же, что
 * у поиска, поэтому cf_clearance выдан тому же IP. Дальше скрапер ходит на форум
 * через сетевой стек этой же сессии (server/ts/trackerScraper.ts, chromiumSession).
 */
const TRACKER_PARTITION = "persist:moonapp-tracker";

/**
 * Кука, которой форум отмечает РЕАЛЬНЫЙ вход (rutracker: `bb_data`).
 *
 * `bb_guid`, `bb_ssl`, `bb_session` форум ставит и гостю, `bb_t` — трекинг. Если
 * считать входом их, окно закрывается сразу после проверки Cloudflare (пользователь
 * не успевает войти), а поиск уходит гостем — именно это и ломало поиск раздач.
 * Та же константа в server/ts/trackerScraper.ts (LOGIN_COOKIES).
 */
const TRACKER_LOGIN_COOKIE = "bb_data";

/**
 * UA для сессии форума: ОБЫЧНЫЙ Chrome без примет приложения.
 *
 * Зачем: у Chromium приложения по умолчанию UA вида
 * «…Chrome/126.0.6478.234 Electron/31.0.0 …» — Cloudflare считает такой отпечаток
 * ботом и отдаёт «Just a moment…» даже реальному браузеру. Собираем UA из
 * НАСТОЯЩЕЙ версии Chromium приложения, поэтому отпечаток остаётся достоверным.
 */
function trackerChromeUa() {
  const v = process.versions.chrome || "126.0.0.0";
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    `(KHTML, like Gecko) Chrome/${v} Safari/537.36`
  );
}

/** Сессия окна входа: та же, что использует скрапер форума. */
export function trackerSession() {
  return session.fromPartition(TRACKER_PARTITION);
}

/**
 * Куки форума из сессии окна входа.
 *
 * БЕРЁМ ВСЕ куки раздела и фильтруем по домену, а не запросом `{url}`: у
 * rutracker.org куки сессии (bb_data и др.) выставлены с `Path=/forum/`, поэтому
 * фильтр по URL с путём «/» их не возвращает — вход считался невыполненным.
 */
async function trackerCookies(ses: any, origin: any) {
  let list;
  try {
    list = await ses.cookies.get({});
  } catch {
    return [];
  }
  let host = "";
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    /* нет хоста — вернём всё, что есть */
  }
  if (!host) return list;
  return list.filter((c: any) => {
    const d = String(c.domain || "")
      .replace(/^\./, "")
      .toLowerCase();
    return !d || d === host || d.endsWith("." + host) || host.endsWith("." + d);
  });
}

ipcMain.handle("tracker:login-window", async (_e, opts) => {
  const url = String((opts && opts.url) || "");
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "bad_url" };
  const origin = new URL(url).origin;
  const ses = trackerSession();
  const rules = opts && opts.proxyRules ? String(opts.proxyRules) : null;
  // UA: либо заданный пользователем (приходит из настроек форума), либо обычный
  // Chrome от версии Chromium приложения — без «Electron/…» в отпечатке.
  const ua = String((opts && opts.userAgent) || "").trim() || trackerChromeUa();
  try {
    // Прокси тот же, что у поиска (per-page решение бэкенда) — иначе cf_clearance
    // был бы выдан другому IP и наши запросы снова получили бы проверку.
    await ses.setProxy(
      rules
        ? { mode: "fixed_servers", proxyRules: rules, proxyBypassRules: "<local>" }
        : { mode: "direct" },
    );
  } catch (e: any) {
    mlog("error", "tracker.login_proxy_failed", { error: e?.message || String(e) });
  }
  try {
    // Тот же UA ставим и сессии: её же сетевой стек использует скрапер
    // (session.fetch), поэтому cf_clearance, выданный окну, подходит и поиску.
    await ses.setUserAgent(ua, "ru-RU,ru;q=0.9,en;q=0.8");
  } catch (e: any) {
    mlog("error", "tracker.login_ua_failed", { error: e?.message || String(e) });
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 840,
    title: "Вход на форум — MoonApp",
    autoHideMenuBar: true,
    webPreferences: {
      partition: TRACKER_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  return await new Promise<any>((resolve) => {
    let settled = false;
    let poll: any = null;
    let lastPhase = "";
    const pick: any = async (reason: any) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      const list = await trackerCookies(ses, origin);
      const names = list.map((c: any) => c.name);
      // Признак РЕАЛЬНОГО входа — только bb_data: bb_guid/bb_ssl/bb_session форум
      // ставит и гостю (по ним окно закрывалось сразу после проверки Cloudflare,
      // не давая войти), bb_t — вообще трекинг.
      const loggedIn = names.includes(TRACKER_LOGIN_COOKIE);
      const hasCf = names.includes("cf_clearance");
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        /* уже закрыто */
      }
      mlog("action", "tracker.login_window", {
        reason,
        cookies: names.length,
        names,
        loggedIn,
        hasCf,
        ua,
        proxy: rules || "direct",
      });
      // Куки вообще не появились (Cloudflare не пропустил / вход не завершён):
      // это не «успех с пустыми куками» — UI должен сказать, что делать.
      if (!names.length) {
        resolve({ ok: false, error: "no_cookies", reason, loggedIn: false, hasCf: false });
        return;
      }
      resolve({
        ok: true,
        reason,
        loggedIn,
        hasCf,
        names,
        userAgent: ua,
        cookieHeader: list.map((c: any) => `${c.name}=${c.value}`).join("; "),
      });
    };

    /**
     * Ждём РЕАЛЬНОГО входа: пока в куках нет bb_data, окно не закрываем — иначе
     * пользователь не успевает пройти проверку Cloudflare и ввести логин/пароль.
     * Состояние показываем в заголовке окна (в саму страницу Cloudflare лезть
     * нельзя — это сломало бы проверку).
     */
    poll = setInterval(async () => {
      const list = await trackerCookies(ses, origin);
      const names = new Set(list.map((c: any) => c.name));
      if (names.has(TRACKER_LOGIN_COOKIE)) {
        void pick("logged_in");
        return;
      }
      const phase = names.has("cf_clearance") ? "cf_passed" : "challenge";
      if (phase !== lastPhase) {
        lastPhase = phase;
        mlog("info", "tracker.login_window_phase", {
          phase,
          cookies: names.size,
          hasCf: names.has("cf_clearance"),
        });
        try {
          if (!win.isDestroyed()) {
            win.setTitle(
              phase === "cf_passed"
                ? "Вход на форум — проверка пройдена, войдите (логин/пароль)"
                : "Вход на форум — пройдите проверку Cloudflare",
            );
          }
        } catch {
          /* окно уже закрыто */
        }
      }
    }, 1200);
    win.on("closed", () => void pick("closed"));
    setTimeout(() => void pick("timeout"), 15 * 60 * 1000);
    win.loadURL(url).catch(() => void pick("load_failed"));
  });
});

// --- Встроенный прокси: глобальный прокси Chromium ---
// Ядро (sing-box) слушает локальный SOCKS5/HTTP. Здесь мы заворачиваем ВЕСЬ
// сетевой стек Chromium (картинки-превью, внешние ресурсы) в этот прокси.
// Локальные адреса (<local> = 127.0.0.1/::1/localhost) всегда идут мимо —
// иначе фронт ушёл бы в петлю на собственный API Express.
// Per-page фильтрация на уровне Chromium невозможна (все страницы SPA с одного
// origin) — она реализована в backend по API-роутам (см. server/db.js ppr*).
ipcMain.handle("proxy:apply-session", async (_e, cfg) => {
  try {
    const rules = cfg && cfg.proxyRules ? String(cfg.proxyRules) : null;
    if (rules) {
      await session.defaultSession.setProxy({
        mode: "fixed_servers",
        proxyRules: rules,
        proxyBypassRules: "<local>",
      });
      // Окно входа на форум ходит через тот же прокси: иначе Cloudflare выдал бы
      // cf_clearance для другого IP, и поиск снова получал бы страницу-проверку.
      await trackerSession().setProxy({
        mode: "fixed_servers",
        proxyRules: rules,
        proxyBypassRules: "<local>",
      });
    } else {
      await session.defaultSession.setProxy({ mode: "direct" });
      await trackerSession().setProxy({ mode: "direct" });
    }
    mlog("action", "proxy.apply_session", { rules: rules || "direct" });
    return { ok: true, proxyRules: rules };
  } catch (e: any) {
    mlog("error", "proxy.apply_session_failed", { error: e?.message || String(e) });
    return { ok: false, error: e?.message || String(e) };
  }
});

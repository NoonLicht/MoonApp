/**
 * Поиск через настоящий движок Chromium приложения: скрытое окно открывает страницу выдачи так же,
 * как это сделал бы пользователь, поэтому поисковики не принимают его за бота (в отличие от
 * запросов из Node). Работает только внутри Electron; в остальных случаях бросает `no_browser`,
 * и поиск переходит к запасным источникам.
 */
export interface BrowserHit {
  title: string;
  url: string;
  snippet: string;
}

type Engine = "duckduckgo" | "bing" | "brave";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** Адрес выдачи и скрипт, который достаёт результаты из страницы. */
function plan(engine: Engine, q: string, lang: string): { url: string; script: string } {
  const text = encodeURIComponent(q);
  if (engine === "duckduckgo")
    return {
      url: `https://html.duckduckgo.com/html/?q=${text}&kl=${lang === "ru" ? "ru-ru" : "wt-wt"}`,
      script: `(() => [...document.querySelectorAll('.result')].map(r => {
        const a = r.querySelector('.result__a');
        return a ? { title: a.textContent.trim(), url: a.href, snippet: (r.querySelector('.result__snippet')?.textContent || '').trim() } : null;
      }).filter(Boolean))()`,
    };
  if (engine === "brave")
    return {
      url: `https://search.brave.com/search?q=${text}&source=web`,
      script: `(() => [...document.querySelectorAll('.snippet')].map(r => {
        const a = r.querySelector('a[href^="http"]');
        return a && !a.href.includes('search.brave.com') ? { title: (r.querySelector('.search-snippet-title')?.innerText || a.innerText || '').trim(), url: a.href, snippet: (r.querySelector('.generic-snippet .content, .snippet-description')?.innerText || '').trim() } : null;
      }).filter(Boolean))()`,
    };
  return {
    url: `https://www.bing.com/search?q=${text}&setlang=${encodeURIComponent(lang || "en")}`,
    script: `(() => [...document.querySelectorAll('li.b_algo')].map(r => {
      const a = r.querySelector('h2 a');
      return a ? { title: (r.querySelector('h2')?.innerText || '').trim(), url: a.href, snippet: (r.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, p')?.innerText || '').trim() } : null;
    }).filter(Boolean))()`,
  };
}

/** Редиректы поисковиков → настоящий адрес (DuckDuckGo: uddg=…, Bing: u=a1<base64url>). */
export function realUrl(href: string): string {
  try {
    const u = new URL(href);
    const dd = u.searchParams.get("uddg");
    if (dd) return dd;
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.startsWith("/ck/")) {
      const v = u.searchParams.get("u") ?? "";
      if (v.startsWith("a1")) {
        const b = v.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        return Buffer.from(b, "base64").toString("utf8");
      }
    }
    return href;
  } catch {
    return "";
  }
}

export async function browserSearch(
  engine: Engine,
  q: string,
  lang: string,
  n: number,
): Promise<BrowserHit[]> {
  if (!process.versions.electron) throw new Error("no_browser");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BrowserWindow, app } = require("electron") as typeof import("electron");
  if (!app.isReady()) await app.whenReady();
  const { url, script } = plan(engine, q, lang);
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: {
      partition: "moonapp-websearch",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    win.webContents.setUserAgent(CHROME_UA);
    // Всплывающие окна и переходы по ссылкам выдачи не нужны.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await Promise.race([
      win.loadURL(url),
      new Promise((_r, rej) => setTimeout(() => rej(new Error("search_timeout")), 15000)),
    ]);
    const raw = (await win.webContents.executeJavaScript(script, true)) as BrowserHit[];
    const seen = new Set<string>();
    const out: BrowserHit[] = [];
    for (const h of Array.isArray(raw) ? raw : []) {
      const real = realUrl(String(h.url));
      if (!/^https?:\/\//.test(real) || seen.has(real)) continue;
      seen.add(real);
      out.push({
        title: String(h.title).slice(0, 200),
        url: real,
        snippet: String(h.snippet).slice(0, 400),
      });
      if (out.length >= n) break;
    }
    if (!out.length) throw new Error("search_empty");
    return out;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

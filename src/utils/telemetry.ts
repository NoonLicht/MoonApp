/**
 * Полный клиентский журнал приложения.
 *
 * Пишет события в POST /api/log батчами: сервер кладёт их в logs/audit.log
 * (полный журнал без фильтров), а оттуда они попадают в диагностический файл,
 * который собирает кнопка «Собрать логи» в Настройках.
 *
 * Что пишем: нажатия (с описанием элемента), изменение полей (значения
 * маскируются для паролей), переходы между страницами, горячие клавиши,
 * ошибки JS и необработанные промисы, сбои сети, старт/закрытие окна, онлайн.
 * Чего НЕ пишем: содержимое полей type=password.
 */

type Ev = { level: string; event: string; data?: unknown };

const FLUSH_INTERVAL_MS = 1500;
const FLUSH_AT = 40;     // отправляем, не дожидаясь таймера
const MAX_BATCH = 200;   // ограничение на размер пачки

let queue: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let currentPage = "unknown";
let started = false;

function token(): string | null {
  try { return window.appBridge?.getToken?.() ?? null; } catch { return null; }
}

function push(level: string, event: string, data?: unknown) {
  queue.push({ level, event, data });
  if (queue.length >= FLUSH_AT) { void flush(); return; }
  if (!timer) timer = setTimeout(() => { void flush(); }, FLUSH_INTERVAL_MS);
}

async function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length) return;
  const events = queue.slice(0, MAX_BATCH);
  queue = queue.slice(events.length);
  try {
    const t = token();
    await fetch("/api/log", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...(t ? { "x-pa-token": t } : {}) },
      body: JSON.stringify({ events }),
    });
  } catch { /* журнал не должен ломать интерфейс */ }
  if (queue.length) timer = setTimeout(() => { void flush(); }, FLUSH_INTERVAL_MS);
}

/** Записать событие в полный журнал. */
export function logEvent(level: "action" | "info" | "warn" | "error", event: string, data?: unknown) {
  try { push(level, event, data); } catch { /* ignore */ }
}

/** Текущая страница (логируется при смене и добавляется в описание кликов). */
export function setCurrentPage(id: string) {
  if (id === currentPage) return;
  currentPage = id;
  logEvent("action", "ui.page", { page: id });
}

export function getCurrentPage() {
  return currentPage;
}

/**
 * Снимок локальных настроек интерфейса — отправляется кнопкой «Собрать логи»
 * ПЕРЕД сборкой файла. В отчёт попадает то, что не хранится в settings.json:
 * ключи localStorage (прогресс панели задач, флаги страниц и т.п.), размеры
 * окна, текущая страница. Значения ключей с именами вида key/token/secret/
 * password маскируются, длинные значения обрезаются.
 */
export async function snapshotUiSettings(): Promise<void> {
  const store: Record<string, unknown> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const raw = localStorage.getItem(k) ?? "";
      if (/key|token|secret|password|passwd|apikey/i.test(k)) {
        store[k] = `***(${raw.length} симв.)`;
        continue;
      }
      if (raw.length > 2000) {
        store[k] = raw.slice(0, 2000) + `…(обрезано, всего ${raw.length} симв.)`;
        continue;
      }
      try { store[k] = JSON.parse(raw); } catch { store[k] = raw; }
    }
  } catch { /* localStorage недоступен — пропускаем */ }

  const data = {
    page: currentPage,
    localStorage: store,
    window: {
      inner: `${window.innerWidth}x${window.innerHeight}`,
      outer: `${window.outerWidth}x${window.outerHeight}`,
      dpr: window.devicePixelRatio,
    },
    lang: document.documentElement?.lang || navigator.language,
    url: location.pathname + location.hash,
    keys: Object.keys(store),
  };
  push("action", "ui.settings.snapshot", data);
  await flush();
}

/* --- Описание элемента, по которому кликнули/вводили --- */
function describeElement(el: Element | null): Record<string, unknown> | null {
  if (!el || !(el instanceof Element)) return null;
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let i = 0; i < 3 && cur; i++) {
    let s = cur.tagName.toLowerCase();
    if (cur.id) s += "#" + cur.id;
    else if (cur.classList.length) s += "." + [...cur.classList].slice(0, 2).join(".");
    parts.unshift(s);
    cur = cur.parentElement;
  }
  const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const out: Record<string, unknown> = { page: currentPage, target: parts.join(" > "), text };
  for (const a of ["title", "aria-label", "placeholder", "name", "type", "href"]) {
    const v = el.getAttribute(a);
    if (v) out[a] = v.slice(0, 120);
  }
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    const input = el as HTMLInputElement;
    out.field = input.name || input.id || null;
    // Значения полей пишем (полезно для «что ввёл»), но пароли — только длиной.
    out.value = input.type === "password"
      ? `***(${String(input.value || "").length})`
      : String(input.value || "").slice(0, 120);
  }
  return out;
}

function clickHandler(ev: MouseEvent) {
  const el = ev.target as Element | null;
  if (!el) return;
  logEvent("action", "ui.click", {
    ...describeElement(el),
    x: Math.round(ev.clientX),
    y: Math.round(ev.clientY),
    button: ev.button,
  });
}

function changeHandler(ev: Event) {
  const el = ev.target as Element | null;
  if (!el) return;
  const tag = el.tagName.toLowerCase();
  if (["input", "select", "textarea"].includes(tag)) {
    logEvent("action", "ui.change", describeElement(el));
  }
}

function keyHandler(ev: KeyboardEvent) {
  // Пишем только сочетания с модификаторами: текст, набранный в полях,
  // уже попадает в ui.change, а логировать каждую букву — шум.
  if (!ev.ctrlKey && !ev.altKey && !ev.metaKey) return;
  const combo = [
    ev.ctrlKey && "Ctrl", ev.altKey && "Alt", ev.metaKey && "Meta", ev.shiftKey && "Shift", ev.key,
  ].filter(Boolean).join("+");
  logEvent("action", "ui.hotkey", { page: currentPage, combo });
}

function errorHandler(ev: ErrorEvent) {
  logEvent("error", "ui.error", {
    page: currentPage,
    message: String(ev.message || "").slice(0, 500),
    source: ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : null,
    stack: ev.error?.stack ? String(ev.error.stack).slice(0, 2000) : null,
  });
}

function rejectionHandler(ev: PromiseRejectionEvent) {
  const r = ev.reason;
  logEvent("error", "ui.unhandledRejection", {
    page: currentPage,
    message: String(r?.message || r || "").slice(0, 500),
    stack: r?.stack ? String(r.stack).slice(0, 2000) : null,
  });
}

/** Перехват console.warn/error: всё, что пишут страницы, тоже в журнал. */
function hookConsole() {
  for (const lvl of ["warn", "error"] as const) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...args: unknown[]) => {
      try {
        logEvent(lvl === "error" ? "error" : "warn", "ui.console", {
          page: currentPage,
          level: lvl,
          args: args.map((a) => {
            if (a instanceof Error) return { message: a.message, stack: String(a.stack || "").slice(0, 2000) };
            if (typeof a === "string") return a.slice(0, 500);
            try { return JSON.parse(JSON.stringify(a)); } catch { return String(a).slice(0, 500); }
          }),
        });
      } catch { /* ignore */ }
      orig(...args);
    };
  }
}

/** Однократная установка всех слушателей. Вызывается из App.tsx. */
export function initTelemetry() {
  if (started || typeof window === "undefined") return;
  started = true;
  hookConsole();
  document.addEventListener("click", clickHandler, true);
  document.addEventListener("change", changeHandler, true);
  window.addEventListener("keydown", keyHandler, true);
  window.addEventListener("error", errorHandler);
  window.addEventListener("unhandledrejection", rejectionHandler);
  window.addEventListener("online", () => logEvent("info", "app.online"));
  window.addEventListener("offline", () => logEvent("warn", "app.offline"));
  document.addEventListener("visibilitychange", () =>
    logEvent("action", "app.visibility", { state: document.visibilityState, page: currentPage }));
  window.addEventListener("beforeunload", () => {
    logEvent("info", "app.unload", { page: currentPage });
    void flush();
  });
  logEvent("info", "app.ready", {
    ua: navigator.userAgent,
    lang: navigator.language,
    screen: `${window.screen.width}x${window.screen.height}`,
    dpr: window.devicePixelRatio,
  });
}

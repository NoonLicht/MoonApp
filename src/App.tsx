import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Sun, Moon, Contrast, Minus, Square, X, Shield, FolderOpen } from "lucide-react";
import { I18nProvider, useI18n } from "./i18n";
import { ContextMenuProvider } from "./components/ContextMenu";
import { ToolbarContext, PageHostContext, PageBusyContext } from "./components/Toolbar";
import {
  evictPages,
  touchPage,
  samePages,
  KEEP_ALIVE_DEFAULT_LIMIT,
  KEEP_ALIVE_DEFAULT_IDLE_MIN,
} from "./utils/pageCache";
import { initTelemetry, setCurrentPage } from "./utils/telemetry";
import ProxyPanel from "./components/ProxyPanel";
import { api } from "./api/client";
import { PAGES } from "./navigation";
import type { PageId } from "./navigation";

// Стили
import "./styles/theme.css";
import "./styles/ui.css";
import "./styles/pages.css";
import "./styles/chat.css";
import "./styles/dock.css";
import "./styles/settings.css";
import "./styles/notes.css";
import "./styles/lecture.css";
import "./styles/bypass.css";
import "./styles/movies.css";

// Страницы
import StorePage from "./pages/StorePage";
import ConverterPage from "./pages/ConverterPage";
import CompressorPage from "./pages/CompressorPage";
import VideoPage from "./pages/VideoPage";
import MusicPage from "./pages/MusicPage";
import BooksPage from "./pages/BooksPage";
import MonitorPage from "./pages/MonitorPage";
import AiChatPage from "./pages/AiChatPage";
import AudiobookTTSPage from "./pages/AudiobookTTSPage";
import ArchiverPage from "./pages/ArchiverPage";
import SettingsPage from "./pages/SettingsPage";
import MyspacePage from "./pages/MyspacePage";
import LectureRecorderPage from "./pages/LectureRecorderPage";
import BypassControlPage from "./pages/BypassControlPage";
import MoviesPage from "./pages/MoviesPage";

// Идентификаторы страниц и их перечень (PAGES) живут в src/navigation.ts —
// общий источник для дока приложения и списка «Стартовая страница» в настройках.

// Порядок перебора тем кнопкой в тулбаре (см. toggleTheme ниже):
// тёмная → OLED (чистый чёрный) → светлая → снова тёмная.
const THEME_CYCLE = ["dark", "oled", "light"] as const;

// Перечень страниц (порядок в доке + названия) — в src/navigation.ts.

const PAGE_COMPONENTS: Record<PageId, React.ComponentType> = {
  store: StorePage,
  convert: ConverterPage,
  compress: CompressorPage,
  video: VideoPage,
  movies: MoviesPage,
  music: MusicPage,
  books: BooksPage,
  monitor: MonitorPage,
  myspace: MyspacePage,
  aichat: AiChatPage,
  voice: AudiobookTTSPage,
  lecture: LectureRecorderPage,
  bypass: BypassControlPage,
  archive: ArchiverPage,
  settings: SettingsPage,
};

/**
 * Страницы в стопке обёрнуты в memo: ререндер оболочки (смена тулбара, счётчики
 * задач и т.п.) не должен перерисовывать скрытые страницы — они остаются
 * смонтированными, но «спящими». Контекст (id/active) при этом работает как надо.
 */
const MEMO_PAGE_COMPONENTS = (Object.keys(PAGE_COMPONENTS) as PageId[]).reduce(
  (acc, id) => {
    acc[id] = React.memo(PAGE_COMPONENTS[id]);
    return acc;
  },
  {} as Record<PageId, React.ComponentType>,
);

interface ShellProps {
  active: PageId;
  setActive: (id: PageId) => void;
  theme: string;
  toggleTheme: () => void;
  toolbarNodes: Record<string, React.ReactNode>;
  setPageToolbar: (id: string, node: React.ReactNode | null) => void;
  blur: boolean;
  accent: string;
  fontSize: number;
  reduceMotion: boolean;
  density: string;
  opaqueBg: boolean;
  proxyPanelVisible: boolean;
  setProxyPanelVisible: React.Dispatch<React.SetStateAction<boolean>>;
  keepPagesAlive: boolean;
  keepPagesLimit: number;
  unloadIdleMinutes: number;
}

/**
 * Обёртка одной «живой» страницы.
 *
 * Страницы держатся смонтированными (keep-alive), поэтому их состояния,
 * прогресс задач и позиции прокрутки сохраняются при переключении вкладок.
 * Неактивные скрываются через visibility (а не display:none) — так сохраняются
 * размеры (канвас/графики не «схлопываются») и scrollTop.
 */
function PageHost({
  id,
  active,
  children,
}: {
  id: PageId;
  active: boolean;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ id, active }), [id, active]);
  return (
    <div className={`page-host ${active ? "is-active" : ""}`} aria-hidden={!active}>
      <PageHostContext.Provider value={value}>{children}</PageHostContext.Provider>
    </div>
  );
}

function Shell({
  active,
  setActive,
  theme,
  toggleTheme,
  toolbarNodes,
  setPageToolbar,
  blur,
  accent,
  fontSize,
  reduceMotion,
  density,
  opaqueBg,
  proxyPanelVisible,
  setProxyPanelVisible,
  keepPagesAlive,
  keepPagesLimit,
  unloadIdleMinutes,
}: ShellProps) {
  const { t, lang } = useI18n();
  // Если активная страница была удалена или сохранена в настройках устаревшая
  // (например "todo"), откатываемся к первой доступной странице.
  const safeActive: PageId = PAGES.some((p) => p.id === active)
    ? active
    : ((PAGES[0]?.id as PageId) ?? "store");
  const activeMeta = PAGES.find((p) => p.id === safeActive)!;
  const MetaIcon = activeMeta.icon;
  const metaTitle = t(activeMeta.i18n);
  const toolbarNode = toolbarNodes[safeActive] ?? null;

  /* ── keep-alive ──
   * Посещённые страницы остаются смонтированными, чтобы состояние и прогресс
   * задач не терялись при переключении вкладок. Память ограничиваем:
   *   • LRU по количеству (keepPagesLimit);
   *   • выгрузкой простаивающих (unloadIdleMinutes);
   *   • активная и занятые (busyPages) страницы не выгружаются никогда. */
  const [alive, setAlive] = useState<PageId[]>([safeActive]);
  const [busyPages, setBusyPages] = useState<string[]>([]);
  const lastUsed = useRef<Record<string, number>>({ [safeActive]: Date.now() });

  const reportBusy = useCallback((id: string, busy: boolean) => {
    setBusyPages((prev) => {
      const has = prev.includes(id);
      if (busy === has) return prev;
      return busy ? [...prev, id] : prev.filter((x) => x !== id);
    });
  }, []);

  // Переключение вкладки: страница поднимается в начало списка (или список
  // схлопывается до одной, если keep-alive выключен пользователем).
  useEffect(() => {
    lastUsed.current[safeActive] = Date.now();
    setAlive((prev) => {
      if (!keepPagesAlive) return prev.length === 1 && prev[0] === safeActive ? prev : [safeActive];
      return prev[0] === safeActive ? prev : touchPage<PageId>(prev, safeActive);
    });
  }, [safeActive, keepPagesAlive]);

  // Периодическая уборка: лимит + простой. Раз в минуту, работы — на копейки.
  useEffect(() => {
    if (!keepPagesAlive) return undefined;
    const tick = () => {
      setAlive((prev) => {
        const next = evictPages<PageId>({
          alive: prev,
          active: safeActive,
          busy: busyPages,
          lastUsed: lastUsed.current,
          limit: keepPagesLimit,
          idleMs: Math.max(0, unloadIdleMinutes) * 60_000,
          now: Date.now(),
        });
        return samePages<PageId>(prev, next) ? prev : next;
      });
    };
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [keepPagesAlive, keepPagesLimit, unloadIdleMinutes, safeActive, busyPages]);

  // Слоты тулбара выгруженных страниц больше не нужны.
  useEffect(() => {
    for (const id of Object.keys(toolbarNodes)) {
      if (!alive.includes(id as PageId)) setPageToolbar(id, null);
    }
  }, [alive, toolbarNodes, setPageToolbar]);

  // В стопке всегда есть активная страница: список живых обновляется эффектом
  // ПОСЛЕ рендера, поэтому без этого добавления был бы пустой кадр при переходе.
  const stack = alive.includes(safeActive) ? alive : ([safeActive, ...alive] as PageId[]);

  // Классы/стили, управляемые разделом «Внешний вид»:
  //  - accent-* подменяет акцентный цвет (см. theme.css);
  //  - reduce-motion отключает анимации и blur-блобы;
  //  - density-compact уменьшает отступы списков;
  //  - fontSize задаёт базовый размер шрифта.
  const shellCls = [
    "app-shell",
    `theme-${theme}`,
    `accent-${accent}`,
    density === "compact" ? "density-compact" : "",
    reduceMotion ? "reduce-motion" : "",
    opaqueBg ? "opaque-bg" : "",
    blur ? "" : "no-blur",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={shellCls}
      style={{ fontSize: `${fontSize}px` }}
      dir={lang === "ar" ? "rtl" : "ltr"}
    >
      <div className="mesh" aria-hidden="true">
        <span className="blob blob-a" />
        <span className="blob blob-b" />
      </div>

      <PageBusyContext.Provider value={reportBusy}>
        <ToolbarContext.Provider value={setPageToolbar}>
          <header className="top-toolbar titlebar-drag">
            <div className="tb-side-left" aria-hidden="true" />
            <div className="tb-center">
              <div className="tb-title">
                <MetaIcon size={15} strokeWidth={2.2} />
                <span>{metaTitle}</span>
              </div>
              <div className="tb-dynamic">{toolbarNode}</div>
            </div>
            <div className="tb-side-right">
              {/* Открыть папку, где установлено приложение (см. electron/main.js → shell:open-app-dir). */}
              <button
                className="app-dir-toggle no-drag"
                onClick={() => window.appBridge?.openAppDir?.()}
                title={t("common.openAppDir")}
                aria-label={t("common.openAppDir")}
              >
                <FolderOpen size={15} />
              </button>
              <button
                className="proxy-toggle no-drag"
                onClick={() => setProxyPanelVisible((v) => !v)}
                title={t("proxy.title")}
              >
                <Shield size={15} />
              </button>
              <button
                className="theme-toggle no-drag"
                onClick={toggleTheme}
                title={t("common.theme")}
              >
                <Sun className="ico-sun" size={15} />
                <Moon className="ico-moon" size={15} />
                <Contrast className="ico-oled" size={15} />
              </button>
              <div className="win-controls no-drag">
                <button
                  className="win-btn"
                  onClick={() => window.appBridge?.minimize()}
                  title={t("common.minimize")}
                >
                  <Minus size={15} />
                </button>
                <button
                  className="win-btn"
                  onClick={() => window.appBridge?.toggleMaximize()}
                  title={t("common.maximize")}
                >
                  <Square size={12} />
                </button>
                <button
                  className="win-btn win-close"
                  onClick={() => window.appBridge?.close()}
                  title={t("common.close")}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          </header>

          {proxyPanelVisible && <ProxyPanel onClose={() => setProxyPanelVisible(false)} />}

          {/* Стопка живых страниц: активная видима, остальные скрыты, но сохраняют
            состояние (прогресс задач, ввод, позицию скролла). */}
          <main className="content-area">
            <div className="pages-stack">
              {stack.map((id) => (
                <PageHost key={id} id={id} active={id === safeActive}>
                  {React.createElement(MEMO_PAGE_COMPONENTS[id])}
                </PageHost>
              ))}
            </div>
          </main>

          {/* Хост порталов-оверлеев: сосед .content-area, поэтому у него снова
            работает z-index и модалки перекрывают верхнюю панель (см.
            src/components/overlayHost.ts). Когда порталов нет — узел пуст и
            прозрачен для кликов (pointer-events:none в theme.css). */}
          <div id="overlay-root" className="overlay-root" />
        </ToolbarContext.Provider>
      </PageBusyContext.Provider>

      <nav className="bottom-dock">
        <div className="dock-scroll">
          {PAGES.map((p) => {
            const Icon = p.icon;
            const isActive = p.id === active;
            return (
              <button
                key={p.id}
                className={`dock-btn ${isActive ? "is-active" : ""}`}
                onClick={() => setActive(p.id)}
                aria-label={t(p.i18n)}
                title={t(p.i18n)}
              >
                <span className="dock-icon">
                  <Icon size={18} strokeWidth={2} />
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState("dark");
  const [active, setActive] = useState<PageId>("store");
  const [lang, setLang] = useState("en");
  const [blur, setBlur] = useState(true);
  const [accent, setAccent] = useState("amber");
  const [fontSize, setFontSize] = useState(14);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [density, setDensity] = useState("comfortable");
  const [opaqueBg, setOpaqueBg] = useState(false);
  const [toolbarNodes, setToolbarNodes] = useState<Record<string, React.ReactNode>>({});
  const [proxyPanelVisible, setProxyPanelVisible] = useState(false);
  // keep-alive: держать ли страницы смонтированными и как ограничивать память.
  const [keepPagesAlive, setKeepPagesAlive] = useState(true);
  const [keepPagesLimit, setKeepPagesLimit] = useState(KEEP_ALIVE_DEFAULT_LIMIT);
  const [unloadIdleMinutes, setUnloadIdleMinutes] = useState(KEEP_ALIVE_DEFAULT_IDLE_MIN);

  // Слот тулбара: пишем по ключу страницы. null — удалить слот (страница выгружена).
  const setPageToolbar = useCallback((id: string, node: React.ReactNode | null) => {
    setToolbarNodes((prev) => {
      if (node === null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return prev[id] === node ? prev : { ...prev, [id]: node };
    });
  }, []);

  // Полный клиентский журнал: клики, навигация, ошибки, запросы к API.
  // События уходят в logs/audit.log и попадают в файл кнопки «Собрать логи».
  useEffect(() => {
    initTelemetry();
  }, []);

  // Смена страницы — в журнал (по какой странице ходил пользователь).
  useEffect(() => {
    setCurrentPage(active);
  }, [active]);

  // Подтягиваем тему, стартовую страницу, язык, blur и внешние вид из настроек.
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const sc = s as any;
        if (sc?.appearance?.theme) setTheme(sc.appearance.theme);
        // Стартовая страница: если в настройках что-то неизвестное (старый
        // settings.json, ручная правка) — открываем первую страницу «App»
        // (установщик приложений, id "store").
        const startPage = String(sc?.general?.startPage || "");
        setActive(PAGES.some((p) => p.id === startPage) ? (startPage as PageId) : "store");
        if (sc?.general?.language) setLang(sc.general.language);
        if (sc?.performance?.backgroundBlur != null) setBlur(!!sc.performance.backgroundBlur);
        // Внешний вид: акцент, размер шрифта, анимации, плотность.
        if (sc?.appearance?.accent) setAccent(sc.appearance.accent);
        if (sc?.appearance?.fontSize) setFontSize(Number(sc.appearance.fontSize) || 14);
        setReduceMotion(!!sc?.appearance?.reduceMotion);
        if (sc?.appearance?.density) setDensity(sc.appearance.density);
        setOpaqueBg(!!sc?.appearance?.opaqueBackground);
        // Производительность: keep-alive страниц.
        if (sc?.performance?.keepPagesAlive != null)
          setKeepPagesAlive(!!sc.performance.keepPagesAlive);
        if (sc?.performance?.keepPagesLimit != null)
          setKeepPagesLimit(
            Math.max(1, Number(sc.performance.keepPagesLimit) || KEEP_ALIVE_DEFAULT_LIMIT),
          );
        if (sc?.performance?.unloadIdleMinutes != null)
          setUnloadIdleMinutes(Math.max(0, Number(sc.performance.unloadIdleMinutes) || 0));
      })
      .catch(() => {});
  }, []);

  // Синхронизация изменений из страницы настроек: тема, язык, blur, внешний вид.
  useEffect(() => {
    const onTheme = (e: Event) => setTheme((e as CustomEvent<string>).detail);
    const onSetting = (e: Event) => {
      const { path, value } = (e as CustomEvent<{ path: string; value: unknown }>).detail || {};
      if (path === "general.language") setLang(value as string);
      else if (path === "performance.backgroundBlur") setBlur(!!value);
      else if (path === "performance.keepPagesAlive") setKeepPagesAlive(!!value);
      else if (path === "performance.keepPagesLimit")
        setKeepPagesLimit(Math.max(1, Number(value) || KEEP_ALIVE_DEFAULT_LIMIT));
      else if (path === "performance.unloadIdleMinutes")
        setUnloadIdleMinutes(Math.max(0, Number(value) || 0));
      else if (path === "appearance.accent") setAccent(String(value));
      else if (path === "appearance.fontSize") setFontSize(Number(value) || 14);
      else if (path === "appearance.reduceMotion") setReduceMotion(!!value);
      else if (path === "appearance.density") setDensity(String(value));
      else if (path === "appearance.opaqueBackground") setOpaqueBg(!!value);
    };
    window.addEventListener("app:theme", onTheme);
    window.addEventListener("app:setting", onSetting);
    return () => {
      window.removeEventListener("app:theme", onTheme);
      window.removeEventListener("app:setting", onSetting);
    };
  }, []);

  const toggleTheme = () => {
    // Кнопка в тулбаре листает все три темы: тёмная → OLED (чистый чёрный) →
    // светлая → снова тёмная. Выбор в настройках (appearance.theme) — точный.
    const i = THEME_CYCLE.indexOf(theme as (typeof THEME_CYCLE)[number]);
    const next = THEME_CYCLE[(i + 1) % THEME_CYCLE.length] || "dark";
    setTheme(next);
    api.updateSettings({ appearance: { theme: next } }).catch(() => {});
  };

  return (
    <I18nProvider lang={lang}>
      {/* Провайдер на всё приложение: одно глобальное контекстное меню. */}
      <ContextMenuProvider>
        <Shell
          active={active}
          setActive={setActive}
          theme={theme}
          toggleTheme={toggleTheme}
          toolbarNodes={toolbarNodes}
          setPageToolbar={setPageToolbar}
          blur={blur}
          accent={accent}
          fontSize={fontSize}
          reduceMotion={reduceMotion}
          density={density}
          opaqueBg={opaqueBg}
          proxyPanelVisible={proxyPanelVisible}
          setProxyPanelVisible={setProxyPanelVisible}
          keepPagesAlive={keepPagesAlive}
          keepPagesLimit={keepPagesLimit}
          unloadIdleMinutes={unloadIdleMinutes}
        />
      </ContextMenuProvider>
    </I18nProvider>
  );
}

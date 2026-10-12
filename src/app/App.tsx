import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import {
  Sun,
  Moon,
  Contrast,
  Minus,
  Square,
  X,
  Shield,
  FolderOpen,
  ListChecks,
  Sparkles,
} from "lucide-react";
import { I18nProvider, useI18n, storedLang } from "@/app/i18n";
import { ContextMenuProvider } from "@/components/ContextMenu";
import CommandPalette from "@/components/CommandPalette";
import ErrorBoundary from "@/components/ErrorBoundary";
import { ToolbarContext, PageHostContext, PageBusyContext } from "@/components/Toolbar";
import {
  evictPages,
  touchPage,
  samePages,
  KEEP_ALIVE_DEFAULT_LIMIT,
  KEEP_ALIVE_DEFAULT_IDLE_MIN,
} from "@/lib/pageCache";
import { initTelemetry, setCurrentPage } from "@/lib/telemetry";
import { startCompanionBridge } from "@/lib/companionBridge";
import ProxyPanel from "@/pages/bypass/parts/ProxyPanel";
import TaskManagerPanel from "@/components/TaskManagerPanel";
import WelcomeModal from "@/components/WelcomeModal";
import SystemStatsBar from "@/components/SystemStatsBar";
import GhostToggle from "@/components/GhostToggle";
import PrivacyShield from "@/components/PrivacyShield";
import NightBanner from "@/components/NightBanner";
import ModelToggle, { ModelPanel } from "@/components/ModelToggle";
import { api } from "@/api/client";
import { PAGES } from "@/app/navigation";
import { onOpenTarget } from "@/lib/deepLink";
import type { PageId } from "@/app/navigation";

// Стили
import "@/styles/theme.css";
import "@/styles/ui.css";
import "@/styles/pages.css";
import "@/styles/chat.css";
import "@/styles/dock.css";
import "@/styles/settings.css";
import "@/styles/notes.css";
import "@/styles/lecture.css";
import "@/styles/bypass.css";
import "@/styles/automation.css";
import "@/styles/budget.css";
import "@/styles/diary.css";
import "@/styles/rss.css";
import "@/styles/tuning.css";
import "@/styles/translate.css";
import "@/styles/movies.css";
import "@/styles/upscale.css";
import "@/styles/screenshots.css";
import "@/styles/fluent.css";
import CursorSpotlight from "@/components/CursorSpotlight";
import A11yFlags from "@/components/A11yFlags";

/** Окно открыто как «отдельная страница» (?solo=<id>): показываем её, без приветствия. */
const SOLO_PAGE: string = (() => {
  try {
    return new URLSearchParams(window.location.search).get("solo") ?? "";
  } catch {
    return "";
  }
})();

// Идентификаторы страниц и их перечень (PAGES) живут в src/navigation.ts —
// общий источник для дока приложения и списка «Стартовая страница» в настройках.

// Порядок перебора тем кнопкой в тулбаре (см. toggleTheme ниже):
// тёмная → midnight → OLED (чистый чёрный) → светлая → sand → снова тёмная.
// Кнопка листает все темы, а точный выбор — в настройках (appearance.theme).
const THEME_CYCLE = ["dark", "midnight", "oled", "light", "sand"] as const;

/**
 * «Семейство» темы: точечные правки CSS написаны для light/dark (иконка кнопки
 * темы, рамки и плейсхолдеры светлой темы). Новые темы наследуют семейство —
 * sand получает светлые правки, midnight — тёмные. У OLED своё оформление
 * (правила .theme-oled), поэтому семейство ему не добавляем: иначе кнопка темы
 * показывала бы луну вместо иконки контраста.
 */
/** Масштаб интерфейса (%): zoom корня масштабирует и шрифты, и таблицы, и отступы. */
import {
  applyDesign,
  applyGlass,
  applyLiquid,
  applyAnimSpeed,
  applyWindowOpacity,
  readLiquid,
  watchIdle,
} from "@/lib/designMode";
import "@/styles/liquidglass.css";
import "@/styles/motion.css";

function applyUiScale(v: unknown): void {
  const n = Math.min(150, Math.max(85, Number(v) || 100));
  (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(n / 100);
}

function themeFamily(theme: string): string {
  if (theme === "oled") return "";
  return theme === "light" || theme === "sand" ? "theme-light" : "theme-dark";
}

// Перечень страниц (порядок в доке + названия) — в src/navigation.ts.

/**
 * Загрузчики страниц. Каждая страница — отдельный чанк: раньше все 23 страницы
 * импортировались статически и попадали в один стартовый бандл (~4,4 МБ),
 * который парсился целиком ещё до первого кадра. Теперь при старте грузится
 * только оболочка и стартовая страница, остальные — при первом открытии
 * (или заранее, при наведении на кнопку дока — см. preloadPage).
 */
type PageModule = { default: React.ComponentType };
const PAGE_LOADERS: Record<PageId, () => Promise<PageModule>> = {
  store: () => import("@/pages/store/StorePage"),
  convert: () => import("@/pages/convert/ConverterPage"),
  compress: () => import("@/pages/compressor/CompressorPage"),
  upscale: () => import("@/pages/upscale/UpscalePage"),
  video: () => import("@/pages/video/VideoPage"),
  movies: () => import("@/pages/movies/MoviesPage"),
  music: () => import("@/pages/music/MusicPage"),
  books: () => import("@/pages/books/BooksPage"),
  monitor: () => import("@/pages/monitor/MonitorPage"),
  myspace: () => import("@/pages/myspace/MyspacePage"),
  diary: () => import("@/pages/diary/DiaryPage"),
  rss: () => import("@/pages/rss/RssPage"),
  aichat: () => import("@/pages/ai-chat/AiChatPage"),
  voice: () => import("@/pages/voice/AudiobookTTSPage"),
  lecture: () => import("@/pages/lecture/LectureRecorderPage"),
  bypass: () => import("@/pages/bypass/BypassControlPage"),
  tools: () => import("@/pages/tools/ToolsPage"),
  games: () => import("@/pages/games/GamesPage"),
  screenshots: () => import("@/pages/screenshots/ScreenshotsPage"),
  automation: () => import("@/pages/automation/AutomationPage"),
  budget: () => import("@/pages/budget/BudgetPage"),
  tuning: () => import("@/pages/tuning/TuningPage"),
  translate: () => import("@/pages/translate/TranslatePage"),
  archive: () => import("@/pages/archiver/ArchiverPage"),
  settings: () => import("@/pages/settings/SettingsPage"),
};

/** Один промис на страницу: повторные preload/lazy не дёргают import() заново. */
const pageModules = new Map<PageId, Promise<PageModule>>();
function loadPage(id: PageId): Promise<PageModule> {
  let p = pageModules.get(id);
  if (!p) {
    p = PAGE_LOADERS[id]();
    // Сбой загрузки чанка (например, обновление поменяло хэши файлов) не должен
    // «залипать»: следующая попытка снова вызовет import().
    p.catch(() => pageModules.delete(id));
    pageModules.set(id, p);
  }
  return p;
}

/** Подгрузить чанк страницы заранее (наведение на кнопку дока). */
function preloadPage(id: PageId): void {
  void loadPage(id).catch(() => {});
}

/**
 * Страницы в стопке обёрнуты в memo: ререндер оболочки (смена тулбара, счётчики
 * задач и т.п.) не должен перерисовывать скрытые страницы — они остаются
 * смонтированными, но «спящими». Контекст (id/active) при этом работает как надо.
 */
const MEMO_PAGE_COMPONENTS = (Object.keys(PAGE_LOADERS) as PageId[]).reduce(
  (acc, id) => {
    acc[id] = React.memo(React.lazy(() => loadPage(id)));
    return acc;
  },
  {} as Record<PageId, React.ComponentType>,
);

/** Заглушка на время загрузки чанка страницы (обычно — доли секунды). */
function PageFallback() {
  return <div className="page-loading" aria-busy="true" />;
}

interface ShellProps {
  active: PageId;
  setActive: (id: PageId) => void;
  theme: string;
  toggleTheme: () => void;
  toolbarNodes: Record<string, React.ReactNode>;
  setPageToolbar: (id: string, node: React.ReactNode | null) => void;
  blur: boolean;
  accent: string;
  reduceMotion: boolean;
  density: string;
  opaqueBg: boolean;
  proxyPanelVisible: boolean;
  setProxyPanelVisible: React.Dispatch<React.SetStateAction<boolean>>;
  taskManagerVisible: boolean;
  setTaskManagerVisible: React.Dispatch<React.SetStateAction<boolean>>;
  keepPagesAlive: boolean;
  keepPagesLimit: number;
  unloadIdleMinutes: number;
  /** Открыт ли стартовый экран приветствия — тулбар показывает "Привет!"
   *  вместо названия страницы, а рельс страниц прячется (см. WelcomeModal). */
  welcomeOpen: boolean;
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

const DOCK_KEY = "moonapp.dock.collapsed";

/** Свёрнутое меню страниц (только иконки) даже на широком окне; помним выбор. */
function useDockCollapsed(): [boolean, () => void] {
  const [c, setC] = useState(() => {
    try {
      return localStorage.getItem(DOCK_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dock-collapsed", c);
    try {
      localStorage.setItem(DOCK_KEY, c ? "1" : "0");
    } catch {
      /* без localStorage выбор просто не запомнится */
    }
  }, [c]);
  return [c, () => setC((v) => !v)];
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
  reduceMotion,
  density,
  opaqueBg,
  proxyPanelVisible,
  setProxyPanelVisible,
  taskManagerVisible,
  setTaskManagerVisible,
  keepPagesAlive,
  keepPagesLimit,
  unloadIdleMinutes,
  welcomeOpen,
}: ShellProps) {
  const { t, lang } = useI18n();
  const [modelPanelVisible, setModelPanelVisible] = useState(false);
  // Если активная страница была удалена или сохранена в настройках устаревшая
  // (например "todo"), откатываемся к первой доступной странице.
  const safeActive: PageId = PAGES.some((p) => p.id === active)
    ? active
    : ((PAGES[0]?.id as PageId) ?? "store");
  const activeMeta = PAGES.find((p) => p.id === safeActive)!;
  const MetaIcon = welcomeOpen ? Sparkles : activeMeta.icon;
  const metaTitle = welcomeOpen ? t("welcome.toolbarTitle") : t(activeMeta.i18n);
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
  const [dockCollapsed, toggleDockCollapsed] = useDockCollapsed();
  const stack = alive.includes(safeActive) ? alive : ([safeActive, ...alive] as PageId[]);

  // Классы/стили, управляемые разделом «Внешний вид»:
  //  - accent-* подменяет акцентный цвет (см. theme.css);
  //  - themeFamily — семейство темы (светлое/тёмное) для точечных правок CSS;
  //  - reduce-motion отключает анимации и blur-блобы;
  //  - density-compact уменьшает отступы списков.
  const shellCls = [
    "app-shell",
    `theme-${theme}`,
    themeFamily(theme),
    `accent-${accent}`,
    density === "compact" ? "density-compact" : "",
    reduceMotion ? "reduce-motion" : "",
    opaqueBg ? "opaque-bg" : "",
    blur ? "" : "no-blur",
    welcomeOpen ? "welcome-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellCls} dir={lang === "ar" ? "rtl" : "ltr"}>
      <div className="mesh" aria-hidden="true">
        <span className="blob blob-a" />
        <span className="blob blob-b" />
      </div>

      <PageBusyContext.Provider value={reportBusy}>
        <ToolbarContext.Provider value={setPageToolbar}>
          {/* Слой ПОД тулбаром (z-index между .content-area и .top-toolbar) —
              для полноэкранных фонов-анимаций (см. src/components/WelcomeModal.tsx),
              которым нужно быть виден и сквозь полупрозрачный тулбар, но не
              перекрывать его сами кнопки — см. src/components/overlayHost.ts. */}
          <div id="under-toolbar-root" className="under-toolbar-root" />
          <header
            className="top-toolbar"
            onPointerDown={(e) => {
              // Окно двигает main-процесс по положению курсора (плавно, с возвратом
              // развёрнутого окна к прежнему размеру). Только левая кнопка и только
              // пустое место шапки — не интерактивные элементы.
              if (e.button !== 0) return;
              const el = e.target as HTMLElement;
              if (el.closest(".no-drag, button, a, input, select, textarea, [role=button]")) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              window.appBridge?.dragStart?.();
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
                window.appBridge?.dragEnd?.();
              }
            }}
            onPointerCancel={() => window.appBridge?.dragEnd?.()}
            onDoubleClick={(e) => {
              const el = e.target as HTMLElement;
              if (el.closest(".no-drag, button, a, input, select, textarea, [role=button]")) return;
              window.appBridge?.toggleMaximize();
            }}
          >
            <div className="tb-side-left">
              {/* Диспетчер фоновых задач: единый список job'ов всех движков
                  (компрессия/апскейл/озвучка/лекции/архив) с отменой/паузой —
                  см. src/components/TaskManagerPanel.tsx. */}
              <button
                className="task-mgr-toggle no-drag"
                onClick={() => setTaskManagerVisible((v) => !v)}
                title={t("taskmgr.title")}
                aria-label={t("taskmgr.title")}
              >
                <ListChecks size={15} />
              </button>
              <ModelToggle onClick={() => setModelPanelVisible((v) => !v)} />
              <SystemStatsBar />
              <GhostToggle />
            </div>
            <div className="tb-center">
              <div className="tb-title">
                <MetaIcon size={15} strokeWidth={2.2} />
                <span>{metaTitle}</span>
              </div>
              <div className="tb-dynamic">{toolbarNode}</div>
            </div>
            <div className="tb-side-right">
              {/* Открыть папку с данными приложения: там лежит storage (настройки,
                  секреты, скачанные паки и модели). В собранной версии это
                  %APPDATA%\MoonApp, в dev — корень проекта (см. electron/main.js →
                  shell:open-app-dir → родитель STORAGE_DIR). */}
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
          {taskManagerVisible && <TaskManagerPanel onClose={() => setTaskManagerVisible(false)} />}
          {modelPanelVisible && <ModelPanel onClose={() => setModelPanelVisible(false)} />}
          <CommandPalette />
          <PrivacyShield />
          <NightBanner page={safeActive} />

          {/* Стопка живых страниц: активная видима, остальные скрыты, но сохраняют
            состояние (прогресс задач, ввод, позицию скролла). */}
          <main className="content-area">
            <div className="pages-stack">
              {(welcomeOpen ? [] : stack).map((id) => (
                <PageHost key={id} id={id} active={id === safeActive}>
                  <ErrorBoundary label={id}>
                    <Suspense fallback={<PageFallback />}>
                      {React.createElement(MEMO_PAGE_COMPONENTS[id])}
                    </Suspense>
                  </ErrorBoundary>
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
          <button
            className="dock-btn dock-collapse"
            onClick={toggleDockCollapsed}
            aria-label={t(dockCollapsed ? "nav.expand" : "nav.collapse")}
            title={t(dockCollapsed ? "nav.expand" : "nav.collapse")}
          >
            <span className="dock-icon">
              {dockCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </span>
            <span className="dock-label">{t(dockCollapsed ? "nav.expand" : "nav.collapse")}</span>
          </button>
          {PAGES.map((p) => {
            const Icon = p.icon;
            const isActive = p.id === active;
            return (
              <button
                key={p.id}
                className={`dock-btn ${isActive ? "is-active" : ""}`}
                onClick={() => setActive(p.id)}
                onMouseEnter={() => preloadPage(p.id)}
                onFocus={() => preloadPage(p.id)}
                aria-label={t(p.i18n)}
                title={t(p.i18n)}
              >
                <span className="dock-icon">
                  <Icon size={18} strokeWidth={2} />
                </span>
                <span className="dock-label">{t(p.i18n)}</span>
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
  useEffect(() => onOpenTarget(setActive), []);
  const [lang, setLang] = useState(storedLang);
  const [blur, setBlur] = useState(true);
  const [accent, setAccent] = useState("amber");
  const [reduceMotion, setReduceMotion] = useState(false);
  const [density, setDensity] = useState("comfortable");
  const [opaqueBg, setOpaqueBg] = useState(false);
  const [winOpacity, setWinOpacity] = useState(100);
  useEffect(() => watchIdle(), []);
  useEffect(() => {
    applyWindowOpacity(opaqueBg ? 100 : winOpacity);
  }, [opaqueBg, winOpacity]);
  const [toolbarNodes, setToolbarNodes] = useState<Record<string, React.ReactNode>>({});
  const [proxyPanelVisible, setProxyPanelVisible] = useState(false);
  const [taskManagerVisible, setTaskManagerVisible] = useState(false);
  // keep-alive: держать ли страницы смонтированными и как ограничивать память.
  const [keepPagesAlive, setKeepPagesAlive] = useState(true);
  const [keepPagesLimit, setKeepPagesLimit] = useState(KEEP_ALIVE_DEFAULT_LIMIT);
  const [unloadIdleMinutes, setUnloadIdleMinutes] = useState(KEEP_ALIVE_DEFAULT_IDLE_MIN);
  // Пока не выяснено, нужно ли приветствие, считаем, что оно открыто: страницы
  // не монтируются и их модули не грузятся — первым рисуется приветствие.
  const [welcomeOpen, setWelcomeOpen] = useState(!SOLO_PAGE);
  const [welcomeMounted, setWelcomeMounted] = useState(!SOLO_PAGE);

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

  // Мост к веб-компаньону: сообщает серверу, что играет, и выполняет команды телефона.
  useEffect(() => startCompanionBridge(), []);

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
        setActive(
          PAGES.some((p) => p.id === SOLO_PAGE)
            ? (SOLO_PAGE as PageId)
            : PAGES.some((p) => p.id === startPage)
              ? (startPage as PageId)
              : "store",
        );
        if (sc?.general?.language) setLang(sc.general.language);
        if (sc?.performance?.backgroundBlur != null) setBlur(!!sc.performance.backgroundBlur);
        // Внешний вид: акцент, анимации, плотность, непрозрачный фон.
        if (sc?.appearance?.accent) setAccent(sc.appearance.accent);
        setReduceMotion(!!sc?.appearance?.reduceMotion);
        if (sc?.appearance?.density) setDensity(sc.appearance.density);
        applyUiScale(sc?.appearance?.uiScale);
        applyDesign();
        applyGlass(sc?.appearance?.glass);
        applyLiquid(readLiquid(sc?.appearance));
        applyAnimSpeed(sc?.appearance?.animSpeed);
        setOpaqueBg(!!sc?.appearance?.opaqueBackground);
        setWinOpacity(Number(sc?.appearance?.windowOpacity ?? 100));
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
      else if (path === "appearance.reduceMotion") setReduceMotion(!!value);
      else if (path === "appearance.density") setDensity(String(value));
      else if (path === "appearance.uiScale") applyUiScale(value);
      else if (path.startsWith("appearance.lg")) {
        void api.getSettings().then((s) => applyLiquid(readLiquid((s as any)?.appearance)));
      }
      else if (path === "appearance.glass") applyGlass(value);
      else if (path === "appearance.opaqueBackground") setOpaqueBg(!!value);
      else if (path === "appearance.windowOpacity") setWinOpacity(Number(value));
      else if (path === "appearance.animSpeed") applyAnimSpeed(value);
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
        {/* Первой — чтобы её эффект (запрос настроек, решение показывать ли
            экран) стартовал раньше остальных и приветствие не мигало поверх
            уже отрисованной страницы. После закрытия сразу размонтируется
            (welcomeMounted=false) — не держим 16 карточек фич в памяти. */}
        <CursorSpotlight />
        <A11yFlags />
        {welcomeMounted && (
          <WelcomeModal
            onOpenChange={(o) => {
              setWelcomeOpen(o);
              if (!o) setWelcomeMounted(false);
            }}
          />
        )}
        <Shell
          active={active}
          setActive={setActive}
          theme={theme}
          toggleTheme={toggleTheme}
          toolbarNodes={toolbarNodes}
          setPageToolbar={setPageToolbar}
          blur={blur}
          accent={accent}
          reduceMotion={reduceMotion}
          density={density}
          opaqueBg={opaqueBg}
          proxyPanelVisible={proxyPanelVisible}
          setProxyPanelVisible={setProxyPanelVisible}
          taskManagerVisible={taskManagerVisible}
          setTaskManagerVisible={setTaskManagerVisible}
          keepPagesAlive={keepPagesAlive}
          keepPagesLimit={keepPagesLimit}
          unloadIdleMinutes={unloadIdleMinutes}
          welcomeOpen={welcomeOpen}
        />
      </ContextMenuProvider>
    </I18nProvider>
  );
}

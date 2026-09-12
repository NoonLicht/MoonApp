import React, { useState, useEffect } from "react";
import {
  Store, Repeat, Gauge, Video, Music2, BookOpen, Activity, MessageSquare,
  Mic2, Archive, Sun, Moon, Minus, Square, X, Settings2, Shield, User, GraduationCap,
} from "lucide-react";
import { I18nProvider, useI18n } from "./i18n";
import { ContextMenuProvider } from "./components/ContextMenu";
import { ToolbarContext } from "./components/Toolbar";
import ProxyPanel from "./components/ProxyPanel";
import { api } from "./api/client";

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

type PageId =
  | "store" | "convert" | "compress" | "video" | "music" | "books" | "monitor"
  | "aichat" | "voice" | "archive" | "settings" | "myspace" | "lecture" | "bypass";

const PAGES: { id: PageId; i18n: string; icon: React.ElementType }[] = [
  { id: "store", i18n: "nav.store", icon: Store },
  { id: "convert", i18n: "nav.convert", icon: Repeat },
  { id: "compress", i18n: "nav.compress", icon: Gauge },
  { id: "video", i18n: "nav.video", icon: Video },
  { id: "music", i18n: "nav.music", icon: Music2 },
  { id: "books", i18n: "nav.books", icon: BookOpen },
  { id: "monitor", i18n: "nav.monitor", icon: Activity },
  { id: "myspace", i18n: "nav.myspace", icon: User },
  { id: "aichat", i18n: "nav.aichat", icon: MessageSquare },
  { id: "voice", i18n: "nav.voice", icon: Mic2 },
  { id: "lecture", i18n: "nav.lecture", icon: GraduationCap },
  { id: "bypass", i18n: "nav.bypass", icon: Shield },
  { id: "archive", i18n: "nav.archive", icon: Archive },
  { id: "settings", i18n: "nav.settings", icon: Settings2 },
];

const PAGE_COMPONENTS: Record<PageId, React.ComponentType> = {
  store: StorePage,
  convert: ConverterPage,
  compress: CompressorPage,
  video: VideoPage,
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

interface ShellProps {
  active: PageId;
  setActive: (id: PageId) => void;
  theme: string;
  toggleTheme: () => void;
  toolbarNode: React.ReactNode;
  setToolbarNode: (node: React.ReactNode) => void;
  blur: boolean;
  accent: string;
  fontSize: number;
  reduceMotion: boolean;
  density: string;
  proxyPanelVisible: boolean;
  setProxyPanelVisible: React.Dispatch<React.SetStateAction<boolean>>;
}

function Shell({ active, setActive, theme, toggleTheme, toolbarNode, setToolbarNode, blur, accent, fontSize, reduceMotion, density, proxyPanelVisible, setProxyPanelVisible }: ShellProps) {
  const { t, lang } = useI18n();
  // Если активная страница была удалена или сохранена в настройках устаревшая
  // (например "todo"), откатываемся к первой доступной странице.
  const safeActive: PageId = PAGES.some((p) => p.id === active) ? active : (PAGES[0]?.id as PageId) ?? "store";
  const ActivePage = PAGE_COMPONENTS[safeActive];
  const activeMeta = PAGES.find((p) => p.id === safeActive)!;
  const MetaIcon = activeMeta.icon;
  const metaTitle = t(activeMeta.i18n);

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
    blur ? "" : "no-blur",
  ].filter(Boolean).join(" ");

  return (
    <div className={shellCls} style={{ fontSize: `${fontSize}px` }} dir={lang === "ar" ? "rtl" : "ltr"}>
      <div className="mesh" aria-hidden="true">
        <span className="blob blob-a" />
        <span className="blob blob-b" />
      </div>

      <ToolbarContext.Provider value={setToolbarNode}>
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
            <button className="proxy-toggle no-drag" onClick={() => setProxyPanelVisible((v) => !v)} title={t("proxy.title")}>
              <Shield size={15} />
            </button>
            <button className="theme-toggle no-drag" onClick={toggleTheme} title={t("common.theme")}>
              <Sun className="ico-sun" size={15} />
              <Moon className="ico-moon" size={15} />
            </button>
            <div className="win-controls no-drag">
              <button className="win-btn" onClick={() => window.appBridge?.minimize()} title={t("common.minimize")}><Minus size={15} /></button>
              <button className="win-btn" onClick={() => window.appBridge?.toggleMaximize()} title={t("common.maximize")}><Square size={12} /></button>
              <button className="win-btn win-close" onClick={() => window.appBridge?.close()} title={t("common.close")}><X size={15} /></button>
            </div>
          </div>
        </header>

        {proxyPanelVisible && (
          <ProxyPanel onClose={() => setProxyPanelVisible(false)} />
        )}

        <main className="content-area" key={active}>
          {/* .content-frame ограничивает ширину контента на ultrawide-мониторах. */}
          <div className="content-frame">
            <ActivePage />
          </div>
        </main>
      </ToolbarContext.Provider>

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
                <span className="dock-icon"><Icon size={18} strokeWidth={2} /></span>
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
  const [toolbarNode, setToolbarNode] = useState<React.ReactNode>(null);
  const [proxyPanelVisible, setProxyPanelVisible] = useState(false);

  // Подтягиваем тему, стартовую страницу, язык, blur и внешние вид из настроек.
  useEffect(() => {
    api.getSettings()
      .then((s) => {
        const sc = s as any;
        if (sc?.appearance?.theme) setTheme(sc.appearance.theme);
        if (sc?.general?.startPage) setActive(sc.general.startPage);
        if (sc?.general?.language) setLang(sc.general.language);
        if (sc?.performance?.backgroundBlur != null) setBlur(!!sc.performance.backgroundBlur);
        // Внешний вид: акцент, размер шрифта, анимации, плотность.
        if (sc?.appearance?.accent) setAccent(sc.appearance.accent);
        if (sc?.appearance?.fontSize) setFontSize(Number(sc.appearance.fontSize) || 14);
        setReduceMotion(!!sc?.appearance?.reduceMotion);
        if (sc?.appearance?.density) setDensity(sc.appearance.density);
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
      else if (path === "appearance.accent") setAccent(String(value));
      else if (path === "appearance.fontSize") setFontSize(Number(value) || 14);
      else if (path === "appearance.reduceMotion") setReduceMotion(!!value);
      else if (path === "appearance.density") setDensity(String(value));
    };
    window.addEventListener("app:theme", onTheme);
    window.addEventListener("app:setting", onSetting);
    return () => {
      window.removeEventListener("app:theme", onTheme);
      window.removeEventListener("app:setting", onSetting);
    };
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
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
          toolbarNode={toolbarNode}
          setToolbarNode={setToolbarNode}
          blur={blur}
          accent={accent}
          fontSize={fontSize}
          reduceMotion={reduceMotion}
          density={density}
          proxyPanelVisible={proxyPanelVisible}
          setProxyPanelVisible={setProxyPanelVisible}
        />
      </ContextMenuProvider>
    </I18nProvider>
  );
}
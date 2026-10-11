import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  CheckCheck,
  ExternalLink,
  Rss,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
  ChevronDown,
  ChevronUp,
  Languages,
  Settings,
  BookOpen,
  Copy,
  EyeOff,
  Power,
} from "lucide-react";
import { Btn, Glass, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { useDeepLink } from "@/lib/deepLink";
import { useContextMenu } from "@/components/ContextMenu";
import { api } from "@/api/client";
import type { RssFeed, RssItem, RssSettingsView } from "@/api/apiRss";
import { createPortal } from "react-dom";
import { getOverlayRoot } from "@/components/overlayHost";
import { usePageActive } from "@/components/Toolbar";
import MarkdownRenderer from "@/pages/myspace/parts/MarkdownRenderer";

type Filter = "all" | "unread" | "saved";
const LANG_NAME: Record<string, string> = {
  ru: "Russian",
  en: "English",
  es: "Spanish",
  fr: "French",
  zh: "Chinese",
  ar: "Arabic",
};

function openLink(url: string): void {
  if (window.appBridge?.openExternal) void window.appBridge.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

/** Плитка статьи. memo: клик по одной не перерисовывает остальные сотню. */
const RssTile = memo(function RssTile({
  it,
  active,
  date,
  onOpen,
  lang,
  translated,
  onContext,
}: {
  it: RssItem;
  active: boolean;
  date: string;
  onOpen: (it: RssItem) => void;
  lang: string;
  translated: boolean;
  onContext: (e: React.MouseEvent, it: RssItem) => void;
}) {
  const tr = translated ? it.tr?.[lang] : undefined;
  const title = tr ? tr.title : it.title;
  const summary = tr ? tr.summary : it.summary;
  return (
    <button
      type="button"
      className={`rss-item${it.read ? " is-read" : ""}${active ? " is-active" : ""}`}
      onClick={() => onOpen(it)}
      onContextMenu={(e) => onContext(e, it)}
    >
      <b className="rss-item-title">{title}</b>
      <span className="rss-item-sum">{summary}</span>
      {it.image && (
        <img src={it.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
      )}
      <span className="muted-sm rss-item-meta">
        {it.feedTitle} · {date}
        {it.saved ? " ★" : ""}
      </span>
    </button>
  );
});

const PAGE_STEP = 24;

/** Понятное сообщение об ошибке движка перевода (null — ошибка не из известных). */
function engineError(m: string, t: (k: string, p?: Record<string, unknown>) => string): string | null {
  if (m.includes("google_rate_limited")) return t("rss.googleLimited");
  if (m.includes("_rate_limited") || m.includes("lingva_failed")) return t("rss.engineLimited");
  if (m.includes("local_model_missing")) return t("rss.localMissing");
  if (m.includes("libre_not_configured")) return t("rss.libreMissing");
  return null;
}

const INTERVALS = [0, 1, 2, 5, 10, 15];
type Engine = "ai" | "local" | "google" | "mymemory" | "libre" | "lingva";
const ENGINES: Engine[] = ["ai", "local", "google", "mymemory", "libre", "lingva"];
const isEngine = (v: string | null): v is Engine => !!v && (ENGINES as string[]).includes(v);

/** Окно настроек перевода: включение и выбор движка. */
function RssSettings({
  engine,
  onEngine,
  onClose,
  intervalMin,
  onInterval,
  cfg,
  onCfg,
}: {
  engine: Engine;
  onEngine: (e: Engine) => void;
  onClose: () => void;
  intervalMin: number;
  onInterval: (min: number) => void;
  cfg: RssSettingsView | null;
  onCfg: (patch: Parameters<typeof api.rssSaveSettings>[0]) => void;
}) {
  const { t } = useI18n();
  // Поля адресов и ключей сохраняются при уходе из поля (не на каждую букву).
  const [mmEmail, setMmEmail] = useState(cfg?.myMemoryEmail ?? "");
  const [libreUrl, setLibreUrl] = useState(cfg?.libreUrl ?? "");
  const [libreKey, setLibreKey] = useState("");
  const [lingvaUrl, setLingvaUrl] = useState(cfg?.lingvaUrl ?? "");
  const [unloaded, setUnloaded] = useState(false);
  useEffect(() => {
    if (!cfg) return;
    setMmEmail(cfg.myMemoryEmail);
    setLibreUrl(cfg.libreUrl);
    setLingvaUrl(cfg.lingvaUrl);
  }, [cfg]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="rss-modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rss-modal" role="dialog" aria-modal="true" aria-label={t("rss.settingsTitle")}>
        <div className="rss-modal-head">
          <div className="field-label">{t("rss.settingsTitle")}</div>
          <button
            type="button"
            className="rss-modal-close"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>
        <div className="rss-modal-body">
          <div className="rss-field">
            <span className="field-label">{t("rss.autoTitle")}</span>
            <select
              value={INTERVALS.includes(intervalMin) ? intervalMin : -1}
              onChange={(e) => onInterval(Number(e.target.value))}
            >
              {!INTERVALS.includes(intervalMin) && (
                <option value={-1}>{t("rss.autoEvery", { n: intervalMin })}</option>
              )}
              {INTERVALS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? t("rss.autoOff") : t("rss.autoEvery", { n: m })}
                </option>
              ))}
            </select>
            <span className="muted-sm">{t("rss.autoHint")}</span>
          </div>

          <div className="rss-field">
            <span className="field-label">{t("rss.translate")}</span>
            <span className="muted-sm">{t("rss.engineTitle")}</span>
            {ENGINES.map((e) => (
              <label key={e} className={`rss-engine${engine === e ? " is-on" : ""}`}>
                <input type="radio" name="rss-engine" checked={engine === e} onChange={() => onEngine(e)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{t(`rss.engine.${e}`)}</b>
                  <span className="muted-sm" style={{ display: "block" }}>
                    {t(`rss.engine.${e}Hint`)}
                  </span>
                  {engine === e && e === "mymemory" && (
                    <input
                      className="rss-input"
                      type="email"
                      placeholder={t("rss.cfg.email")}
                      value={mmEmail}
                      onChange={(ev) => setMmEmail(ev.target.value)}
                      onBlur={() => onCfg({ myMemoryEmail: mmEmail })}
                    />
                  )}
                  {engine === e && e === "libre" && (
                    <>
                      <input
                        className="rss-input"
                        placeholder="https://libretranslate.example.com"
                        value={libreUrl}
                        onChange={(ev) => setLibreUrl(ev.target.value)}
                        onBlur={() => onCfg({ libreUrl })}
                      />
                      <input
                        className="rss-input"
                        type="password"
                        placeholder={cfg?.hasLibreKey ? t("rss.cfg.keySaved") : t("rss.cfg.key")}
                        value={libreKey}
                        onChange={(ev) => setLibreKey(ev.target.value)}
                        onBlur={() => {
                          if (libreKey) onCfg({ libreKey });
                          setLibreKey("");
                        }}
                      />
                    </>
                  )}
                  {engine === e && e === "lingva" && (
                    <input
                      className="rss-input"
                      placeholder="https://lingva.ml"
                      value={lingvaUrl}
                      onChange={(ev) => setLingvaUrl(ev.target.value)}
                      onBlur={() => onCfg({ lingvaUrl })}
                    />
                  )}
                </span>
              </label>
            ))}
          </div>

          <div className="rss-field">
            <span className="field-label">{t("rss.modelTitle")}</span>
            <label className="rss-check">
              <input
                type="checkbox"
                checked={!!cfg?.unloadAfter}
                onChange={(e) => onCfg({ unloadAfter: e.target.checked })}
              />
              <span>{t("rss.unloadAfter")}</span>
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Btn
                icon={Power}
                onClick={() =>
                  void api
                    .rssUnloadModel()
                    .then(() => setUnloaded(true))
                    .catch(() => undefined)
                }
              >
                {t("rss.unloadNow")}
              </Btn>
              {unloaded && <span className="muted-sm">{t("rss.unloaded")}</span>}
            </div>
            <span className="muted-sm">{t("rss.unloadHint")}</span>
          </div>
        </div>
      </div>
    </div>,
    getOverlayRoot() ?? document.body,
  );
}

type ArticleData = Awaited<ReturnType<typeof api.rssArticle>>;

/** Читалка: панель справа поверх страницы (список под ней не перестраивается), с кнопкой закрытия. */
function RssReader({
  item,
  date,
  busy,
  onClose,
  onReadLater,
  onToggleSaved,
  translated,
  engine,
}: {
  item: RssItem;
  date: string;
  busy: boolean;
  onClose: () => void;
  onReadLater: () => void;
  onToggleSaved: () => void;
  translated: boolean;
  engine: Engine;
}) {
  const { t, lang } = useI18n();
  const [trBlocks, setTrBlocks] = useState<ArticleData["blocks"] | null>(null);
  const [showOrig, setShowOrig] = useState(false);
  const [trBusy, setTrBusy] = useState(false);
  const [trError, setTrError] = useState("");
  const [readerTps, setReaderTps] = useState<number | null>(null);
  const tr = translated && !showOrig ? item.tr?.[lang] : undefined;
  const [art, setArt] = useState<ArticleData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setArt(null);
    setFailed(false);
    api
      .rssArticle(item.id)
      .then((a) => alive && setArt(a))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [item.id]);
  // Перевод текста статьи (после загрузки оригинала): 0 — уже на языке пользователя.
  useEffect(() => {
    setTrBlocks(null);
    setShowOrig(false);
    setTrError("");
    setReaderTps(null);
    if (!translated || !art || art.partial) return;
    let alive = true;
    setTrBusy(true);
    api
      .rssArticleTranslate(item.id, lang, engine)
      .then((r) => {
        if (!alive) return;
        setTrBlocks(r.blocks === 0 ? null : r.blocks);
        setReaderTps(r.tps ?? null);
      })
      .catch((e) => {
        if (!alive) return;
        const m = (e as Error).message;
        setTrError(engineError(m, t) ?? t("rss.translateFailed"));
      })
      .finally(() => alive && setTrBusy(false));
    return () => {
      alive = false;
    };
  }, [item.id, lang, translated, art, engine, t]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="rss-drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="rss-drawer" role="dialog" aria-modal="true">
        <div className="rss-drawer-head">
          <div className="muted-sm" style={{ flex: 1 }}>
            {item.feedTitle} · {date}
          </div>
          {translated && (item.tr?.[lang] || trBlocks) && (
            <Btn
              icon={Languages}
              variant={showOrig ? "secondary" : "primary"}
              title={showOrig ? t("rss.showTranslation") : t("rss.showOriginal")}
              onClick={() => setShowOrig((v) => !v)}
            >
              {t("rss.translate")}
            </Btn>
          )}
          <button type="button" className="icon-btn" title={t("common.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="rss-drawer-body">
          <h2 style={{ margin: 0 }}>{tr ? tr.title : item.title}</h2>
          {item.image && (
            <img className="rss-reader-img" src={item.image} alt="" referrerPolicy="no-referrer" />
          )}
          {!art && !failed && <div className="muted-sm">{t("rss.articleLoading")}</div>}
          {(failed || art?.partial) && (
            <>
              <p style={{ lineHeight: 1.55 }}>{tr ? tr.summary : item.summary}</p>
              <div className="muted-sm">{t("rss.articlePartial")}</div>
            </>
          )}
          {trBusy && <div className="muted-sm">{t("rss.translating")}</div>}
          {readerTps ? (
            <div className="muted-sm">⚡ {readerTps.toFixed(1)} {t("rss.tps")}</div>
          ) : null}
          {trError && <div className="muted-sm" style={{ color: "var(--coral)" }}>{trError}</div>}
          {art &&
            !art.partial &&
            (translated && !showOrig && trBlocks ? trBlocks : art.blocks).map((b, i) =>
              b.kind === "h" ? (
                <h3 key={i} style={{ margin: "10px 0 0" }}>
                  {b.text}
                </h3>
              ) : b.kind === "li" ? (
                <p key={i} className="rss-art-li">
                  • {b.text}
                </p>
              ) : b.kind === "q" ? (
                <blockquote key={i} className="rss-art-q">
                  {b.text}
                </blockquote>
              ) : (
                <p key={i} className="rss-art-p">
                  {b.text}
                </p>
              ),
            )}
        </div>
        <div className="rss-reader-actions rss-drawer-foot">
          <Btn icon={ExternalLink} variant="primary" onClick={() => openLink(item.link)}>
            {t("rss.openSite")}
          </Btn>
          <Btn icon={BookmarkPlus} disabled={busy} onClick={onReadLater}>
            {t("rss.readLater")}
          </Btn>
          <Btn icon={Star} onClick={onToggleSaved}>
            {item.saved ? t("rss.unsave") : t("rss.save")}
          </Btn>
        </div>
      </aside>
    </div>,
    getOverlayRoot() ?? document.body,
  );
}

/** RSS-ридер: подписки, лента статей, чтение «отложить на потом» и ИИ-сводка. */
export default function RssPage() {
  const { t, lang } = useI18n();
  const [feeds, setFeeds] = useState<RssFeed[]>([]);
  const [items, setItems] = useState<RssItem[]>([]);
  const [feedId, setFeedId] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<RssItem | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [digest, setDigest] = useState<{ markdown: string; count: number; model: string } | null>(null);
  const [digestBusy, setDigestBusy] = useState(false);
  // Свёрнутость сводки помним между запусками; сама сводка хранится на сервере до следующей.
  const [digestOpen, setDigestOpen] = useState(() => {
    try {
      return localStorage.getItem("moonapp.rss.digestOpen") !== "0";
    } catch {
      return true;
    }
  });
  const toggleDigest = () =>
    setDigestOpen((v) => {
      try {
        localStorage.setItem("moonapp.rss.digestOpen", v ? "0" : "1");
      } catch {
        /* без запоминания */
      }
      return !v;
    });
  // Рисуем статьи порциями: сотня плиток с картинками сразу — это и есть «фриз».
  const [shown, setShown] = useState(PAGE_STEP);
  const sentinel = useRef<HTMLDivElement | null>(null);
  // Перевод новостей на язык интерфейса (включён по умолчанию; запоминается).
  const [translateOn, setTranslateOn] = useState(() => {
    try {
      return localStorage.getItem("moonapp.rss.translate") === "1";
    } catch {
      return true;
    }
  });
  const toggleTranslate = () =>
    setTranslateOn((v) => {
      try {
        localStorage.setItem("moonapp.rss.translate", v ? "0" : "1");
      } catch {
        /* без запоминания */
      }
      return !v;
    });
  const [engine, setEngine] = useState<Engine>(() => {
    try {
      const v = localStorage.getItem("moonapp.rss.engine");
      return isEngine(v) ? v : "ai";
    } catch {
      return "ai";
    }
  });
  const chooseEngine = (e: Engine) => {
    setEngine(e);
    asked.current.clear();
    try {
      localStorage.setItem("moonapp.rss.engine", e);
    } catch {
      /* без запоминания */
    }
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Интервал автообновления хранится на сервере (фоновый таймер живёт там, а не в окне).
  const [cfg, setCfg] = useState<RssSettingsView | null>(null);
  const intervalMin = cfg?.intervalMin ?? 5;
  useEffect(() => {
    api.rssSettings().then(setCfg).catch(() => undefined);
  }, []);
  const saveCfg = (patch: Parameters<typeof api.rssSaveSettings>[0]) => {
    setCfg((c) => (c ? { ...c, ...patch, hasLibreKey: c.hasLibreKey || !!patch.libreKey } : c));
    void api
      .rssSaveSettings(patch)
      .then(setCfg)
      .catch((e) => say((e as Error).message));
  };
  const changeInterval = (min: number) => saveCfg({ intervalMin: min });
  const [tps, setTps] = useState<number | null>(null);
  const [translating, setTranslating] = useState(false);
  const asked = useRef<Set<string>>(new Set());
  const pageActive = usePageActive();

  const say = (m: string) => setMsg(m);

  const loadFeeds = useCallback(() => {
    api.rssFeeds().then(setFeeds).catch((e) => say((e as Error).message));
  }, []);

  const [searchMode, setSearchMode] = useState<"semantic" | "text">("text");
  const loadItems = useCallback(() => {
    const q = query.trim();
    const f = { feed: feedId, unread: filter === "unread", saved: filter === "saved" };
    // С запросом ищем по смыслу (EmbeddingGemma); если модель недоступна — сервер отдаёт текстовый поиск.
    const run = q
      ? api.rssSearch({ ...f, q }).then((r) => {
          setSearchMode(r.mode);
          return r.items;
        })
      : api.rssItems({ ...f, limit: 200 }).then((r) => {
          setSearchMode("text");
          return r;
        });
    run.then(setItems).catch((e) => say((e as Error).message));
  }, [feedId, filter, query]);

  useEffect(loadFeeds, [loadFeeds]);
  useEffect(() => {
    const id = window.setTimeout(loadItems, query ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [loadItems, query]);

  const reload = () => {
    loadFeeds();
    loadItems();
  };

  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    say("");
    try {
      await api.rssAddFeed(url.trim());
      setUrl("");
      reload();
    } catch (e) {
      say(t("rss.addFailed", { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    say("");
    try {
      const r = await api.rssRefresh(feedId);
      say(t("rss.refreshed", { added: r.added, failed: r.failed }));
      reload();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importOpml = async (file: File) => {
    setBusy(true);
    try {
      const r = await api.rssImportOpml(await file.text());
      say(t("rss.opmlResult", r));
      reload();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useDeepLink("rss", (target) => {
    if (!target.ref) return;
    void api
      .rssItem(target.ref)
      .then((it) => setSelected({ ...it, feedTitle: "" } as RssItem))
      .catch(() => undefined);
  });

  const open = useCallback((it: RssItem) => {
    setSelected(it);
    if (!it.read) {
      void api.rssPatchItem(it.id, { read: true }).then(() => {
        setItems((list) => list.map((x) => (x.id === it.id ? { ...x, read: true } : x)));
        loadFeeds();
      });
    }
  }, [loadFeeds]);

  const toggleSaved = (it: RssItem) =>
    api.rssPatchItem(it.id, { saved: !it.saved }).then((r) => {
      setItems((list) => list.map((x) => (x.id === it.id ? { ...x, saved: r.saved } : x)));
      setSelected((s) => (s && s.id === it.id ? { ...s, saved: r.saved } : s));
    });

  const readLater = async (it: RssItem) => {
    setBusy(true);
    try {
      await api.rssReadLater(it.id);
      say(t("rss.readLaterDone"));
      reload();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const makeDigest = async () => {
    setDigestBusy(true);
    setDigest(null);
    say("");
    try {
      const scope = filter === "saved" ? "saved" : "unread";
      setDigest(await api.rssDigest(scope, LANG_NAME[lang] || "English", feedId));
    } catch (e) {
      const m = (e as Error).message;
      say(
        m.includes("no_items")
          ? t("rss.digestEmpty")
          : m.includes("not_configured") || m.includes("model_missing")
            ? t("rss.digestNoAi")
            : m,
      );
    } finally {
      setDigestBusy(false);
    }
  };

  // Смена фильтра/ленты/поиска — снова с первой порции.
  useEffect(() => setShown(PAGE_STEP), [feedId, filter, query]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (e) => {
        if (e[0]?.isIntersecting) setShown((n) => n + PAGE_STEP);
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, items.length]);

  // Последняя сводка переживает перезапуск: подтягиваем её при открытии страницы.
  useEffect(() => {
    api
      .rssLastDigest()
      .then((d) => d && setDigest({ markdown: d.markdown, count: d.count, model: d.model }))
      .catch(() => undefined);
  }, []);

  // Автообновление идёт на сервере в фоне (интервал — в настройках). Открытая страница лишь
  // перечитывает списки в том же ритме, а при открытии подтягивает ленты, если они давно не обновлялись.
  const feedsRef = useRef<RssFeed[]>([]);
  feedsRef.current = feeds;
  useEffect(() => {
    if (!intervalMin) return;
    const everyMs = intervalMin * 60 * 1000;
    const first = window.setTimeout(() => {
      const list = feedsRef.current;
      if (!list.length) return;
      const oldest = Math.min(...list.map((f) => f.lastFetched ?? 0));
      if (Date.now() - oldest < everyMs) return;
      void api
        .rssRefresh()
        .then(() => {
          loadFeeds();
          loadItems();
        })
        .catch(() => undefined);
    }, 1500);
    const iv = window.setInterval(() => {
      loadFeeds();
      loadItems();
    }, Math.max(30000, everyMs));
    return () => {
      window.clearTimeout(first);
      window.clearInterval(iv);
    };
  }, [loadFeeds, loadItems, intervalMin]);

  // Перевод порциями: только то, что уже показано и ещё не переведено на этот язык.
  useEffect(() => {
    if (!translateOn) return;
    let alive = true;
    const pending = items
      .slice(0, shown)
      .filter((i) => i.tr?.[lang] === undefined && !asked.current.has(`${i.id}:${lang}`))
      .slice(0, 20);
    if (!pending.length) return;
    pending.forEach((i) => asked.current.add(`${i.id}:${lang}`));
    setTranslating(true);
    (async () => {
      try {
        for (let k = 0; k < pending.length && alive; k += 10) {
          const part = pending.slice(k, k + 10).map((i) => i.id);
          const res = await api.rssTranslate(part, lang, engine);
          if (!alive) return;
          if (res.tps) setTps(res.tps);
          const byId = new Map(res.items.map((r) => [r.id, r.tr]));
          setItems((list) =>
            list.map((x) =>
              byId.has(x.id) ? { ...x, tr: { ...(x.tr || {}), [lang]: byId.get(x.id)! } } : x,
            ),
          );
        }
      } catch (e) {
        const m = (e as Error).message;
        if (alive)
          say(
            engineError(m, t) ??
              (m.includes("not_configured") || m.includes("model_missing") ? t("rss.digestNoAi") : m),
          );
        // не долбим провайдера повторно из-за той же ошибки
      } finally {
        if (alive) setTranslating(false);
      }
    })();
    return () => {
      alive = false;
      setTranslating(false);
      // отменённые запросы можно будет повторить
      pending.forEach((i) => asked.current.delete(`${i.id}:${lang}`));
    };
  }, [items, shown, translateOn, lang, engine, t]);

  const menu = useContextMenu();
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  const setRead = (it: RssItem, read: boolean) =>
    api.rssPatchItem(it.id, { read }).then(() => {
      setItems((list) => list.map((x) => (x.id === it.id ? { ...x, read } : x)));
      loadFeeds();
    });
  // Правая кнопка по плитке: открыть, ссылка, прочитано, сохранить, отложить.
  const onTileContext = (e: React.MouseEvent, it: RssItem) =>
    menu.open(e, [
      { label: t("rss.ctx.open"), icon: BookOpen, onClick: () => open(it) },
      { label: t("rss.openSite"), icon: ExternalLink, onClick: () => openLink(it.link) },
      { separator: true },
      { label: t("rss.ctx.copyLink"), icon: Copy, onClick: () => copy(it.link) },
      { label: t("rss.ctx.copyTitle"), icon: Copy, onClick: () => copy(it.title) },
      { separator: true },
      it.read
        ? { label: t("rss.ctx.markUnread"), icon: EyeOff, onClick: () => void setRead(it, false) }
        : { label: t("rss.ctx.markRead"), icon: CheckCheck, onClick: () => void setRead(it, true) },
      {
        label: it.saved ? t("rss.unsave") : t("rss.save"),
        icon: Star,
        onClick: () => void toggleSaved(it),
      },
      { label: t("rss.readLater"), icon: BookmarkPlus, disabled: busy, onClick: () => void readLater(it) },
    ]);
  // Правая кнопка по ленте: обновить, всё прочитано, адрес, отписаться.
  const onFeedContext = (e: React.MouseEvent, f: RssFeed) =>
    menu.open(e, [
      {
        label: t("rss.refresh"),
        icon: RefreshCw,
        onClick: () =>
          void api
            .rssRefresh(f.id)
            .then(reload)
            .catch((err) => say((err as Error).message)),
      },
      { label: t("rss.readAll"), icon: CheckCheck, onClick: () => void api.rssReadAll(f.id).then(reload) },
      { separator: true },
      { label: t("rss.ctx.copyFeedUrl"), icon: Copy, onClick: () => copy(f.url) },
      f.site ? { label: t("rss.openSite"), icon: ExternalLink, onClick: () => openLink(f.site!) } : null,
      { separator: true },
      {
        label: t("rss.unsubscribe"),
        icon: Trash2,
        danger: true,
        onClick: () => {
          if (window.confirm(t("rss.unsubscribeConfirm", { name: f.title || f.url })))
            void api.rssRemoveFeed(f.id).then(() => {
              if (feedId === f.id) setFeedId(undefined);
              reload();
            });
        },
      },
    ]);

  const unreadTotal = useMemo(() => feeds.reduce((s, f) => s + f.unread, 0), [feeds]);
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="page rss-page">
      <SectionHead
        eyebrow={t("rss.eyebrow")}
        title={t("rss.title")}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Btn icon={RefreshCw} disabled={busy} onClick={() => void refresh()}>
              {t("rss.refresh")}
            </Btn>
            <Btn
              icon={CheckCheck}
              onClick={() =>
                void api.rssReadAll(feedId).then(() => {
                  reload();
                })
              }
            >
              {t("rss.readAll")}
            </Btn>
            <Btn icon={Sparkles} variant="primary" disabled={digestBusy} onClick={() => void makeDigest()}>
              {digestBusy ? t("rss.digestBusy") : t("rss.digest")}
            </Btn>
          </div>
        }
      />
      {msg && <div className="muted-sm">{msg}</div>}

      {digest && (
        <Glass className="rss-digest">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Sparkles size={14} />
            <b style={{ flex: 1 }}>{t("rss.digest")}</b>
            <button
              type="button"
              className="icon-btn"
              title={digestOpen ? t("rss.digestCollapse") : t("rss.digestExpand")}
              aria-expanded={digestOpen}
              onClick={toggleDigest}
            >
              {digestOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>
          {digestOpen && (
            <>
              <MarkdownRenderer content={digest.markdown} />
              <div className="muted-sm">{t("rss.digestBy", { n: digest.count, model: digest.model })}</div>
            </>
          )}
        </Glass>
      )}

      <div className="rss-layout">
        <div className="rss-side">
        <Glass className="rss-feeds">
          <div className="rss-add">
            <input
              className="text-input"
              placeholder={t("rss.addPh")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
            />
            <Btn variant="primary" disabled={busy || !url.trim()} onClick={() => void add()}>
              {t("rss.add")}
            </Btn>
          </div>
          <button
            type="button"
            className={`rss-feed-row${!feedId ? " is-active" : ""}`}
            onClick={() => setFeedId(undefined)}
          >
            <Rss size={14} />
            <span style={{ flex: 1 }}>{t("rss.allFeeds")}</span>
            {unreadTotal > 0 && <b className="rss-count">{unreadTotal}</b>}
          </button>
          {feeds.map((f) => (
            <div
              key={f.id}
              className={`rss-feed-row${feedId === f.id ? " is-active" : ""}`}
              onContextMenu={(e) => onFeedContext(e, f)}
            >
              <button type="button" className="rss-feed-main" onClick={() => setFeedId(f.id)} title={f.error || f.url}>
                <span className="rss-feed-title">{f.title || f.url}</span>
                {f.error && <span className="rss-err">!</span>}
                {f.unread > 0 && <b className="rss-count">{f.unread}</b>}
              </button>
              <button
                type="button"
                className="icon-btn"
                title={t("rss.unsubscribe")}
                onClick={() => {
                  if (window.confirm(t("rss.unsubscribeConfirm", { name: f.title || f.url })))
                    void api.rssRemoveFeed(f.id).then(() => {
                      if (feedId === f.id) setFeedId(undefined);
                      reload();
                    });
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <div className="rss-opml">
            <label className="btn" style={{ cursor: "pointer" }}>
              <Upload size={13} /> {t("rss.importOpml")}
              <input
                type="file"
                accept=".opml,.xml,text/xml"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importOpml(f);
                  e.target.value = "";
                }}
              />
            </label>
            <Btn
              onClick={() =>
                void api.rssExportOpml().then((xml) => {
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(new Blob([xml], { type: "text/x-opml" }));
                  a.download = "moonapp-feeds.opml";
                  a.click();
                  URL.revokeObjectURL(a.href);
                })
              }
            >
              {t("rss.exportOpml")}
            </Btn>
          </div>
        </Glass>
        <div className="rss-feeds-extra">
          <Btn
            icon={Trash2}
            onClick={() => {
              if (window.confirm(t("rss.clearConfirm")))
                void api
                  .rssClear()
                  .then((r) => {
                    setSelected(null);
                    say(t("rss.cleared", { n: r.removed }));
                    reload();
                  })
                  .catch((e) => say((e as Error).message));
            }}
          >
            {t("rss.clearDb")}
          </Btn>
        </div>
        </div>

        <div className="rss-list-col">
          <div className="rss-toolbar">
            <Btn
              icon={Languages}
              variant={translateOn ? "primary" : "secondary"}
              title={t("rss.translateHint")}
              onClick={toggleTranslate}
            >
              {translating ? t("rss.translating") : t("rss.translate")}
            </Btn>
            <button
              type="button"
              className="icon-btn"
              title={t("rss.settingsTitle")}
              aria-label={t("rss.settingsTitle")}
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={15} />
            </button>
            {translateOn && engine === "local" && tps ? (
              <span className="muted-sm" style={{ whiteSpace: "nowrap" }}>
                ⚡ {tps.toFixed(1)} {t("rss.tps")}
              </span>
            ) : null}
            {(["all", "unread", "saved"] as Filter[]).map((f) => (
              <Btn key={f} variant={filter === f ? "primary" : "secondary"} onClick={() => setFilter(f)}>
                {t(`rss.filter.${f}`)}
              </Btn>
            ))}
            <label className="rss-search" title={searchMode === "semantic" ? t("rss.searchSemantic") : undefined}>
              <Search size={13} />
              <input
                placeholder={t("rss.searchPh")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query.trim() && searchMode === "semantic" && (
                <span className="muted-sm" style={{ whiteSpace: "nowrap" }}>
                  ✦ {t("rss.searchSemanticTag")}
                </span>
              )}
            </label>
          </div>
          {items.length === 0 && (
            <Glass className="muted-sm" style={{ padding: 14 }}>
              {feeds.length === 0 ? t("rss.emptyNoFeeds") : t("rss.emptyItems")}
            </Glass>
          )}
          <div className="rss-grid">
            {items.slice(0, shown).map((it) => (
              <RssTile
                key={it.id}
                it={it}
                active={selected?.id === it.id}
                date={fmtDate(it.published)}
                onOpen={open}
                lang={lang}
                translated={translateOn}
                onContext={onTileContext}
              />
            ))}
          </div>
          {shown < items.length && <div ref={sentinel} style={{ height: 1 }} />}
        </div>

        {settingsOpen && pageActive && (
          <RssSettings
            engine={engine}
            onEngine={chooseEngine}
            onClose={() => setSettingsOpen(false)}
            intervalMin={intervalMin}
            onInterval={changeInterval}
            cfg={cfg}
            onCfg={saveCfg}
          />
        )}
        {selected && pageActive && (
          <RssReader
            item={selected}
            date={fmtDate(selected.published)}
            busy={busy}
            onClose={() => setSelected(null)}
            onReadLater={() => void readLater(selected)}
            onToggleSaved={() => void toggleSaved(selected)}
            translated={translateOn}
            engine={engine}
          />
        )}
      </div>
    </div>
  );
}

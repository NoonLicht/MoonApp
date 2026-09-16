import { useState, useEffect, useMemo, useRef } from "react";
import {
  Star,
  Download,
  Trash2,
  Plus,
  Play,
  Inbox,
  RefreshCw,
  Globe,
  Box,
  Copy,
  ArrowUp,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import ToolbarSearch from "@/components/ToolbarSearch";
import {
  Glass,
  Btn,
  IconBtn,
  SectionHead,
  Select,
  Field,
  EmptyHint,
  Badge,
  ProgressBar,
} from "@/components/ui";
import { useContextMenu, copyToClipboard } from "@/components/ContextMenu";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { AppItem } from "@/api/types";

const CATEGORIES = [
  "Browser",
  "Dev Tools",
  "Media",
  "Utilities",
  "Security",
  "Office",
  "Comms",
  "Other",
  "winget",
];
const SOURCE_TONE: Record<string, string> = { winget: "violet", comss: "teal", custom: "amber" };

interface ProgState {
  done: number;
  total: number;
  current: string;
  items: unknown[];
  status?: string;
  error?: string;
}

interface WingetIdx {
  state: string;
  cached: number;
  done?: number;
  total?: number;
}

export default function StorePage() {
  const { t } = useI18n();
  const menu = useContextMenu();
  const [items, setItems] = useState<AppItem[]>([]);
  const [live, setLive] = useState<AppItem[]>([]);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("All");
  const [tab, setTab] = useState("all");
  const [favOnly, setFavOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [downBusy, setDownBusy] = useState<string | null>(null);
  const [bulkMsg, setBulkMsg] = useState("");
  const [scraping, setScraping] = useState(false);
  const [prog, setProg] = useState<ProgState | null>(null);
  const [wingetIdx, setWingetIdx] = useState<WingetIdx | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", category: "Other" });
  const [error, setError] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Скролл-контейнер сетки и кнопка «В начало» (показывается после прокрутки).
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
  const [showTop, setShowTop] = useState(false);

  const load = () =>
    api
      .getApps()
      .then((d) => setItems(d.items))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  // Автозапуск полной индексации winget (a-z, 0-9) + опрос статуса
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      const st = await api.wingetStatus().catch(() => null);
      if (!st) return;
      if (st.state === "none") await api.wingetIndex().catch(() => {});
      const poll = async () => {
        const s = await api.wingetStatus().catch(() => null);
        if (!s) return;
        setWingetIdx(s);
        if (s.state === "indexing") timer = setTimeout(poll, 1500);
        else if (s.state === "ready" && s.cached > 0) load();
      };
      timer = setTimeout(poll, 1200);
    })();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Живой поиск по winget
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (!q) {
      setLive([]);
      return;
    }
    searchTimer.current = setTimeout(() => {
      api
        .wingetSearch(q)
        .then((found) => setLive(found))
        .catch(() => setLive([]));
    }, 400);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query]);

  const all = useMemo(() => {
    const map = new Map<string, AppItem>();
    for (const a of items) map.set(a.key, a);
    for (const a of live) if (!map.has(a.key)) map.set(a.key, a);
    return [...map.values()];
  }, [items, live]);

  const results = useMemo(() => {
    const q = query.toLowerCase();
    return all.filter(
      (a) =>
        (tab === "all" ? true : tab === "winget" ? a.source === "winget" : a.source !== "winget") &&
        (favOnly ? a.favorite : true) &&
        (cat === "All" || a.category === cat) &&
        (!q ||
          a.name.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q) ||
          (a.wingetId || "").toLowerCase().includes(q)),
    );
  }, [all, query, cat, favOnly, tab]);

  const counts = useMemo<Record<string, number>>(
    () => ({
      all: all.length,
      winget: all.filter((a) => a.source === "winget").length,
      comss: all.filter((a) => a.source !== "winget").length,
    }),
    [all],
  );
  async function toggleFav(item: AppItem) {
    const r = await api.favoriteApp(item.key);
    const patch = (list: AppItem[]) =>
      list.map((a) => (a.key === item.key ? { ...a, favorite: r.favorite } : a));
    setItems(patch);
    setLive(patch);
  }

  async function install(item: AppItem) {
    setBusy(item.key);
    setError("");
    setBulkMsg("");
    try {
      const r = (await api.installApp(item.key)) as {
        method?: string;
        ok?: boolean;
        file?: string;
      };
      if (r.method === "winget")
        setBulkMsg(r.ok ? t("store.installOk", { name: item.name }) : t("store.installFail"));
      else setBulkMsg(t("store.installerLaunched", { file: r.file }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Скачивание установщика без установки (файл падает в папку загрузок).
  async function downloadOnly(item: AppItem) {
    setDownBusy(item.key);
    setError("");
    setBulkMsg("");
    try {
      const r = (await api.downloadApp(item.key)) as { ok?: boolean; file?: string; dir?: string };
      if (r.file) setBulkMsg(t("store.downloadOk", { file: r.file }));
      else setBulkMsg(t("store.downloadDir", { dir: r.dir || "" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownBusy(null);
    }
  }

  async function parseComss() {
    setScraping(true);
    setError("");
    setBulkMsg("");
    setProg({ done: 0, total: 0, current: "", items: [] });
    try {
      const cats = (await api.comssCategories()) as { code: string }[];
      const codes = cats.map((c) => c.code);
      const { jobId } = await api.comssScrape(codes, 0);
      const started = Date.now();
      while (Date.now() - started < 15 * 60 * 1000) {
        const p = (await api.comssProgress(jobId).catch(() => null)) as {
          done: number;
          total: number;
          current: string;
          status?: string;
          error?: string;
          items?: unknown[];
        } | null;
        if (!p) {
          await new Promise((r) => setTimeout(r, 700));
          continue;
        }
        setProg({
          done: p.done,
          total: p.total,
          current: p.current || "",
          items: p.items || [],
          status: p.status,
          error: p.error,
        });
        if (p.status === "done" || p.status === "error") {
          if (p.status === "error") setError(p.error || t("store.comssError"));
          else if (p.items?.length) {
            const imp = await api.comssImport(p.items);
            await load();
            setBulkMsg(
              t("store.comssDone", {
                found: p.items.length,
                added: imp.added,
                skipped: imp.skipped,
              }),
            );
          } else {
            setBulkMsg(t("store.comssNone"));
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      setProg(null);
    } catch (e) {
      setError((e as Error).message);
      setProg(null);
    } finally {
      setScraping(false);
    }
  }

  async function addCustom() {
    setError("");
    if (!form.name.trim() || !form.url.trim()) {
      setError(t("store.fillError"));
      return;
    }
    try {
      const app = (await api.addCatalog(form.name.trim(), form.url.trim(), form.category)) as {
        id: number;
        name: string;
        url: string;
        category: string;
      };
      setItems((list) => [
        {
          key: `catalog:${app.id}`,
          id: app.id,
          name: app.name,
          url: app.url,
          category: app.category,
          source: "custom",
          favorite: false,
        },
        ...list,
      ]);
      setForm({ name: "", url: "", category: "Other" });
      setAddOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(item: AppItem) {
    if (!item.id) return;
    await api.deleteCatalog(item.id);
    setItems((list) => list.filter((a) => a.key !== item.key));
  }

  const favCount = all.filter((a) => a.favorite).length;

  // Пагинация: 20/40/80 на страницу. Начальное значение берётся из настроек
  // (store.pageSize), чтобы выбор в «Настройках» применялся к магазину.
  const [pageSize, setPageSize] = useState(40);
  const [page, setPage] = useState(1);
  useEffect(() => {
    api
      .getSettings()
      .then((s: any) => {
        const p = Number(s?.store?.pageSize);
        if ([20, 40, 80].includes(p)) setPageSize(p);
      })
      .catch(() => {
        /* дефолт 40 */
      });
  }, []);
  useEffect(() => {
    setPage(1);
  }, [query, cat, favOnly, tab]);
  // Возврат к началу списка при смене страницы/фильтра (иначе остаёшься внизу).
  useEffect(() => {
    gridWrapRef.current?.scrollTo({ top: 0 });
    setShowTop(false);
  }, [query, cat, favOnly, tab, page]);

  const onGridScroll = () => {
    const el = gridWrapRef.current;
    if (!el) return;
    const next = el.scrollTop > 300;
    setShowTop((prev) => (prev === next ? prev : next));
  };
  const totalPages = Math.max(1, Math.ceil(results.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const shown = results.slice((safePage - 1) * pageSize, safePage * pageSize);
  const goPage = (p: number) => setPage(Math.min(Math.max(1, p), totalPages));
  // «В начало»: вернуть на первую страницу списка И прокрутить сетку наверх.
  // Нужно, когда ушёл далеко по страницам: кнопка «1» в пейджере пропадает из
  // окна номеров (показываются только 5 страниц вокруг текущей).
  const goFirst = () => {
    goPage(1);
    gridWrapRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };
  // Номера страниц: окно вокруг текущей + ВСЕГДА первая и последняя (с «…»),
  // иначе при уходе далеко кнопка «1» пропадала и вернуться было нечем.
  const pageItems: (number | "gap")[] = [];
  {
    const window = 2;
    const start = Math.max(1, safePage - window);
    const end = Math.min(totalPages, safePage + window);
    if (start > 1) {
      pageItems.push(1);
      if (start > 2) pageItems.push("gap");
    }
    for (let i = start; i <= end; i++) pageItems.push(i);
    if (end < totalPages) {
      if (end < totalPages - 1) pageItems.push("gap");
      pageItems.push(totalPages);
    }
  }
  const tabLabel =
    tab === "all"
      ? t("store.tabAll")
      : tab === "winget"
        ? t("store.tabWinget")
        : t("store.tabComss");

  return (
    <div className="page page-fill">
      <SectionHead
        eyebrow={t("store.eyebrow", {
          count: counts[tab],
          tab: tabLabel,
          fav: favCount,
          pages: totalPages,
        })}
        title={t("store.title")}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              variant="primary"
              icon={scraping ? RefreshCw : Globe}
              onClick={parseComss}
              disabled={scraping}
            >
              {scraping ? t("store.parsing") : t("store.parse")}
            </Btn>
            <Btn icon={Plus} onClick={() => setAddOpen((v) => !v)}>
              {addOpen ? t("store.close") : t("store.addApp")}
            </Btn>
          </div>
        }
      />

      {/* Вкладки: All / Winget / Comss */}
      <div className="tabs">
        {[
          { id: "all", label: t("store.tabAll") },
          { id: "winget", label: t("store.tabWinget") },
          { id: "comss", label: t("store.tabComss") },
        ].map((tb) => (
          <button
            key={tb.id}
            className={`tab ${tab === tb.id ? "is-active" : ""}`}
            onClick={() => setTab(tb.id)}
          >
            {tb.label}
            <span className="tab-count">{counts[tb.id]}</span>
          </button>
        ))}
      </div>

      <Glass className="url-bar" style={{ padding: "6px 10px" }}>
        {/* Поиск по приложениям: в широкой панели — гибким полем, ниже 1200px —
            иконкой с поповером чуть ниже панели (src/components/ToolbarSearch.tsx). */}
        <ToolbarSearch
          value={query}
          onChange={setQuery}
          placeholder={t("store.search")}
          title={t("store.search")}
          clearTitle={t("common.clear")}
          bare
        />
        <button
          className="badge"
          onClick={() => setFavOnly((v) => !v)}
          style={{
            border: "none",
            background: "var(--track)",
            cursor: "pointer",
            color: favOnly ? "var(--amber)" : "var(--text-tertiary)",
          }}
        >
          <Star
            size={12}
            fill={favOnly ? "currentColor" : "none"}
            style={{ verticalAlign: -2, marginRight: 4 }}
          />
          {t("store.favorites")}
        </button>
        <Select
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          options={["All", ...CATEGORIES]}
        />
      </Glass>

      {/* Живой прогресс парсинга comss */}
      {prog && (
        <Glass className="chart-panel">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <div className="muted-sm">
              {t("store.progress")}{" "}
              <b style={{ color: "var(--text-primary)" }}>{prog.current || "…"}</b>
            </div>
            <div className="muted-sm" style={{ fontFamily: "var(--font-mono)" }}>
              {t("store.found", { done: prog.done, total: prog.total, n: prog.items?.length || 0 })}
            </div>
          </div>
          <ProgressBar value={prog.total ? Math.round((prog.done / prog.total) * 100) : 0} />
        </Glass>
      )}

      {/* Статус индексации полного каталога winget */}
      {wingetIdx && wingetIdx.state === "indexing" && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--violet)" }}>
          <RefreshCw size={15} className="spin" />
          <span>
            {t("store.wingetIndex", {
              done: wingetIdx.done,
              total: wingetIdx.total,
              cached: wingetIdx.cached,
            })}
          </span>
        </Glass>
      )}

      {addOpen && (
        <Glass className="settings-drawer">
          <Field label={t("store.name")} w={220}>
            <input
              className="text-input"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Discord"
            />
          </Field>
          <Field label={t("store.url")} w={340}>
            <input
              className="text-input"
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              placeholder="https://…/setup.exe"
            />
          </Field>
          <Field label={t("store.category")} w={150}>
            <Select
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              options={CATEGORIES}
            />
          </Field>
          <Btn variant="primary" onClick={addCustom} style={{ marginTop: 22 }}>
            {t("store.submit")}
          </Btn>
        </Glass>
      )}

      {(error || bulkMsg) && (
        <Glass
          className="source-placeholder"
          style={{
            borderColor: error ? "var(--coral)" : "var(--teal)",
            color: "var(--text-secondary)",
          }}
        >
          <span>{error || bulkMsg}</span>
        </Glass>
      )}
      <div className="store-grid-wrap" ref={gridWrapRef} onScroll={onGridScroll}>
        <div className="store-grid">
          {shown.map((a) => (
            <Glass
              className="app-card"
              key={a.key}
              onContextMenu={(e) =>
                menu.open(e, [
                  { label: t("ctx.install"), icon: Download, onClick: () => install(a) },
                  { label: t("ctx.download"), icon: Download, onClick: () => downloadOnly(a) },
                  {
                    label: a.favorite ? t("ctx.favRemove") : t("ctx.favAdd"),
                    icon: Star,
                    onClick: () => toggleFav(a),
                  },
                  { separator: true },
                  { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(a.name) },
                  a.wingetId
                    ? {
                        label: t("ctx.copyId"),
                        icon: Copy,
                        onClick: () => copyToClipboard(a.wingetId || ""),
                      }
                    : {
                        label: t("ctx.copyLink"),
                        icon: Copy,
                        onClick: () => copyToClipboard(a.url || ""),
                      },
                  a.source !== "winget" && { separator: true },
                  a.source !== "winget" && {
                    label: t("ctx.remove"),
                    icon: Trash2,
                    danger: true,
                    onClick: () => remove(a),
                  },
                ])
              }
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <span className={`app-glyph tone-${SOURCE_TONE[a.source] || "violet"}`}>
                  {a.source === "winget" ? (
                    <Box size={18} />
                  ) : a.source === "comss" ? (
                    <Globe size={18} />
                  ) : (
                    a.name.slice(0, 2).toUpperCase()
                  )}
                </span>
                <button
                  title={a.favorite ? t("store.rmFavTitle") : t("store.addFavTitle")}
                  onClick={() => toggleFav(a)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: a.favorite ? "var(--amber)" : "var(--text-tertiary)",
                  }}
                >
                  <Star size={18} fill={a.favorite ? "currentColor" : "none"} />
                </button>
              </div>
              <div className="app-name" title={a.name}>
                {a.name}
              </div>
              <div className="app-meta">
                <Badge tone={SOURCE_TONE[a.source] || "violet"} mono>
                  {a.source}
                </Badge>
                <span>{a.category}</span>
              </div>
              <div
                className="muted-sm"
                style={{
                  fontFamily: "var(--font-mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={a.wingetId || a.url || ""}
              >
                {a.wingetId
                  ? a.wingetId + (a.version ? ` · ${a.version}` : "")
                  : (a.url || "").replace(/^https?:\/\//, "")}
              </div>
              <div className="app-actions">
                <IconBtn
                  icon={downBusy === a.key ? RefreshCw : Download}
                  onClick={() => downloadOnly(a)}
                  disabled={downBusy === a.key || busy === a.key}
                  title={t("store.downloadTitle")}
                />
                <Btn
                  variant="primary"
                  icon={busy === a.key ? RefreshCw : Play}
                  onClick={() => install(a)}
                  disabled={busy === a.key || downBusy === a.key}
                >
                  {busy === a.key ? "…" : t("store.install")}
                </Btn>
                {a.source !== "winget" && (
                  <IconBtn icon={Trash2} onClick={() => remove(a)} title={t("store.rmTitle")} />
                )}
              </div>
            </Glass>
          ))}
        </div>
        {results.length === 0 && <EmptyHint icon={Inbox} text={t("store.empty")} />}
      </div>

      {/* «В начало»: видна при прокрутке вниз ИЛИ когда открыта не первая
          страница пагинации (чтобы всегда был быстрый возврат на страницу 1). */}
      {(showTop || safePage > 1) && (
        <button
          className="store-top-btn"
          onClick={goFirst}
          title={t("store.backToTop")}
          aria-label={t("store.backToTop")}
        >
          <ArrowUp size={16} />
        </button>
      )}

      {/* Пагинация */}
      {totalPages > 1 && (
        <div className="pager">
          <button
            className="pager-btn"
            disabled={safePage === 1}
            onClick={goFirst}
            title={t("store.firstPage")}
            aria-label={t("store.firstPage")}
          >
            <ChevronsLeft size={14} />
          </button>
          <button
            className="pager-btn"
            disabled={safePage === 1}
            onClick={() => goPage(safePage - 1)}
          >
            {t("store.prev")}
          </button>
          {pageItems.map((p, i) =>
            p === "gap" ? (
              <span key={`gap-${i}`} className="pager-gap">
                …
              </span>
            ) : (
              <button
                key={p}
                className={`pager-page ${p === safePage ? "is-active" : ""}`}
                onClick={() => goPage(p)}
              >
                {p}
              </button>
            ),
          )}
          <button
            className="pager-btn"
            disabled={safePage === totalPages}
            onClick={() => goPage(safePage + 1)}
          >
            {t("store.next")}
          </button>
          <button
            className="pager-btn"
            disabled={safePage === totalPages}
            onClick={() => goPage(totalPages)}
            title={t("store.lastPage")}
            aria-label={t("store.lastPage")}
          >
            <ChevronsRight size={14} />
          </button>
          <div className="page-size">
            <Select
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              options={["20", "40", "80"]}
            />
            <span className="field-label">{t("store.perPage")}</span>
          </div>
          <span className="pager-info">
            {t("store.page", { page: safePage, total: totalPages })}
          </span>
        </div>
      )}
    </div>
  );
}

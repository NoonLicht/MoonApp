import React, { useState, useEffect, useCallback, useRef } from "react";
import { Search, BookOpen, Download, RefreshCw, Loader2, Filter, ScrollText } from "lucide-react";
import { Glass, Btn, Badge, Select, SectionHead, EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { FlibustaBook, BooksCatalogStats } from "../api/types";

export default function BooksPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<FlibustaBook[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(40);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<number | null>(null);
  const [stats, setStats] = useState<BooksCatalogStats | null>(null);
  const [syncStatus, setSyncStatus] = useState<{ running: boolean; added: number; error: string } | null>(null);
  const busyRef = useRef(false);

  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [lang, setLang] = useState("");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [liveMode, setLiveMode] = useState(false);
  const [liveQuery, setLiveQuery] = useState("");

  const doSearch = useCallback(async (p: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (genre) params.set("genre", genre);
      if (lang) params.set("lang", lang);
      if (yearFrom) params.set("yearFrom", yearFrom);
      if (yearTo) params.set("yearTo", yearTo);
      params.set("page", String(p));
      params.set("pageSize", String(pageSize));
      const res = await api.getBooks(params.toString());
      setItems(res.items);
      setTotal(res.total);
      setPage(p);
      setHasMore(res.hasMore);
      setStats(res.stats);
    } catch { /* */ }
    setLoading(false);
    busyRef.current = false;
  }, [query, genre, lang, yearFrom, yearTo, pageSize]);
const doLiveSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setItems([]); setTotal(0); return; }
    setLoading(true);
    try {
      const res = await api.booksLiveSearch(q, 0);
      setItems(res.books || []);
      setTotal((res.books || []).length);
      setHasMore(!!res.next);
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { doSearch(1); }, [doSearch]);

  useEffect(() => {
    if (!liveMode) return;
    const id = setTimeout(() => doLiveSearch(liveQuery), 250);
    return () => clearTimeout(id);
  }, [liveQuery, liveMode, doLiveSearch]);

  const handleDownload = async (bid: number, fmt: string) => {
    setDownloading(bid);
    try {
      const result = await api.downloadBook(bid, fmt);
      alert(t("books.downloaded", { file: result.name }));
    } catch (e: any) {
      alert(e.message || "Download error");
    }
    setDownloading(null);
  };

  const handleSync = async (mode: string) => {
    setSyncStatus({ running: true, added: 0, error: "" });
    try {
      const res = await api.startBooksSync(mode);
      if (res.status) setSyncStatus({ running: res.status.running, added: res.status.added, error: res.status.error });
      const poll = setInterval(async () => {
        const s = await api.getBooksSyncStatus();
        setSyncStatus({ running: s.running, added: s.added, error: s.error });
        if (!s.running) { clearInterval(poll); doSearch(1); }
      }, 1200);
    } catch (e: any) { setSyncStatus({ running: false, added: 0, error: e.message }); }
  };

  const handleImportDumps = async () => {
    setSyncStatus({ running: true, added: 0, error: "" });
    try {
      const res = await api.startBooksImport();
      if (!res.ok) return;
      const poll = setInterval(async () => {
        const s = await api.getBooksImportStatus();
        setSyncStatus({ running: s.running, added: s.added, error: s.error });
        if (!s.running) { clearInterval(poll); doSearch(1); }
      }, 1200);
    } catch (e: any) { setSyncStatus({ running: false, added: 0, error: e.message }); }
  };

  const handleResetCatalog = async () => {
    if (!window.confirm("Очистить весь каталог книг? Это удалит базу данных и все синхронизированные книги.")) return;
    setSyncStatus({ running: false, added: 0, error: "" });
    try {
      await api.resetBooksCatalog();
      setItems([]);
      setTotal(0);
      setStats(null);
    } catch (e: any) { setSyncStatus({ running: false, added: 0, error: e.message }); }
  };

  // — Временная кнопка логов импорта —
  const [showImportLogs, setShowImportLogs] = useState(false);
  const [importLogs, setImportLogs] = useState<{ ts: string; msg: string }[]>([]);
  const logPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const handleOpenImportLogs = async () => {
    setShowImportLogs(true);
    try { setImportLogs(await api.getBooksImportLogs(500)); } catch { /* ignore */ }
    logPollRef.current = setInterval(async () => {
      try { setImportLogs(await api.getBooksImportLogs(500)); } catch { /* ignore */ }
    }, 2000);
  };
  const handleCloseImportLogs = () => {
    setShowImportLogs(false);
    if (logPollRef.current) { clearInterval(logPollRef.current); logPollRef.current = null; }
  };
  useEffect(() => {
    return () => { if (logPollRef.current) clearInterval(logPollRef.current); };
  }, []);
usePageToolbar(
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {!syncStatus?.running && (
        <>
          <Btn icon={RefreshCw} variant="secondary" onClick={() => handleSync("new")} style={{ fontSize: 11 }}>
            {t("books.syncNew")}
          </Btn>
          <Btn icon={RefreshCw} variant="secondary" onClick={() => handleSync("genres")} style={{ fontSize: 11 }}>
            {t("books.syncAll")}
          </Btn>
          <Btn icon={Download} variant="secondary" onClick={() => handleImportDumps()} style={{ fontSize: 11 }}>
            Импорт из дампов
          </Btn>
          <Btn icon={ScrollText} variant="ghost" onClick={handleOpenImportLogs} style={{ fontSize: 11 }}>
            Логи импорта
          </Btn>
          <Btn icon={RefreshCw} variant="danger" onClick={() => handleResetCatalog()} style={{ fontSize: 11 }}>
            Очистить БД
          </Btn>
        </>
      )}
      {(query || genre || lang || yearFrom || yearTo) && !liveMode && (
        <Btn icon={Filter} variant="ghost" onClick={() => { setQuery(""); setGenre(""); setLang(""); setYearFrom(""); setYearTo(""); doSearch(1); }} style={{ fontSize: 11 }}>
          {t("books.clearFilters")}
        </Btn>
      )}
    </div>,
    [syncStatus, query, genre, lang, yearFrom, yearTo, liveMode, t, handleSync, handleImportDumps, handleOpenImportLogs, handleResetCatalog, doSearch]
  );
const statLine = stats ? `${t("common.all")}: ${stats.count}` : "";

  // Пагинация
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const goPage = (p: number) => {
    const np = Math.min(Math.max(1, p), totalPages);
    setPage(np);
    doSearch(np);
  };
  const from = Math.max(1, safePage - 2);
  const to = Math.min(totalPages, from + 4);
  const pageList: number[] = [];
  for (let i = from; i <= to; i++) pageList.push(i);

  return (
    <div className="page-fill">
      <SectionHead eyebrow={statLine} title={t("books.title")} />

      <Glass className="url-bar" style={{ marginBottom: 12 }}>
        <Search size={16} />
        <input
          placeholder={t("books.search")}
          value={liveMode ? liveQuery : query}
          onChange={(e) => {
            if (liveMode) setLiveQuery(e.target.value);
            else { setQuery(e.target.value); setPage(1); }
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && !liveMode) doSearch(1); }}
          style={{ flex: 1 }}
        />
      </Glass>

      {!liveMode && stats && (
        <div className="book-filters" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, padding: "0 4px" }}>
          <Select
            value={lang}
            onChange={(e) => { setLang(e.target.value); doSearch(1); }}
            options={[{ value: "", label: `Язык: все` }, ...stats.langs.map((l: string) => ({ value: l, label: l }))]}
            style={{ minWidth: 90, fontSize: 12 }}
          />
          <input type="number" placeholder="Год с" value={yearFrom}
            onChange={(e) => setYearFrom(e.target.value)} onBlur={() => doSearch(1)}
            style={{ width: 64, padding: "4px 6px" }} />
          <input type="number" placeholder="Год по" value={yearTo}
            onChange={(e) => setYearTo(e.target.value)} onBlur={() => doSearch(1)}
            style={{ width: 64, padding: "4px 6px" }} />
        </div>
      )}
{syncStatus?.running && (
        <Glass style={{ padding: 8, marginBottom: 12, fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
          <Loader2 size={14} className="spin" /> {t("books.syncing", { n: syncStatus.added })}
        </Glass>
      )}
      {!syncStatus?.running && syncStatus?.error && !syncStatus?.added && (
        <Glass style={{ padding: 8, marginBottom: 12, fontSize: 12, display: "flex", gap: 8, alignItems: "center", borderColor: "var(--coral)" }}>
          <span style={{ color: "var(--coral)" }}>⚠ {syncStatus.error}</span>
        </Glass>
      )}

      <div className="book-list" style={{ flex: 1, maxHeight: "none" }}>
        {items.map((b) => (
          <Glass className="book-row" key={b.id}>
            <div className="book-cover">
              {b.cover
                ? <img src={b.cover} alt="" style={{ width: 44, height: 64, objectFit: "cover", borderRadius: 4 }} />
                : <BookOpen size={20} strokeWidth={1.6} />
              }
            </div>
            <div className="book-body">
              <div className="book-title-row">
                <div>
                  <div className="media-title">{b.title}</div>
                  <div className="muted-sm">
                    {b.author}{b.year ? ` · ${b.year}` : ""}{b.sizeText ? ` · ${b.sizeText}` : ""}
                  </div>
                </div>
                <div className="quality-row">
                  {(b.genres || []).slice(0, 3).map((g: string) => <Badge key={g}>{g}</Badge>)}
                </div>
              </div>
              <p className="book-desc">{b.description?.slice(0, 200)}</p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                {(b.formats || ["fb2", "epub", "mobi"]).map((fmt: string) => (
                  <Btn key={fmt} variant="secondary" icon={Download}
                    disabled={downloading === b.bid}
                    onClick={() => handleDownload(b.bid, fmt)}
                    style={{ fontSize: 11, padding: "2px 8px" }}>
                    {fmt.toUpperCase()}
                  </Btn>
                ))}
              </div>
            </div>
          </Glass>
        ))}
        {items.length === 0 && !loading && <EmptyHint icon={BookOpen} text={t("books.empty")} />}
      </div>

      {/* Пагинация */}
      {totalPages > 1 && !liveMode && (
        <div className="pager">
          <button className="pager-btn" disabled={safePage === 1} onClick={() => goPage(safePage - 1)}>{t("books.prev")}</button>
          {pageList.map((p) => (
            <button key={p} className={`pager-page ${p === safePage ? "is-active" : ""}`} onClick={() => goPage(p)}>{p}</button>
          ))}
          <button className="pager-btn" disabled={safePage === totalPages} onClick={() => goPage(safePage + 1)}>{t("books.next")}</button>
          <div className="page-size">
            <Select value={String(pageSize)} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); doSearch(1); }} options={["20", "40", "80"]} />
            <span className="field-label">{t("books.perPage")}</span>
          </div>
          <span className="pager-info">{t("books.page", { page: safePage, total: totalPages })}</span>
        </div>
      )}

      {showImportLogs && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999,
          background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center",
        }} onClick={handleCloseImportLogs}>
          <div style={{
            width: "90vw", height: "80vh", background: "#111", border: "1px solid #333",
            borderRadius: 8, display: "flex", flexDirection: "column", overflow: "hidden",
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #333" }}>
              <strong style={{ color: "#aaa", fontSize: 12 }}>Логи импорта (обновление каждые 2 с)</strong>
              <span onClick={handleCloseImportLogs} style={{ cursor: "pointer", color: "#888", fontSize: 14 }}>✕</span>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "8px 12px", font: "11px/1.5 monospace", color: "#0f0" }}>
              {importLogs.length === 0
                ? <span style={{ color: "#555" }}>Логов пока нет — запустите импорт</span>
                : importLogs.map((l, i) => (
                    <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      <span style={{ color: "#888" }}>{l.ts}</span> <span>{l.msg}</span>
                    </div>
                  ))
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
import React, { useState, useEffect, useCallback, useRef } from "react";
import { Search, BookOpen, Download, RefreshCw, Loader2, Filter } from "lucide-react";
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
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<number | null>(null);
  const [stats, setStats] = useState<BooksCatalogStats | null>(null);
  const [syncStatus, setSyncStatus] = useState<{ running: boolean; added: number; error: string } | null>(null);
  const busyRef = useRef(false);

  // Фильтры
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [lang, setLang] = useState("");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [liveMode, setLiveMode] = useState(false);
  const [liveQuery, setLiveQuery] = useState("");

  /** Поиск по локальному каталогу (пагинированный). */
  const doSearch = useCallback(async (p: number, reset?: boolean) => {
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
      params.set("pageSize", "40");
      const res = await api.getBooks(params.toString());
      setItems(reset ? res.items : (s) => [...s, ...res.items]);
      setTotal(res.total);
      setPage(p);
      setHasMore(res.hasMore);
      setStats(res.stats);
    } catch { /* silently */ }
    setLoading(false);
    busyRef.current = false;
  }, [query, genre, lang, yearFrom, yearTo]);

  /** Живой OPDS-поиск (без хранения). */
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

  // Первичная загрузка
  useEffect(() => { doSearch(1, true); }, [doSearch]);

  // Живой поиск при изменении liveQuery
  useEffect(() => {
    if (!liveMode) return;
    const id = setTimeout(() => doLiveSearch(liveQuery), 250);
    return () => clearTimeout(id);
  }, [liveQuery, liveMode, doLiveSearch]);

  // Скачивание книги
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

  // Синхронизация
  const handleSync = async (mode: string) => {
    setSyncStatus({ running: true, added: 0, error: "" });
    try {
      const res = await api.startBooksSync(mode);
      if (res.status) setSyncStatus({ running: res.status.running, added: res.status.added, error: res.status.error });
      const poll = setInterval(async () => {
        const s = await api.getBooksSyncStatus();
        setSyncStatus({ running: s.running, added: s.added, error: s.error });
        if (!s.running) { clearInterval(poll); doSearch(1, true); }
      }, 1000);
    } catch { setSyncStatus({ running: false, added: 0, error: "error" }); }
  };

  // Очистить фильтры
  const clearFilters = () => {
    setQuery(""); setGenre(""); setLang(""); setYearFrom(""); setYearTo("");
    setLiveMode(false); setLiveQuery("");
    doSearch(1, true);
  };

  const statLine = stats
    ? t("books.results", { n: total || 0, g: stats.genres?.length || 0, l: stats.langs?.length || 0, total: stats.count })
    : "";

  usePageToolbar(
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Btn variant="secondary" icon={Filter} onClick={clearFilters} disabled={!genre && !lang && !yearFrom} style={{ fontSize: 12 }}>
        {t("books.clearFilters")}
      </Btn>
      <Btn variant="secondary" icon={RefreshCw} onClick={() => handleSync("new")} disabled={syncStatus?.running} style={{ fontSize: 12 }}>
        {syncStatus?.running ? "..." : t("books.syncNew")}
      </Btn>
      <Btn variant="secondary" icon={RefreshCw} onClick={() => handleSync("genres")} disabled={syncStatus?.running} style={{ fontSize: 12 }}>
        {syncStatus?.running ? "..." : t("books.syncAll")}
      </Btn>
    </div>,
    [syncStatus, genre, lang, yearFrom, t]
  );

  return (
    <div className="page">
      <SectionHead eyebrow={statLine} title={t("books.title")} />

      {/* Поиск */}
      <Glass className="url-bar" style={{ marginBottom: 12 }}>
        <Search size={16} />
        <input
          placeholder={t("books.search")}
          value={liveMode ? liveQuery : query}
          onChange={(e) => {
            if (liveMode) setLiveQuery(e.target.value);
            else { setQuery(e.target.value); setPage(1); }
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && !liveMode) doSearch(1, true); }}
          style={{ flex: 1 }}
        />
      </Glass>

      {/* Фильтры */}
      {!liveMode && stats && (
        <div className="book-filters" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, padding: "0 4px" }}>
          <Select
            value={lang}
            onChange={(e) => { setLang(e.target.value); doSearch(1, true); }}
            options={[{ value: "", label: `Язык: все` }, ...stats.langs.map((l: string) => ({ value: l, label: l }))]}
            style={{ minWidth: 90, fontSize: 12 }}
          />
          <input type="number" placeholder="Год с" value={yearFrom}
            onChange={(e) => setYearFrom(e.target.value)} onBlur={() => doSearch(1, true)}
            style={{ width: 64, padding: "4px 6px" }} />
          <input type="number" placeholder="Год по" value={yearTo}
            onChange={(e) => setYearTo(e.target.value)} onBlur={() => doSearch(1, true)}
            style={{ width: 64, padding: "4px 6px" }} />
        </div>
      )}

      {/* Синхронизация */}
      {syncStatus?.running && (
        <Glass style={{ padding: 8, marginBottom: 12, fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
          <Loader2 size={14} className="spin" /> {t("books.syncing", { n: syncStatus.added })}
        </Glass>
      )}

      {/* Книги */}
      <div className="book-list">
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
      {hasMore && !liveMode && (
        <div style={{ textAlign: "center", padding: 16 }}>
          <Btn variant="primary" onClick={() => doSearch(page + 1)} disabled={loading}>
            {loading ? "..." : `${t("common.loadMore")} (${total - page * 40})`}
          </Btn>
        </div>
      )}
    </div>
  );
}
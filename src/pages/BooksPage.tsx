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

  const [titleQ, setTitleQ] = useState("");
  const [authorQ, setAuthorQ] = useState("");
  // — Модалка информации о книге —
  const [selectedBook, setSelectedBook] = useState<FlibustaBook | null>(null);
  const handleBookClick = (book: FlibustaBook) => setSelectedBook(book);
  const handleCloseBookInfo = () => setSelectedBook(null);
  const [liveMode, setLiveMode] = useState(false);
  const [liveQuery, setLiveQuery] = useState("");

  // Размер страницы и режим поиска по умолчанию берём из настроек (раздел «Книги»).
  useEffect(() => {
    api.getSettings().then((s: any) => {
      const b = s?.books || {};
      if (b.pageSize) setPageSize(Number(b.pageSize) || 40);
      if (b.preferLiveSearch) setLiveMode(true);
    }).catch(() => {});
  }, []);

  const doSearch = useCallback(async (p: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (titleQ) params.set("titleQ", titleQ);
      if (authorQ) params.set("authorQ", authorQ);
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
  }, [titleQ, authorQ, pageSize]);
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
    if (!window.confirm(t("books.resetConfirm"))) return;
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
      {(titleQ || authorQ) && !liveMode && (
        <Btn icon={Filter} variant="ghost" onClick={() => { setTitleQ(""); setAuthorQ(""); doSearch(1); }} style={{ fontSize: 11 }}>
          {t("books.clearFilters")}
        </Btn>
      )}
    </div>,
    [syncStatus, titleQ, authorQ, liveMode, t, handleSync, handleImportDumps, handleOpenImportLogs, handleResetCatalog, doSearch]
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

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <Glass className="url-bar" style={{ flex: 1, padding: "6px 10px" }}>
          <Search size={16} />
          <input
            placeholder={t("books.titleQ")}
            value={liveMode ? liveQuery : titleQ}
            onChange={(e) => {
              if (liveMode) setLiveQuery(e.target.value);
              else { setTitleQ(e.target.value); setPage(1); }
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && !liveMode) doSearch(1); }}
          />
        </Glass>
        <Glass className="url-bar" style={{ flex: 1, padding: "6px 10px" }}>
          <Search size={16} />
          <input
            placeholder={t("books.authorQ")}
            value={liveMode ? "" : authorQ}
            onChange={(e) => { setAuthorQ(e.target.value); setPage(1); }}
            onKeyDown={(e) => { if (e.key === "Enter") doSearch(1); }}
          />
        </Glass>
      </div>
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
          <Glass className="book-row" key={b.id} style={{ cursor: "pointer" }} onClick={() => handleBookClick(b)}>
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
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }} onClick={e => e.stopPropagation()}>
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
{/* Модалка информации о книге */}
      {selectedBook && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9998,
          background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center",
          backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)",
        }} onClick={handleCloseBookInfo}>
          <div style={{
            width: 600, maxWidth: "92vw", height: 540, background: "var(--glass-bg)",
            border: "1px solid var(--glass-border)", borderRadius: 16,
            boxShadow: "0 20px 60px rgba(0,0,0,0.5)", overflow: "hidden",
            display: "flex", flexDirection: "column",
          }} onClick={e => e.stopPropagation()}>
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "14px 18px 10px", borderBottom: "1px solid var(--glass-border)",
            }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedBook.title}
              </span>
              <span onClick={handleCloseBookInfo} style={{
                cursor: "pointer", color: "var(--text-secondary)", fontSize: 18,
                lineHeight: 1, marginLeft: 12, flexShrink: 0,
              }}>✕</span>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "16px 20px 20px" }}>
              <div style={{ display: "flex", gap: 18, marginBottom: 16 }}>
                <div style={{
                  width: 110, height: 154, borderRadius: 10, flexShrink: 0, overflow: "hidden",
                  background: "var(--card-bg)", display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {selectedBook.cover
                    ? <img src={selectedBook.cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <BookOpen size={32} strokeWidth={1.4} style={{ opacity: 0.35 }} />
                  }
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.3 }}>{selectedBook.title}</div>
                  <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>{selectedBook.author}</div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12.5, color: "var(--text-secondary)" }}>
                    {selectedBook.year && <span>📅 {selectedBook.year}</span>}
                    {selectedBook.language && <span>🌐 {selectedBook.language}</span>}
                    {selectedBook.sizeText && <span>💾 {selectedBook.sizeText}</span>}
                    {selectedBook.updatedAt && <span>🔄 {new Date(selectedBook.updatedAt).toLocaleDateString()}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
                    {(selectedBook.genres || []).map((g: string) => <Badge key={g}>{g}</Badge>)}
                  </div>
                </div>
              </div>
              {selectedBook.description && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.7 }}>Аннотация</div>
                  <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7, color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>
                    {selectedBook.description}
                  </p>
                </div>
              )}
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.7 }}>Скачать</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(selectedBook.formats || ["fb2", "epub", "mobi"]).map((fmt: string) => (
                    <Btn key={fmt} variant="secondary" icon={Download}
                      disabled={downloading === selectedBook.bid}
                      onClick={() => handleDownload(selectedBook.bid, fmt)}
                      style={{ fontSize: 12, padding: "4px 12px" }}>
                      {fmt.toUpperCase()}
                    </Btn>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

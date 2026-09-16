import { useState, useEffect, useCallback, useRef } from "react";
import {
  Search,
  BookOpen,
  Download,
  RefreshCw,
  Loader2,
  Star,
  AlertCircle,
  Copy,
  ChevronsDown,
} from "lucide-react";
import { Glass, Btn, Badge, SectionHead, EmptyHint } from "../components/ui";
import { useContextMenu, copyToClipboard } from "../components/ContextMenu";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { FlibustaBook, BookGenre } from "../api/types";

const PAGE_SIZE = 80;

/** Флажок языка по коду/названию из OPDS. */
const LANG_FLAGS: Record<string, string> = {
  ru: "🇷🇺",
  en: "🇬🇧",
  uk: "🇺🇦",
  de: "🇩🇪",
  fr: "🇫🇷",
  es: "🇪🇸",
  it: "🇮🇹",
  pl: "🇵🇱",
  ja: "🇯🇵",
  zh: "🇨🇳",
  cs: "🇨🇿",
  bg: "🇧🇬",
  be: "🇧🇾",
  sv: "🇸🇪",
  no: "🇳🇴",
  pt: "🇵🇹",
  nl: "🇳🇱",
  tr: "🇹🇷",
  he: "🇮🇱",
  ar: "🇸🇦",
  el: "🇬🇷",
  la: "🇻🇦",
  eo: "🌍",
};
function langBadge(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const code = lang.trim().toLowerCase().slice(0, 2);
  if (LANG_FLAGS[code]) return LANG_FLAGS[code];
  if (LANG_FLAGS[lang.trim().toLowerCase()]) return LANG_FLAGS[lang.trim().toLowerCase()];
  return code.toUpperCase();
}

type Tab = "new" | "popular" | "myfav";

export default function BooksPage() {
  const { t } = useI18n();
  const menu = useContextMenu();
  const [tab, setTab] = useState<Tab>("new");
  const [items, setItems] = useState<FlibustaBook[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState<number | null>(null);
  const [flags, setFlags] = useState<Record<string, { fav: boolean; bm: boolean }>>({});
  const [genres, setGenres] = useState<BookGenre[]>([]);
  const [popularFallback, setPopularFallback] = useState(false);
  const [titleQ, setTitleQ] = useState("");
  const [authorQ, setAuthorQ] = useState("");
  const [genresOpen, setGenresOpen] = useState(false);
  const [genreQ, setGenreQ] = useState("");
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [selectedBook, setSelectedBook] = useState<FlibustaBook | null>(null);
  const reqId = useRef(0);

  const doLoad = useCallback(
    async (tabV: Tab, pageV: number, gV: string, qV: string, aV: string): Promise<boolean> => {
      const id = ++reqId.current;
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams();
        params.set("list", tabV);
        params.set("page", String(pageV));
        params.set("size", String(PAGE_SIZE));
        if (gV) params.set("genre", gV);
        if (qV.trim()) params.set("q", qV);
        if (aV.trim()) params.set("authorQ", aV);
        const res = await api.getBooks(params.toString());
        if (id !== reqId.current) return true; // устаревший ответ — не считаем ошибкой
        setItems(res.items || []);
        setHasMore(!!res.hasMore);
        setFlags(res.flags || {});
        setPopularFallback(!!res.popularFallback);
        setPage(pageV);
        if (id === reqId.current) setLoading(false);
        return true;
      } catch (e: any) {
        if (id === reqId.current) {
          setItems([]);
          setError(e?.message || "error");
          setLoading(false);
        }
        return false;
      }
    },
    [],
  );

  // genre-параметр для API: JSON-массив выбранных путей (или пусто)
  const genreParam = (arr: string[]) => (arr.length ? JSON.stringify(arr) : "");

  // Начальная загрузка: новинки + жанры; при сбое сети — один авто-повтор
  useEffect(() => {
    const run = (isRetry: boolean) =>
      doLoad("new", 0, "", "", "").then((ok) => {
        if (!ok && !isRetry) setTimeout(() => doLoad("new", 0, "", "", ""), 1500);
      });
    run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    api
      .getBookGenres()
      .then((r) => setGenres((r.genres || []).sort((a, b) => a.title.localeCompare(b.title, "ru"))))
      .catch(() => {});
  }, []);

  // Стабильная ссылка на актуальные значения (для колбэков тулбара)
  const stateRef = useRef({ tab, selectedGenres, titleQ, authorQ });
  stateRef.current = { tab, selectedGenres, titleQ, authorQ };

  const goTab = (tb: Tab) => {
    setTab(tb);
    doLoad(tb, 0, genreParam(selectedGenres), titleQ, authorQ);
  };
  const goPage = (p: number) => {
    if (p >= 0 && (p === 0 || hasMore || p < page))
      doLoad(tab, p, genreParam(selectedGenres), titleQ, authorQ);
  };
  const doSearch = () => {
    if (loading) return; // не дублируем запрос
    const s = stateRef.current;
    setTab("new");
    doLoad("new", 0, genreParam(s.selectedGenres), s.titleQ, s.authorQ);
  };
  // useCallback: handleRefresh должен быть стабильным — иначе тулбар
  // перерисовывается каждый кадр (Maximum update depth exceeded).
  const handleRefresh = useCallback(async () => {
    try {
      await api.refreshBooks();
    } catch {
      /* ignore */
    }
    const s = stateRef.current;
    doLoad(s.tab, 0, genreParam(s.selectedGenres), s.titleQ, s.authorQ);
  }, [doLoad]);
  /** Тогл жанра в мультивыборе; выбранные жанры не сбрасываются поиском. */
  const toggleGenre = (href: string) => {
    const next = selectedGenres.includes(href)
      ? selectedGenres.filter((g) => g !== href)
      : [...selectedGenres, href];
    setSelectedGenres(next);
    doLoad("new", 0, genreParam(next), titleQ, authorQ);
  };

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

  const toggleFlag = async (b: FlibustaBook, field: "fav") => {
    try {
      const nf = await api.toggleBookFlag(field, b.bid, b);
      setFlags((prev) => ({ ...prev, [b.bid]: { ...prev[b.bid], ...nf } }));
      if (tab === "myfav" && !nf.fav) setItems((xs) => xs.filter((x) => x.bid !== b.bid));
    } catch {
      /* ignore */
    }
  };

  usePageToolbar(
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <Btn icon={RefreshCw} variant="secondary" onClick={handleRefresh} style={{ fontSize: 11 }}>
        {t("books.refresh")}
      </Btn>
    </div>,
    [handleRefresh],
  );

  const flagOf = (b: FlibustaBook) => flags[b.bid] || { fav: !!b.fav, bm: !!b.bm };
  return (
    <div className="page-fill">
      <SectionHead eyebrow={t("books.opdsHint")} title={t("books.title")} />

      {/* Вкладки: новинки / популярное / избранное / закладки */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {(
          [
            ["new", t("books.tabNew")],
            ["popular", t("books.tabPopular")],
            ["myfav", t("books.tabFav")],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className={`pager-page ${tab === id ? "is-active" : ""}`}
            onClick={() => goTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Поиск */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <Glass className="url-bar" style={{ flex: 1, padding: "6px 10px" }}>
          <Search size={16} />
          <input
            placeholder={t("books.titleQ")}
            value={titleQ}
            onChange={(e) => setTitleQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doSearch();
            }}
          />
        </Glass>
        <Glass className="url-bar" style={{ flex: 1, padding: "6px 10px" }}>
          <Search size={16} />
          <input
            placeholder={t("books.authorQ")}
            value={authorQ}
            onChange={(e) => setAuthorQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doSearch();
            }}
          />
        </Glass>
        <Btn variant="secondary" onClick={doSearch} style={{ fontSize: 12 }}>
          {t("books.search")}
        </Btn>
      </div>

      {/* Жанры: свёрнуто — одна строка со скроллом; развёрнуто — поиск + скроллируемый список */}
      {genres.length > 0 && (
        <div style={{ display: "flex", gap: 5, marginBottom: 12, alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              gap: 5,
              flex: 1,
              minWidth: 0,
              flexWrap: genresOpen ? "wrap" : "nowrap",
              alignContent: "flex-start",
              overflowX: genresOpen ? "hidden" : "auto",
              overflowY: genresOpen ? "auto" : "hidden",
              maxHeight: genresOpen ? 200 : undefined,
              paddingBottom: 2,
            }}
          >
            {selectedGenres.map((href) => {
              const g = genres.find((x) => x.href === href);
              if (!g) return null;
              return (
                <button
                  key={`sel-${href}`}
                  className="pager-page is-active"
                  style={{ flexShrink: 0 }}
                  title={`${g.title} — ${t("books.removeGenre")}`}
                  onClick={() => toggleGenre(href)}
                >
                  ✕ {g.title}
                </button>
              );
            })}
            {genres
              .filter((g) => !selectedGenres.includes(g.href))
              .filter((g) => {
                if (!genresOpen || !genreQ.trim()) return true;
                return g.title.toLowerCase().includes(genreQ.trim().toLowerCase());
              })
              .map((g) => {
                const leaf = g.title.includes(" / ") ? g.title.split(" / ").pop()! : g.title;
                return (
                  <button
                    key={g.href}
                    className="pager-page"
                    style={{ flexShrink: 0 }}
                    title={g.title}
                    onClick={() => toggleGenre(g.href)}
                  >
                    {genresOpen ? leaf : leaf.length > 34 ? leaf.slice(0, 34) + "…" : leaf}
                  </button>
                );
              })}
          </div>
          {genresOpen && (
            <Glass className="url-bar" style={{ padding: "2px 8px", flexShrink: 0, width: 170 }}>
              <Search size={13} />
              <input
                placeholder={t("books.searchGenre")}
                value={genreQ}
                onChange={(e) => setGenreQ(e.target.value)}
                style={{ fontSize: 12, padding: "2px 0" }}
              />
            </Glass>
          )}
          <button
            className="pager-btn"
            title={genresOpen ? t("books.collapseGenres") : t("books.expandGenres")}
            onClick={() => {
              setGenresOpen((v) => !v);
              setGenreQ("");
            }}
          >
            <ChevronsDown
              size={13}
              style={{
                transform: genresOpen ? "rotate(180deg)" : "none",
                transition: "transform .15s",
              }}
            />
          </button>
        </div>
      )}

      {popularFallback && tab === "popular" && (
        <Glass
          style={{
            padding: 8,
            marginBottom: 12,
            fontSize: 12,
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <AlertCircle size={14} /> {t("books.popularFallback")}
        </Glass>
      )}
      {error && (
        <Glass
          style={{
            padding: 8,
            marginBottom: 12,
            fontSize: 12,
            display: "flex",
            gap: 8,
            alignItems: "center",
            borderColor: "var(--coral)",
          }}
        >
          <span style={{ color: "var(--coral)" }}>⚠ {error}</span>
        </Glass>
      )}
      {loading && (
        <Glass
          style={{
            padding: 8,
            marginBottom: 12,
            fontSize: 12,
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <Loader2 size={14} className="spin" /> {t("common.loading")}
        </Glass>
      )}

      <div className="book-list" style={{ flex: 1, maxHeight: "none" }}>
        {items.map((b) => {
          const fl = flagOf(b);
          const lb = langBadge(b.language);
          return (
            <Glass
              className="book-row"
              key={b.bid || b.id}
              style={{ cursor: "pointer" }}
              onClick={() => setSelectedBook(b)}
              onContextMenu={(e) =>
                menu.open(e, [
                  { label: t("ctx.open"), icon: BookOpen, onClick: () => setSelectedBook(b) },
                  { separator: true },
                  ...(b.formats || ["fb2", "epub", "mobi"]).map((fmt: string) => ({
                    label: t("ctx.downloadFmt", { fmt: fmt.toUpperCase() }),
                    icon: Download,
                    onClick: () => handleDownload(b.bid, fmt),
                  })),
                  { separator: true },
                  {
                    label: t("ctx.copyName"),
                    icon: Copy,
                    onClick: () => copyToClipboard(b.title || ""),
                  },
                  {
                    label: t("ctx.copyAuthor"),
                    icon: Copy,
                    onClick: () => copyToClipboard(b.author || ""),
                  },
                ])
              }
            >
              <div className="book-cover">
                <BookOpen size={20} strokeWidth={1.6} />
              </div>
              <div className="book-body">
                <div className="book-title-row">
                  <div style={{ minWidth: 0 }}>
                    <div
                      className="media-title"
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                    >
                      {lb && (
                        <span style={{ fontSize: 13, flexShrink: 0 }} title={b.language || ""}>
                          {lb}
                        </span>
                      )}
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {b.title}
                      </span>
                    </div>
                    <div className="muted-sm">
                      {b.author}
                      {b.year ? ` · ${b.year}` : ""}
                      {b.sizeText ? ` · ${b.sizeText}` : ""}
                    </div>
                  </div>
                  <div
                    className="quality-row"
                    style={{ display: "flex", gap: 4, alignItems: "center" }}
                  >
                    {(b.genres || []).slice(0, 2).map((g: string) => (
                      <Badge key={g}>{g}</Badge>
                    ))}
                  </div>
                </div>
                <p className="book-desc">{b.description?.slice(0, 200)}</p>
                {/* Закладка — первой в ряду скачивания (раньше висела у жанров). */}
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    marginTop: 4,
                    alignItems: "center",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className={`book-fav ${fl.fav ? "is-on" : ""}`}
                    title={t("books.tabFav")}
                    onClick={() => toggleFlag(b, "fav")}
                  >
                    <Star size={15} style={{ fill: fl.fav ? "currentColor" : "none" }} />
                  </button>
                  {(b.formats || ["fb2", "epub", "mobi"]).map((fmt: string) => (
                    <Btn
                      key={fmt}
                      variant="secondary"
                      icon={Download}
                      disabled={downloading === b.bid}
                      onClick={() => handleDownload(b.bid, fmt)}
                      style={{ fontSize: 11, padding: "2px 8px" }}
                    >
                      {fmt.toUpperCase()}
                    </Btn>
                  ))}
                </div>
              </div>
            </Glass>
          );
        })}
        {items.length === 0 && !loading && <EmptyHint icon={BookOpen} text={t("books.empty")} />}
      </div>

      {/* Пагинация: по 80 книг, prev/next */}
      {(page > 0 || hasMore) && tab !== "myfav" && (
        <div className="pager">
          <button className="pager-btn" disabled={page === 0} onClick={() => goPage(page - 1)}>
            {t("books.prev")}
          </button>
          <span className="pager-info">{page + 1}</span>
          <button className="pager-btn" disabled={!hasMore} onClick={() => goPage(page + 1)}>
            {t("books.next")}
          </button>
        </div>
      )}

      {/* Модалка информации о книге */}
      {selectedBook && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 9998,
            background: "rgba(0,0,0,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backdropFilter: "blur(3px)",
            WebkitBackdropFilter: "blur(3px)",
          }}
          onClick={() => setSelectedBook(null)}
        >
          <div
            style={{
              width: 600,
              maxWidth: "92vw",
              height: 540,
              background: "var(--glass-bg)",
              border: "1px solid var(--glass-border)",
              borderRadius: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "14px 18px 10px",
                borderBottom: "1px solid var(--glass-border)",
              }}
            >
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedBook.title}
              </span>
              <span
                onClick={() => setSelectedBook(null)}
                style={{
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                  fontSize: 18,
                  lineHeight: 1,
                  marginLeft: 12,
                  flexShrink: 0,
                }}
              >
                ✕
              </span>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "16px 20px 20px" }}>
              <div style={{ display: "flex", gap: 18, marginBottom: 16 }}>
                <div
                  style={{
                    width: 110,
                    height: 154,
                    borderRadius: 10,
                    flexShrink: 0,
                    background: "var(--card-bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <BookOpen size={32} strokeWidth={1.4} style={{ opacity: 0.35 }} />
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div
                    style={{
                      fontSize: 17,
                      fontWeight: 600,
                      lineHeight: 1.3,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    {langBadge(selectedBook.language) && (
                      <span style={{ fontSize: 16 }} title={selectedBook.language || ""}>
                        {langBadge(selectedBook.language)}
                      </span>
                    )}
                    <span>{selectedBook.title}</span>
                  </div>
                  <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                    {selectedBook.author}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      flexWrap: "wrap",
                      fontSize: 12.5,
                      color: "var(--text-secondary)",
                    }}
                  >
                    {selectedBook.language && <span>🌐 {selectedBook.language}</span>}
                    {selectedBook.year && <span>📅 {selectedBook.year}</span>}
                    {selectedBook.sizeText && <span>💾 {selectedBook.sizeText}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
                    {(selectedBook.genres || []).map((g: string) => (
                      <Badge key={g}>{g}</Badge>
                    ))}
                  </div>
                </div>
              </div>
              {selectedBook.description && (
                <div style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                      marginBottom: 5,
                      textTransform: "uppercase",
                      letterSpacing: 0.7,
                    }}
                  >
                    {t("books.annotation")}
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 14,
                      lineHeight: 1.7,
                      color: "var(--text-primary)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {selectedBook.description}
                  </p>
                </div>
              )}
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    marginBottom: 6,
                    textTransform: "uppercase",
                    letterSpacing: 0.7,
                  }}
                >
                  {t("books.download")}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    className={`book-fav ${flagOf(selectedBook).fav ? "is-on" : ""}`}
                    title={t("books.tabFav")}
                    onClick={() => toggleFlag(selectedBook, "fav")}
                  >
                    <Star
                      size={16}
                      style={{ fill: flagOf(selectedBook).fav ? "currentColor" : "none" }}
                    />
                  </button>
                  {(selectedBook.formats || ["fb2", "epub", "mobi"]).map((fmt: string) => (
                    <Btn
                      key={fmt}
                      variant="secondary"
                      icon={Download}
                      disabled={downloading === selectedBook.bid}
                      onClick={() => handleDownload(selectedBook.bid, fmt)}
                      style={{ fontSize: 12, padding: "4px 12px" }}
                    >
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

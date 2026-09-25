import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Plus,
  Trash2,
  ExternalLink,
  FileText,
  Tag,
  BookOpen,
  X,
  Download,
  Glasses,
  RefreshCw,
  Archive,
} from "lucide-react";
import { Glass, Btn, Badge, EmptyHint, SectionHead } from "@/components/ui";
import { getOverlayRoot } from "@/components/overlayHost";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { SitebakJob } from "@/api/client";
import type { Bookmark } from "@/api/types";
import "@/styles/arch.css";

interface Props {
  /** Открыть сохранённую статью (read-later) как заметку в Notes view. */
  onOpenNote: (path: string) => void;
}

const EXAMPLE_TAGS = ["статья", "видео", "туториал", "работа", "идея", "почитать"];

/** Тег-редактор: чипы вместо строки через запятую + клик по примерам/уже
 * существующим тегам сразу добавляет тег. */
function TagEditor({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");

  const addTag = (raw: string) => {
    const tg = raw.trim().replace(/^#/, "");
    if (!tg || value.includes(tg)) return;
    onChange([...value, tg]);
  };
  const removeTag = (tg: string) => onChange(value.filter((x) => x !== tg));

  const pool = useMemo(
    () => [...new Set([...suggestions, ...EXAMPLE_TAGS])].filter((tg) => !value.includes(tg)).slice(0, 10),
    [suggestions, value],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {value.map((tg) => (
          <Badge key={tg} tone="amber" mono onClick={() => removeTag(tg)}>
            #{tg} <X size={10} style={{ marginLeft: 3, verticalAlign: -1 }} />
          </Badge>
        ))}
        <input
          className="text-input"
          style={{ flex: 1, minWidth: 120 }}
          placeholder={t("bookmarks.fTagsHint")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag(draft);
              setDraft("");
            } else if (e.key === "Backspace" && !draft && value.length) {
              removeTag(value[value.length - 1]);
            }
          }}
        />
      </div>
      {pool.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span className="muted-sm">{t("bookmarks.tagExamples")}</span>
          {pool.map((tg) => (
            <Badge key={tg} tone="neutral" mono onClick={() => addTag(tg)}>
              +#{tg}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Оверлей "Режим чтения": вместо грубой вырезки текста на лету страница
 * реально скачивается через существующий архиватор (server/ts/sitebak.ts,
 * та же движка, что и на странице "Архиватор") — depth: 0, только эта
 * страница, с картинками (inlineAssets) и вырезанными скриптами/рекламой.
 * Результат показывается во фрейме, как во встроенном просмотрщике архивов —
 * это чинит "нет картинок" и убирает самодельный HTML→текст парсер, который
 * терял вёрстку, которую сохраняет Chrome Reading Mode.
 */
function ReaderOverlay({ url, onClose }: { url: string; onClose: () => void }) {
  const { t } = useI18n();
  const [job, setJob] = useState<SitebakJob | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pagePath, setPagePath] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError("");
    setJob(null);
    setPagePath("");
    api
      .archiveStart({
        url,
        depth: 0,
        domainScope: "path",
        maxPages: 1,
        imageMode: "original",
        stripScripts: true,
        stripExif: false,
        blockAds: true,
        inlineAssets: true,
        delayMs: 0,
        concurrency: 1,
        cookies: "",
        userAgent: "",
      })
      .then((j) => {
        if (cancelled) return;
        setJob(j);
        setJobId(j.id);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
      setJobId(null);
    };
  }, [url]);

  useEffect(() => {
    if (!jobId) return undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await api.archiveStatus(jobId);
        if (stopped) return;
        setJob(s);
        if (s.stage === "error") {
          setError(s.error || t("bookmarks.readerError"));
          setJobId(null);
          return;
        }
        if (s.done) {
          const pages = await api.archivePages(s.id);
          if (stopped) return;
          setPagePath(pages.pages[0]?.path || "");
          setJobId(null);
        }
      } catch {
        /* повтор на следующем тике */
      }
    };
    const timer = window.setInterval(tick, 900);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, t]);

  const ready = !!job?.done && !!pagePath;

  return createPortal(
    <div className="app-modal-backdrop arch-view-overlay" onClick={onClose}>
      <Glass className="arch-view glass-solid" onClick={(e) => e.stopPropagation()}>
        <div className="arch-view-head">
          <div className="arch-view-title">
            <Glasses size={16} />
            <span className="arch-view-name">{job?.name || url}</span>
            {job && !error && (
              <Badge tone="neutral" mono>
                {job.done ? t("bookmarks.readerReady") : t(`arch.stage_${job.stage}`)}
              </Badge>
            )}
          </div>
          <div className="arch-view-head-actions">
            {ready && job && (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("bookmarks.readerOpenTab")}
                  onClick={() => window.open(api.archivePreview(job.id, pagePath), "_blank")}
                >
                  <ExternalLink size={15} />
                </button>
                <a
                  className="icon-btn"
                  title={t("bookmarks.readerDownloadBak")}
                  href={api.archiveDownload(job.id)}
                  download
                >
                  <Archive size={15} />
                </a>
              </>
            )}
            <button type="button" className="arch-view-close" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="arch-view-body" style={{ gridTemplateColumns: "1fr" }}>
          <div className="arch-view-frame">
            {error ? (
              <div className="arch-view-error">{error}</div>
            ) : !ready ? (
              <div className="muted-sm" style={{ margin: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                <RefreshCw size={14} className="spin" />
                {job ? t(`arch.stage_${job.stage}`) : t("bookmarks.readerLoading")}
              </div>
            ) : (
              <iframe
                className="arch-view-iframe"
                src={api.archivePreview(job!.id, pagePath)}
                title={job?.name || url}
                sandbox="allow-same-origin"
              />
            )}
          </div>
        </div>
      </Glass>
    </div>,
    getOverlayRoot() ?? document.body,
  );
}

/**
 * Закладки: отдельная вкладка MySpace (рядом с Notes/Tasks/Canvas).
 * "Сохранить для чтения позже" тянет статью на сервере и кладёт как markdown
 * заметку в Vault (папка "Read Later") — см. server/ts/bookmarks.ts.
 */
export default function BookmarksView({ onOpenNote }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<{
    url: string;
    title: string;
    notes: string;
    tags: string[];
    saveForLater: boolean;
  }>({ url: "", title: "", notes: "", tags: [], saveForLater: false });
  const [readerUrl, setReaderUrl] = useState<string | null>(null);
  const [savingArticleId, setSavingArticleId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    api
      .bookmarksList()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const b of items) for (const tg of b.tags) s.add(tg);
    return [...s].sort();
  }, [items]);

  const filtered = useMemo(
    () => (tagFilter ? items.filter((b) => b.tags.includes(tagFilter)) : items),
    [items, tagFilter],
  );

  const save = async () => {
    if (!form.url.trim()) return;
    setSaving(true);
    try {
      await api.bookmarksCreate({
        url: form.url.trim(),
        title: form.title.trim() || undefined,
        notes: form.notes.trim(),
        tags: form.tags,
        saveForLater: form.saveForLater,
      });
      setForm({ url: "", title: "", notes: "", tags: [], saveForLater: false });
      setShowForm(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await api.bookmarksDelete(id);
    load();
  };

  const saveArticleNow = async (id: string) => {
    setSavingArticleId(id);
    try {
      await api.bookmarksSaveArticle(id);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingArticleId(null);
    }
  };

  return (
    <div className="page" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      <SectionHead eyebrow={t("myspace.bookmarksTab")} title={t("bookmarks.title")} />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
        {allTags.map((tg) => (
          <Badge
            key={tg}
            tone={tagFilter === tg ? "amber" : "neutral"}
            mono
            onClick={() => setTagFilter(tagFilter === tg ? null : tg)}
          >
            #{tg}
          </Badge>
        ))}
      </div>

      {showForm ? (
        <Glass className="chart-panel" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              className="text-input"
              placeholder={t("bookmarks.fUrl")}
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            />
            <input
              className="text-input"
              placeholder={t("bookmarks.fTitle")}
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
            <TagEditor
              value={form.tags}
              onChange={(tags) => setForm((f) => ({ ...f, tags }))}
              suggestions={allTags}
            />
            <textarea
              className="text-input"
              rows={2}
              placeholder={t("bookmarks.fNotes")}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
            <label
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
              className="muted-sm"
            >
              <input
                type="checkbox"
                checked={form.saveForLater}
                onChange={(e) => setForm((f) => ({ ...f, saveForLater: e.target.checked }))}
              />
              <BookOpen size={14} />
              {t("bookmarks.saveForLater")}
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn
                variant="primary"
                icon={Plus}
                disabled={saving || !form.url.trim()}
                onClick={() => void save()}
              >
                {saving ? t("bookmarks.saving") : t("bookmarks.add")}
              </Btn>
              <Btn icon={X} onClick={() => setShowForm(false)}>
                {t("ctx.clear")}
              </Btn>
            </div>
          </div>
        </Glass>
      ) : (
        <Btn icon={Plus} onClick={() => setShowForm(true)} style={{ marginBottom: 12 }}>
          {t("bookmarks.add")}
        </Btn>
      )}

      {error && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)", marginBottom: 8 }}>
          <span style={{ color: "var(--coral)" }}>{error}</span>
        </Glass>
      )}
      {loading && <div className="muted-sm">{t("passwordVault.loading")}</div>}
      {!loading && filtered.length === 0 && <EmptyHint icon={Tag} text={t("bookmarks.empty")} />}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map((b) => (
          <Glass key={b.id} className="chart-panel" style={{ padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <a
                  href={b.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: "var(--text-primary)",
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    textDecoration: "none",
                  }}
                >
                  <ExternalLink size={13} />
                  {b.title}
                </a>
                <div className="muted-sm" style={{ wordBreak: "break-all" }}>
                  {b.url}
                </div>
                {b.notes && <div className="muted-sm">{b.notes}</div>}
                {b.tags.length > 0 && (
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    {b.tags.map((tg) => (
                      <Badge key={tg} tone="neutral" mono>
                        #{tg}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("bookmarks.readerMode")}
                  onClick={() => setReaderUrl(b.url)}
                >
                  <Glasses size={15} />
                </button>
                {b.articleNotePath ? (
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("bookmarks.openArticle")}
                    onClick={() => onOpenNote(b.articleNotePath as string)}
                  >
                    <FileText size={15} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("bookmarks.downloadClean")}
                    disabled={savingArticleId === b.id}
                    onClick={() => void saveArticleNow(b.id)}
                  >
                    {savingArticleId === b.id ? (
                      <RefreshCw size={15} className="spin" />
                    ) : (
                      <Download size={15} />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  title={t("ctx.remove")}
                  onClick={() => void remove(b.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          </Glass>
        ))}
      </div>
      {readerUrl && <ReaderOverlay url={readerUrl} onClose={() => setReaderUrl(null)} />}
    </div>
  );
}

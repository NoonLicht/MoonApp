import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, ExternalLink, FileText, Tag, BookOpen, X } from "lucide-react";
import { Glass, Btn, Badge, EmptyHint, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { Bookmark } from "@/api/types";

interface Props {
  /** Открыть сохранённую статью (read-later) как заметку в Notes view. */
  onOpenNote: (path: string) => void;
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
  const [form, setForm] = useState({ url: "", title: "", notes: "", tags: "", saveForLater: false });

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
        tags: form.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        saveForLater: form.saveForLater,
      });
      setForm({ url: "", title: "", notes: "", tags: "", saveForLater: false });
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
            <input
              className="text-input"
              placeholder={t("bookmarks.fTags")}
              value={form.tags}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
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
                {b.articleNotePath && (
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("bookmarks.openArticle")}
                    onClick={() => onOpenNote(b.articleNotePath as string)}
                  >
                    <FileText size={15} />
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
    </div>
  );
}

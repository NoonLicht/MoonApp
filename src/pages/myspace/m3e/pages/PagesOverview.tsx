import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  X,
  Copy,
  Trash2,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Pin,
  Download,
} from "lucide-react";
import { getOverlayRoot } from "@/components/overlayHost";
import { useI18n } from "@/app/i18n";
import type { M3ePageMeta, M3eTrashMeta } from "@/api/apiM3e";
import { PageThumb } from "@/pages/myspace/m3e/pages/PageThumb";
import { parseDoc, relativeTime, type StoredDoc } from "@/pages/myspace/m3e/pages/docUtil";
import { pageLabel } from "@/pages/myspace/m3e/pages/PagesBar";

export interface ScreenRef {
  id: string;
  name: string;
}

/** Документы всех страниц: подгружаются, пока открыт обзор или быстрый переход. */
export function useAllDocs(
  pages: M3ePageMeta[],
  read: (id: string) => Promise<string>,
  enabled: boolean,
) {
  const [docs, setDocs] = useState<Record<string, StoredDoc>>({});
  const stamp = pages.map((p) => `${p.id}:${p.updatedAt}`).join("|");
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    void (async () => {
      for (const p of pages) {
        try {
          const doc = parseDoc(await read(p.id));
          if (!alive) return;
          setDocs((cur) => ({ ...cur, [p.id]: doc }));
        } catch {
          /* страница не читается — покажем пустую карточку */
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, stamp]);
  return docs;
}

export const screensOf = (doc: StoredDoc | undefined): ScreenRef[] =>
  doc && Array.isArray(doc.frames)
    ? [...doc.frames]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((f) => ({ id: f.id, name: f.name }))
    : [];

type Sort = "manual" | "recent" | "name";

interface Props {
  pages: M3ePageMeta[];
  trash: M3eTrashMeta[];
  activeId: string | null;
  docs: Record<string, StoredDoc>;
  onOpen: (id: string, screen?: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  onClose: () => void;
}

/** Обзор всех страниц: миниатюры, поиск по страницам и экранам, сортировка, корзина. */
export default function PagesOverview(p: Props) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("manual");
  const [showTrash, setShowTrash] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const search = useRef<HTMLInputElement | null>(null);
  const now = Date.now();

  useEffect(() => {
    search.current?.focus();
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = p.pages.map((m, i) => {
      const label = pageLabel(m, i, t);
      const screens = screensOf(p.docs[m.id]);
      const hits = needle ? screens.filter((s) => s.name.toLowerCase().includes(needle)) : [];
      const pageHit = !needle || label.toLowerCase().includes(needle);
      return { m, i, label, screens, hits, show: pageHit || hits.length > 0 };
    });
    list = list.filter((r) => r.show);
    if (sort === "recent") list = [...list].sort((a, b) => b.m.updatedAt - a.m.updatedAt);
    else if (sort === "name") list = [...list].sort((a, b) => a.label.localeCompare(b.label));
    return list;
  }, [p.pages, p.docs, q, sort, t]);

  const host = getOverlayRoot();
  if (!host) return null;
  return createPortal(
    <div
      className="graph-fs-backdrop"
      onClick={p.onClose}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") p.onClose();
      }}
    >
      <div
        className="graph-fs-panel glass-solid m3p-ov"
        role="dialog"
        aria-label={t("myspace.m3e.overview")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="graph-fs-header m3p-ov-head">
          <b className="m3p-ov-title">{t("myspace.m3e.overview")}</b>
          <label className="m3p-ov-search">
            <Search size={14} />
            <input
              ref={search}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("myspace.m3e.search")}
            />
            {q && (
              <button
                type="button"
                className="m3p-x"
                onClick={() => setQ("")}
                aria-label={t("myspace.m3e.close")}
              >
                <X size={12} />
              </button>
            )}
          </label>
          <select
            className="m3p-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label={t("myspace.m3e.sort")}
          >
            <option value="manual">{t("myspace.m3e.sortManual")}</option>
            <option value="recent">{t("myspace.m3e.sortRecent")}</option>
            <option value="name">{t("myspace.m3e.sortName")}</option>
          </select>
          <button
            type="button"
            className="m3p-ico"
            onClick={p.onClose}
            aria-label={t("myspace.m3e.close")}
          >
            <X size={16} />
          </button>
        </div>
        <div className="m3p-ov-body">
          {rows.length === 0 ? (
            <div className="m3p-empty">{t("myspace.m3e.emptySearch")}</div>
          ) : (
            <div className="m3p-grid">
              {rows.map(({ m, label, screens, hits }) => {
                const expanded = open[m.id] || hits.length > 0;
                const list = hits.length > 0 ? hits : screens;
                return (
                  <div
                    key={m.id}
                    className={`m3p-card${m.id === p.activeId ? " on" : ""}`}
                    style={m.color ? ({ "--m3p-tab": m.color } as React.CSSProperties) : undefined}
                  >
                    <button
                      type="button"
                      className="m3p-card-thumb"
                      onClick={() => p.onOpen(m.id)}
                      aria-label={`${t("myspace.m3e.open")}: ${label}`}
                    >
                      <PageThumb doc={p.docs[m.id] ?? null} empty={t("myspace.m3e.empty")} />
                      {m.id === p.activeId && (
                        <span className="m3p-badge">{t("myspace.m3e.current")}</span>
                      )}
                    </button>
                    <div className="m3p-card-meta">
                      <div className="m3p-card-name">
                        {m.pinned && <Pin size={11} />}
                        <span>{label}</span>
                      </div>
                      <div className="m3p-card-sub">
                        {t("myspace.m3e.screensCount", { n: m.screens })} ·{" "}
                        {t("myspace.m3e.partsCount", { n: m.parts })} ·{" "}
                        {t("myspace.m3e.updated", { when: relativeTime(m.updatedAt, now, t) })}
                      </div>
                    </div>
                    <div className="m3p-card-actions">
                      <button
                        type="button"
                        className="m3p-ico sm"
                        onClick={() => setOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}
                        title={t("myspace.m3e.screens")}
                        aria-expanded={!!expanded}
                      >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="m3p-count">{screens.length}</span>
                      </button>
                      <span className="m3p-spacer" />
                      <button
                        type="button"
                        className="m3p-ico sm"
                        onClick={() => p.onPin(m.id, !m.pinned)}
                        title={m.pinned ? t("myspace.m3e.unpin") : t("myspace.m3e.pin")}
                      >
                        <Pin size={13} />
                      </button>
                      <button
                        type="button"
                        className="m3p-ico sm"
                        onClick={() => p.onDuplicate(m.id)}
                        title={t("myspace.m3e.duplicate")}
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        type="button"
                        className="m3p-ico sm"
                        onClick={() => p.onExport(m.id)}
                        title={t("myspace.m3e.export")}
                      >
                        <Download size={13} />
                      </button>
                      <button
                        type="button"
                        className="m3p-ico sm danger"
                        onClick={() => p.onDelete(m.id)}
                        title={t("myspace.m3e.delete")}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {expanded && list.length > 0 && (
                      <div className="m3p-screens">
                        {list.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            className="m3p-chip"
                            onClick={() => p.onOpen(m.id, s.id)}
                            title={s.name}
                          >
                            {s.name || "—"}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="m3p-trash">
            <button
              type="button"
              className="m3p-trash-head"
              onClick={() => setShowTrash((v) => !v)}
              aria-expanded={showTrash}
            >
              {showTrash ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Trash2 size={13} />
              <span>
                {t("myspace.m3e.trash")} ({p.trash.length})
              </span>
            </button>
            {showTrash &&
              (p.trash.length === 0 ? (
                <div className="m3p-empty small">{t("myspace.m3e.trashEmpty")}</div>
              ) : (
                <ul className="m3p-trash-list">
                  {p.trash.map((m) => (
                    <li key={m.id}>
                      <span className="m3p-trash-name">
                        {m.title.trim() || t("myspace.m3e.empty")}
                      </span>
                      <span className="m3p-card-sub">
                        {t("myspace.m3e.screensCount", { n: m.screens })}
                      </span>
                      <span className="m3p-spacer" />
                      <button type="button" className="m3p-btn" onClick={() => p.onRestore(m.id)}>
                        <RotateCcw size={12} /> {t("myspace.m3e.restore")}
                      </button>
                      <button
                        type="button"
                        className="m3p-btn danger"
                        onClick={() => {
                          if (
                            window.confirm(
                              t("myspace.m3e.purgeConfirm", {
                                name: m.title.trim() || t("myspace.m3e.empty"),
                              }),
                            )
                          )
                            p.onPurge(m.id);
                        }}
                      >
                        <Trash2 size={12} /> {t("myspace.m3e.purge")}
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        </div>
      </div>
    </div>,
    host,
  );
}

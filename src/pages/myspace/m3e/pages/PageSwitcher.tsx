import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, FileText, Smartphone } from "lucide-react";
import { getOverlayRoot } from "@/components/overlayHost";
import { useI18n } from "@/app/i18n";
import type { M3ePageMeta } from "@/api/apiM3e";
import type { StoredDoc } from "@/pages/myspace/m3e/pages/docUtil";
import { pageLabel } from "@/pages/myspace/m3e/pages/PagesBar";
import { screensOf } from "@/pages/myspace/m3e/pages/PagesOverview";

interface Hit {
  key: string;
  page: string;
  screen?: string;
  title: string;
  sub: string;
}

/** Быстрый переход (Ctrl+K): поиск по названиям страниц и экранов, стрелки и Enter. */
export default function PageSwitcher({
  pages,
  docs,
  activeId,
  onPick,
  onClose,
}: {
  pages: M3ePageMeta[];
  docs: Record<string, StoredDoc>;
  activeId: string | null;
  onPick: (page: string, screen?: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all: Hit[] = [];
    pages.forEach((m, i) => {
      const label = pageLabel(m, i, t);
      const pageHit = !needle || label.toLowerCase().includes(needle);
      if (pageHit)
        all.push({
          key: m.id,
          page: m.id,
          title: label,
          sub: m.id === activeId ? t("myspace.m3e.current") : t("myspace.m3e.pageKind"),
        });
      for (const s of screensOf(docs[m.id])) {
        if (needle ? s.name.toLowerCase().includes(needle) : false) {
          all.push({
            key: `${m.id}/${s.id}`,
            page: m.id,
            screen: s.id,
            title: s.name || "—",
            sub: `${t("myspace.m3e.screenKind")} · ${label}`,
          });
        }
      }
    });
    return all.slice(0, 60);
  }, [q, pages, docs, activeId, t]);

  useEffect(() => setAt(0), [q]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-i="${at}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const pick = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    onPick(h.page, h.screen);
  };

  const host = getOverlayRoot();
  if (!host) return null;
  return createPortal(
    <div className="graph-fs-backdrop" onClick={onClose}>
      <div
        className="m3p-switch glass-solid"
        role="dialog"
        aria-label={t("myspace.m3e.switcher")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setAt((v) => Math.min(hits.length - 1, v + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setAt((v) => Math.max(0, v - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(hits[at]);
          }
        }}
      >
        <label className="m3p-switch-input">
          <Search size={15} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("myspace.m3e.search")}
            aria-label={t("myspace.m3e.search")}
          />
        </label>
        <div ref={list} className="m3p-switch-list" role="listbox">
          {hits.length === 0 ? (
            <div className="m3p-empty small">{t("myspace.m3e.emptySearch")}</div>
          ) : (
            hits.map((h, i) => (
              <button
                key={h.key}
                type="button"
                role="option"
                aria-selected={i === at}
                data-i={i}
                className={`m3p-switch-row${i === at ? " on" : ""}`}
                onMouseMove={() => setAt(i)}
                onClick={() => pick(h)}
              >
                {h.screen ? <Smartphone size={14} /> : <FileText size={14} />}
                <span className="m3p-switch-title">{h.title}</span>
                <span className="m3p-switch-sub">{h.sub}</span>
              </button>
            ))
          )}
        </div>
        <div className="m3p-switch-foot">{t("myspace.m3e.switcherHint")}</div>
      </div>
    </div>,
    host,
  );
}

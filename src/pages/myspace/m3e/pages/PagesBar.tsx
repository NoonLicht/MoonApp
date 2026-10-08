import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  LayoutGrid,
  X,
  Pin,
  ChevronLeft,
  ChevronRight,
  Copy,
  Pencil,
  Download,
  Trash2,
  ArrowLeft,
  ArrowRight,
  FilePlus,
  Sparkles,
  FileUp,
  CopyPlus,
} from "lucide-react";
import { useI18n } from "@/app/i18n";
import type { M3ePageMeta } from "@/api/apiM3e";
import type { SaveState } from "@/pages/myspace/m3e/pages/useWorkbook";
import { PopMenu, type MenuItem } from "@/pages/myspace/m3e/pages/Menu";

export const TAB_COLORS = [
  "#6750a4",
  "#b3261e",
  "#e8710a",
  "#c9a800",
  "#2e7d32",
  "#00838f",
  "#1565c0",
  "#ad1457",
];

export const pageLabel = (
  m: M3ePageMeta,
  index: number,
  t: (k: string, p?: Record<string, unknown>) => string,
) => m.title.trim() || t("myspace.m3e.pageN", { n: index + 1 });

interface Props {
  pages: M3ePageMeta[];
  activeId: string | null;
  save: SaveState;
  onOpen: (id: string) => void;
  onNew: (kind: "blank" | "demo" | "copy") => void;
  onImport: () => void;
  onRename: (id: string, title: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onColor: (id: string, color: string | null) => void;
  onReorder: (order: string[]) => void;
  onExport: (id: string) => void;
  onOverview: () => void;
}

type Menu = { x: number; y: number; items: MenuItem[] } | null;

/** Полоса вкладок-страниц над холстом: переключение, перетаскивание, переименование, меню страницы. */
export default function PagesBar(p: Props) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<Menu>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const strip = useRef<HTMLDivElement | null>(null);
  const tabEls = useRef(new Map<string, HTMLElement>());

  // Закреплённые вкладки стоят первыми, внутри групп порядок сервера.
  const shown = useMemo(
    () => [...p.pages.filter((x) => x.pinned), ...p.pages.filter((x) => !x.pinned)],
    [p.pages],
  );
  const indexOf = (id: string) => p.pages.findIndex((x) => x.id === id);

  const measure = () => {
    const el = strip.current;
    if (!el) return;
    setEdge({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  };
  useEffect(() => {
    measure();
    const el = strip.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.pages.length]);

  // Открытая вкладка всегда видна.
  useEffect(() => {
    if (p.activeId)
      tabEls.current
        .get(p.activeId)
        ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [p.activeId, p.pages.length]);

  const scrollBy = (dx: number) => strip.current?.scrollBy({ left: dx, behavior: "smooth" });

  const startRename = (id: string) => {
    const i = indexOf(id);
    setDraft(p.pages[i]?.title ?? "");
    setEditing(id);
  };
  const commitRename = () => {
    if (editing) p.onRename(editing, draft.trim());
    setEditing(null);
  };

  const move = (id: string, dir: -1 | 1) => {
    const ids = p.pages.map((x) => x.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    p.onReorder(ids);
  };

  const openMenu = (e: { clientX: number; clientY: number }, m: M3ePageMeta) => {
    const i = indexOf(m.id);
    const items: MenuItem[] = [
      {
        key: "rename",
        label: t("myspace.m3e.rename"),
        icon: <Pencil size={14} />,
        onPick: () => startRename(m.id),
      },
      {
        key: "dup",
        label: t("myspace.m3e.duplicate"),
        icon: <Copy size={14} />,
        onPick: () => p.onDuplicate(m.id),
      },
      {
        key: "pin",
        label: m.pinned ? t("myspace.m3e.unpin") : t("myspace.m3e.pin"),
        icon: <Pin size={14} />,
        onPick: () => p.onPin(m.id, !m.pinned),
      },
      {
        key: "color",
        label: "",
        custom: (
          <div className="m3p-colors" role="group" aria-label={t("myspace.m3e.color")}>
            <button
              type="button"
              className={`m3p-swatch none${m.color ? "" : " on"}`}
              title={t("myspace.m3e.noColor")}
              onClick={() => {
                setMenu(null);
                p.onColor(m.id, null);
              }}
            >
              <X size={11} />
            </button>
            {TAB_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`m3p-swatch${m.color === c ? " on" : ""}`}
                style={{ background: c }}
                title={t("myspace.m3e.color")}
                onClick={() => {
                  setMenu(null);
                  p.onColor(m.id, c);
                }}
              />
            ))}
          </div>
        ),
      },
      {
        key: "left",
        sep: true,
        label: t("myspace.m3e.moveLeft"),
        icon: <ArrowLeft size={14} />,
        disabled: i <= 0,
        onPick: () => move(m.id, -1),
      },
      {
        key: "right",
        label: t("myspace.m3e.moveRight"),
        icon: <ArrowRight size={14} />,
        disabled: i >= p.pages.length - 1,
        onPick: () => move(m.id, 1),
      },
      {
        key: "export",
        sep: true,
        label: t("myspace.m3e.export"),
        icon: <Download size={14} />,
        onPick: () => p.onExport(m.id),
      },
      {
        key: "del",
        label: t("myspace.m3e.delete"),
        icon: <Trash2 size={14} />,
        danger: true,
        onPick: () => p.onDelete(m.id),
      },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const openNewMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        {
          key: "blank",
          label: t("myspace.m3e.newBlank"),
          icon: <FilePlus size={14} />,
          onPick: () => p.onNew("blank"),
        },
        {
          key: "demo",
          label: t("myspace.m3e.newDemo"),
          icon: <Sparkles size={14} />,
          onPick: () => p.onNew("demo"),
        },
        {
          key: "copy",
          label: t("myspace.m3e.newCopy"),
          icon: <CopyPlus size={14} />,
          onPick: () => p.onNew("copy"),
        },
        {
          key: "file",
          sep: true,
          label: t("myspace.m3e.importFile"),
          icon: <FileUp size={14} />,
          onPick: p.onImport,
        },
      ],
    });
  };

  const finishDrag = () => {
    if (dragId && drop && dragId !== drop.id) {
      const ids = p.pages.map((x) => x.id).filter((x) => x !== dragId);
      const at = ids.indexOf(drop.id);
      if (at >= 0) {
        ids.splice(at + (drop.after ? 1 : 0), 0, dragId);
        p.onReorder(ids);
      }
    }
    setDragId(null);
    setDrop(null);
  };

  return (
    <div className="m3p-bar" role="tablist" aria-label={t("myspace.m3e.tabsLabel")}>
      {edge.left && (
        <button
          type="button"
          className="m3p-ico m3p-edge"
          onClick={() => scrollBy(-220)}
          aria-label={t("myspace.m3e.scrollLeft")}
        >
          <ChevronLeft size={16} />
        </button>
      )}
      <div
        ref={strip}
        className="m3p-strip"
        onScroll={measure}
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current?.scrollBy({ left: e.deltaY });
        }}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) p.onNew("blank");
        }}
      >
        {shown.map((m) => {
          const i = indexOf(m.id);
          const on = m.id === p.activeId;
          const label = pageLabel(m, i, t);
          const dropCls = drop?.id === m.id ? (drop.after ? " drop-after" : " drop-before") : "";
          return (
            <div
              key={m.id}
              ref={(el) => {
                if (el) tabEls.current.set(m.id, el);
                else tabEls.current.delete(m.id);
              }}
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              draggable={editing !== m.id}
              className={`m3p-tab${on ? " on" : ""}${m.pinned ? " pinned" : ""}${dragId === m.id ? " dragging" : ""}${dropCls}`}
              style={m.color ? ({ "--m3p-tab": m.color } as React.CSSProperties) : undefined}
              title={`${label} — ${t("myspace.m3e.screensCount", { n: m.screens })}, ${t("myspace.m3e.partsCount", { n: m.parts })}`}
              onClick={() => !on && editing !== m.id && p.onOpen(m.id)}
              onDoubleClick={() => startRename(m.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  p.onDelete(m.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e, m);
              }}
              onKeyDown={(e) => {
                if (e.key === "F2") {
                  e.preventDefault();
                  startRename(m.id);
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  p.onOpen(m.id);
                }
              }}
              onDragStart={(e) => {
                setDragId(m.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/x-m3e-page", m.id);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === m.id) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDrop({ id: m.id, after: e.clientX > r.left + r.width / 2 });
              }}
              onDrop={(e) => {
                e.preventDefault();
                finishDrag();
              }}
              onDragEnd={finishDrag}
            >
              {m.color && <span className="m3p-dot" />}
              {m.pinned && <Pin size={11} className="m3p-pin" />}
              {editing === m.id ? (
                <input
                  className="m3p-rename"
                  autoFocus
                  value={draft}
                  maxLength={120}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <span className="m3p-name">{m.pinned ? label.slice(0, 14) : label}</span>
              )}
              {!m.pinned && editing !== m.id && (
                <button
                  type="button"
                  className="m3p-x"
                  aria-label={t("myspace.m3e.delete")}
                  title={t("myspace.m3e.delete")}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onDelete(m.id);
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {edge.right && (
        <button
          type="button"
          className="m3p-ico m3p-edge"
          onClick={() => scrollBy(220)}
          aria-label={t("myspace.m3e.scrollRight")}
        >
          <ChevronRight size={16} />
        </button>
      )}
      <button
        type="button"
        className="m3p-ico"
        onClick={openNewMenu}
        title={t("myspace.m3e.newPage")}
        aria-label={t("myspace.m3e.newPage")}
      >
        <Plus size={16} />
      </button>
      <span className="m3p-spacer" />
      <span className={`m3p-save ${p.save}`} aria-live="polite">
        {p.save === "saving"
          ? t("myspace.m3e.saving")
          : p.save === "saved"
            ? t("myspace.m3e.saved")
            : p.save === "error"
              ? t("myspace.m3e.saveFailed")
              : ""}
      </span>
      <button
        type="button"
        className="m3p-ico"
        onClick={p.onOverview}
        title={t("myspace.m3e.overviewHint")}
        aria-label={t("myspace.m3e.overview")}
      >
        <LayoutGrid size={16} />
      </button>
      {menu && <PopMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Download,
  Grid3x3,
  LayoutTemplate,
  Magnet,
  Maximize2,
  MousePointerSquareDashed,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
  Pencil,
} from "lucide-react";
import type { Key } from "@/pages/myspace/canvas/strings";

export interface BoardEntry {
  file: string;
  title: string;
}

interface Props {
  t: (k: Key) => string;
  boards: BoardEntry[];
  file: string;
  name: string;
  onName: (n: string) => void;
  onOpenBoard: (file: string) => void;
  onNewBoard: () => void;
  onDeleteBoard: (file: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoom: number;
  onZoom: (z: number) => void;
  onFit: () => void;
  onFitSel: () => void;
  hasSel: boolean;
  grid: boolean;
  onGrid: () => void;
  snap: boolean;
  onSnap: () => void;
  wheelZoom: boolean;
  onWheel: () => void;
  onTemplates: () => void;
  onExport: (fmt: "png" | "svg" | "json") => void;
  save: "saved" | "saving" | "error";
}

function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [open]);
  return { open, setOpen, ref };
}

/** Верхняя панель: доски, имя, история, масштаб, сетка, шаблоны, экспорт. */
export function TopBar(p: Props) {
  const boards = useMenu();
  const zoom = useMenu();
  const exp = useMenu();
  const t = p.t;
  return (
    <div className="hc-top hc-float" data-ui>
      <div className="hc-menu" ref={boards.ref}>
        <button
          type="button"
          className="hc-btn"
          title={t("boards")}
          onClick={() => boards.setOpen(!boards.open)}
        >
          <ChevronDown size={15} />
        </button>
        {boards.open && (
          <div className="hc-drop hc-float" style={{ left: 0, minWidth: 220 }}>
            {p.boards.map((b) => (
              <div key={b.file} className={`hc-drop-row${b.file === p.file ? " on" : ""}`}>
                <button
                  type="button"
                  className="hc-drop-main"
                  onClick={() => {
                    p.onOpenBoard(b.file);
                    boards.setOpen(false);
                  }}
                >
                  {b.title || b.file}
                </button>
                {p.boards.length > 1 && (
                  <button
                    type="button"
                    className="hc-icon-sm"
                    title={t("del")}
                    onClick={() => p.onDeleteBoard(b.file)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            <div className="hc-drop-sep" />
            <button
              type="button"
              className="hc-drop-main"
              onClick={() => {
                p.onNewBoard();
                boards.setOpen(false);
              }}
            >
              <Plus size={14} /> {t("newBoard")}
            </button>
          </div>
        )}
      </div>
      <Pencil size={13} style={{ opacity: 0.45, flex: "0 0 auto" }} />
      <input
        className="hc-name"
        value={p.name}
        onChange={(e) => p.onName(e.target.value)}
        placeholder={t("newName")}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <span className={`hc-save ${p.save}`}>
        {p.save === "saved" ? t("saved") : p.save === "saving" ? t("saving") : t("saveFail")}
      </span>
      <div className="hc-sep" />
      <button
        type="button"
        className="hc-btn"
        title={`${t("undo")} (Ctrl+Z)`}
        disabled={!p.canUndo}
        onClick={p.onUndo}
      >
        <Undo2 size={16} />
      </button>
      <button
        type="button"
        className="hc-btn"
        title={`${t("redo")} (Ctrl+Shift+Z)`}
        disabled={!p.canRedo}
        onClick={p.onRedo}
      >
        <Redo2 size={16} />
      </button>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        className={`hc-btn${p.grid ? " on" : ""}`}
        title={t("grid")}
        aria-pressed={p.grid}
        onClick={p.onGrid}
      >
        <Grid3x3 size={16} />
      </button>
      <button
        type="button"
        className={`hc-btn${p.snap ? " on" : ""}`}
        title={t("snap")}
        aria-pressed={p.snap}
        onClick={p.onSnap}
      >
        <Magnet size={16} />
      </button>
      <button
        type="button"
        className="hc-btn hc-wide"
        title={t("templates")}
        onClick={p.onTemplates}
      >
        <LayoutTemplate size={16} /> <span>{t("templates")}</span>
      </button>
      <div className="hc-menu" ref={exp.ref}>
        <button
          type="button"
          className="hc-btn hc-wide"
          title={t("export")}
          onClick={() => exp.setOpen(!exp.open)}
        >
          <Download size={16} /> <span>{t("export")}</span>
        </button>
        {exp.open && (
          <div className="hc-drop hc-float" style={{ right: 0 }}>
            {(["png", "svg", "json"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className="hc-drop-main"
                onClick={() => {
                  p.onExport(f);
                  exp.setOpen(false);
                }}
              >
                {f === "png" ? t("exportPng") : f === "svg" ? t("exportSvg") : t("exportJson")}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="hc-sep" />
      <button
        type="button"
        className="hc-btn"
        title={t("zoomOut")}
        onClick={() => p.onZoom(p.zoom / 1.25)}
      >
        <ZoomOut size={16} />
      </button>
      <div className="hc-menu" ref={zoom.ref}>
        <button type="button" className="hc-btn hc-zoom" onClick={() => zoom.setOpen(!zoom.open)}>
          {Math.round(p.zoom * 100)}%
        </button>
        {zoom.open && (
          <div className="hc-drop hc-float" style={{ right: 0, minWidth: 190 }}>
            {[0.25, 0.5, 1, 2, 4].map((z) => (
              <button
                key={z}
                type="button"
                className="hc-drop-main"
                onClick={() => {
                  p.onZoom(z);
                  zoom.setOpen(false);
                }}
              >
                {z * 100}%
              </button>
            ))}
            <div className="hc-drop-sep" />
            <button
              type="button"
              className="hc-drop-main"
              onClick={() => {
                p.onFit();
                zoom.setOpen(false);
              }}
            >
              <Maximize2 size={14} /> {t("fit")} <kbd>⇧1</kbd>
            </button>
            <button
              type="button"
              className="hc-drop-main"
              disabled={!p.hasSel}
              onClick={() => {
                p.onFitSel();
                zoom.setOpen(false);
              }}
            >
              <MousePointerSquareDashed size={14} /> {t("fitSel")} <kbd>⇧2</kbd>
            </button>
            <div className="hc-drop-sep" />
            <button type="button" className="hc-drop-main" onClick={p.onWheel}>
              {p.wheelZoom ? "✓ " : ""}
              {t("wheelZoom")}
            </button>
            <button type="button" className="hc-drop-main" onClick={p.onWheel}>
              {!p.wheelZoom ? "✓ " : ""}
              {t("wheelPan")}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        className="hc-btn"
        title={t("zoomIn")}
        onClick={() => p.onZoom(p.zoom * 1.25)}
      >
        <ZoomIn size={16} />
      </button>
    </div>
  );
}

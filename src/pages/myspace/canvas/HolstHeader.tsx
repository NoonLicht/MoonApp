import { useEffect, useRef, useState } from "react";
import {
  Undo2,
  Redo2,
  LayoutTemplate,
  Download,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Crosshair,
} from "lucide-react";

export interface HeaderProps {
  boardName: string;
  onName: (n: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onTemplates: () => void;
  onExport: (fmt: "png" | "svg" | "json") => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onResetZoom: () => void;
}

export default function HolstHeader(p: HeaderProps) {
  const [expOpen, setExpOpen] = useState(false);
  const expRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expOpen) return;
    const close = (e: MouseEvent) => {
      if (!expRef.current?.contains(e.target as Node)) setExpOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [expOpen]);

  return (
    <div className="holst-float holst-top" onMouseDown={(e) => e.stopPropagation()}>
      {/* left: name + undo/redo */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        <input
          className="holst-board-name"
          value={p.boardName}
          onChange={(e) => p.onName(e.target.value)}
          placeholder="Untitled Holst 01"
          spellCheck={false}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <div className="holst-sep" />
        <button
          className="holst-hbtn"
          title="Undo (Ctrl+Z)"
          disabled={!p.canUndo}
          onClick={p.onUndo}
        >
          <Undo2 size={15} />
        </button>
        <button
          className="holst-hbtn"
          title="Redo (Ctrl+Y)"
          disabled={!p.canRedo}
          onClick={p.onRedo}
        >
          <Redo2 size={15} />
        </button>
      </div>

      {/* right: templates, export, zoom */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <div className="holst-sep" />
        <button className="holst-hbtn" onClick={p.onTemplates}>
          <LayoutTemplate size={14} /> Template
        </button>
        <div ref={expRef} style={{ position: "relative" }}>
          <button
            className={`holst-hbtn ${expOpen ? "is-active" : ""}`}
            onClick={() => setExpOpen(!expOpen)}
          >
            <Download size={14} /> Export
          </button>
          {expOpen && (
            <div className="holst-pop" style={{ top: 34, right: 0 }}>
              <button
                className="holst-pop-item"
                onClick={() => {
                  p.onExport("png");
                  setExpOpen(false);
                }}
              >
                🖼 PNG (high-res)
              </button>
              <button
                className="holst-pop-item"
                onClick={() => {
                  p.onExport("svg");
                  setExpOpen(false);
                }}
              >
                ✏️ SVG (vector)
              </button>
              <button
                className="holst-pop-item"
                onClick={() => {
                  p.onExport("json");
                  setExpOpen(false);
                }}
              >
                💾 JSON (.holst backup)
              </button>
            </div>
          )}
        </div>
        <div className="holst-sep" />
        <button className="holst-hbtn" onClick={p.onZoomOut} title="Zoom out">
          <ZoomOut size={14} />
        </button>
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-secondary)",
            minWidth: 38,
            textAlign: "center",
          }}
        >
          {Math.round(p.zoom * 100)}%
        </span>
        <button className="holst-hbtn" onClick={p.onZoomIn} title="Zoom in">
          <ZoomIn size={14} />
        </button>
        <button className="holst-hbtn" onClick={p.onFit} title="Fit to view (Shift+1)">
          <Maximize2 size={13} />
        </button>
        <button className="holst-hbtn" onClick={p.onResetZoom} title="Reset 100%">
          <Crosshair size={13} />
        </button>
      </div>
    </div>
  );
}

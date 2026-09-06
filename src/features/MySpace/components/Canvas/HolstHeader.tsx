import React, { useEffect, useRef, useState } from "react";
import {
  Undo2, Redo2, Play, Pause, RotateCcw, Vote, LayoutTemplate,
  Download, ZoomIn, ZoomOut, Maximize2, Crosshair, Timer,
} from "lucide-react";

export interface TimerState { seconds: number; running: boolean; expired: boolean }
export interface VotingState { active: boolean; votesPerUser: number; minutes: number }

export interface HeaderProps {
  boardName: string;
  onName: (n: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  timer: TimerState;
  onTimer: (patch: Partial<TimerState>) => void;
  onTimerAdd: (m: number) => void;
  voting: VotingState;
  onVotingToggle: () => void;
  onTemplates: () => void;
  onExport: (fmt: "png" | "svg" | "json") => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onResetZoom: () => void;
}

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

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
        <button className="holst-hbtn" title="Undo (Ctrl+Z)" disabled={!p.canUndo} onClick={p.onUndo}><Undo2 size={15} /></button>
        <button className="holst-hbtn" title="Redo (Ctrl+Y)" disabled={!p.canRedo} onClick={p.onRedo}><Redo2 size={15} /></button>
      </div>

      {/* center: facilitation timer */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <div className="holst-sep" />
        <Timer size={13} style={{ color: "var(--text-tertiary)" }} />
        <span className={`holst-timer-clock ${p.timer.expired ? "expired" : ""}`} title="Facilitation timer">
          {fmt(Math.max(0, p.timer.seconds))}
        </span>
        <button
          className={`holst-hbtn ${p.timer.running ? "is-active" : ""}`}
          title={p.timer.running ? "Pause" : "Play"}
          onClick={() => p.onTimer({ running: !p.timer.running, expired: false })}
        >
          {p.timer.running ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button className="holst-hbtn" title="+1 minute" onClick={() => p.onTimerAdd(1)}>+1m</button>
        <button className="holst-hbtn" title="+5 minutes" onClick={() => p.onTimerAdd(5)}>+5m</button>
        <button className="holst-hbtn" title="Reset timer" onClick={() => p.onTimer({ seconds: 300, running: false, expired: false })}><RotateCcw size={13} /></button>
      </div>

      {/* right: voting, templates, export, zoom */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <div className="holst-sep" />
        <button className={`holst-hbtn ${p.voting.active ? "is-active" : ""}`} onClick={p.onVotingToggle} title="Voting mode">
          <Vote size={14} /> {p.voting.active ? "Voting…" : "Start Voting"}
        </button>
        <button className="holst-hbtn" onClick={p.onTemplates}><LayoutTemplate size={14} /> Template</button>
        <div ref={expRef} style={{ position: "relative" }}>
          <button className={`holst-hbtn ${expOpen ? "is-active" : ""}`} onClick={() => setExpOpen(!expOpen)}>
            <Download size={14} /> Export
          </button>
          {expOpen && (
            <div className="holst-pop" style={{ top: 34, right: 0 }}>
              <button className="holst-pop-item" onClick={() => { p.onExport("png"); setExpOpen(false); }}>🖼 PNG (high-res)</button>
              <button className="holst-pop-item" onClick={() => { p.onExport("svg"); setExpOpen(false); }}>✏️ SVG (vector)</button>
              <button className="holst-pop-item" onClick={() => { p.onExport("json"); setExpOpen(false); }}>💾 JSON (.holst backup)</button>
            </div>
          )}
        </div>
        <div className="holst-sep" />
        <button className="holst-hbtn" onClick={p.onZoomOut} title="Zoom out"><ZoomOut size={14} /></button>
        <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-secondary)", minWidth: 38, textAlign: "center" }}>
          {Math.round(p.zoom * 100)}%
        </span>
        <button className="holst-hbtn" onClick={p.onZoomIn} title="Zoom in"><ZoomIn size={14} /></button>
        <button className="holst-hbtn" onClick={p.onFit} title="Fit to view (Shift+1)"><Maximize2 size={13} /></button>
        <button className="holst-hbtn" onClick={p.onResetZoom} title="Reset 100%"><Crosshair size={13} /></button>
      </div>
    </div>
  );
}

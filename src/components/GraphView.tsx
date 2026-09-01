import React, { useRef, useEffect, useState, useCallback } from "react";
import type { GraphNode, GraphEdge, GraphData } from "../api/types";
import { X, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";

interface Props {
  data: GraphData; onNodeClick?: (node: GraphNode) => void; onClose?: () => void;
  width?: number; height?: number;
}

interface SimNode { id: string; label: string; type: string; x: number; y: number; vx: number; vy: number; pinned: boolean; noteId?: number; taskId?: number; done?: boolean; }
interface SimEdge { source: string; target: string; }

const COLORS: Record<string, string> = { note: "#3fc7ab", task: "#f0a63d" };
const RADIUS = 12, REPULSION = 300, ATTRACTION = 0.005, DAMPING = 0.85, MIN_DIST = 30;

export default function GraphView({ data, onNodeClick, onClose, width = 600, height = 500 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ node: SimNode | null; mx: number; my: number }>({ node: null, mx: 0, my: 0 });
  const simRef = useRef<SimNode[]>([]); const edgeRef = useRef<SimEdge[]>([]); const animRef = useRef<number>(0);
  const panStart = useRef({ x: 0, y: 0 }); const [panning, setPanning] = useState(false);

  useEffect(() => {
    const ns: SimNode[] = data.nodes.map((n, i) => ({
      id: n.id, label: n.label, type: n.type,
      x: Math.cos((2 * Math.PI * i) / data.nodes.length) * 120 + width / 2,
      y: Math.sin((2 * Math.PI * i) / data.nodes.length) * 120 + height / 2,
      vx: 0, vy: 0, pinned: false, noteId: n.noteId, taskId: n.taskId, done: n.done,
    }));
    simRef.current = ns;
    edgeRef.current = data.edges.map(e => ({ source: e.source, target: e.target }));
  }, [data, width, height]);
  const simulate = useCallback(() => {
    const ns = simRef.current, es = edgeRef.current; if (!ns.length) return;
    for (const n of ns) {
      if (n.pinned) continue;
      for (const o of ns) { if (o.id === n.id) continue; const dx = n.x - o.x, dy = n.y - o.y; const d = Math.max(Math.sqrt(dx*dx+dy*dy), MIN_DIST); const f = REPULSION / (d*d); n.vx += (dx/d)*f; n.vy += (dy/d)*f; }
    }
    for (const e of es) {
      const s = ns.find(n => n.id === e.source), t = ns.find(n => n.id === e.target); if (!s || !t) continue;
      const dx = t.x - s.x, dy = t.y - s.y, d = Math.max(Math.sqrt(dx*dx+dy*dy), MIN_DIST); const f = d * ATTRACTION;
      if (!s.pinned) { s.vx += (dx/d)*f; s.vy += (dy/d)*f; } if (!t.pinned) { t.vx -= (dx/d)*f; t.vy -= (dy/d)*f; }
    }
    for (const n of ns) { if (n.pinned) continue; n.vx *= DAMPING; n.vy *= DAMPING; n.x += n.vx; n.y += n.vy; }
    const canvas = canvasRef.current; if (!canvas) return; const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.save(); ctx.translate(offset.x, offset.y); ctx.scale(scale, scale);
    ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 0.8;
    for (const e of es) { const s = ns.find(n => n.id === e.source), t = ns.find(n => n.id === e.target); if (!s || !t) continue; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke(); }
    for (const n of ns) {
      ctx.beginPath(); ctx.arc(n.x, n.y, RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[n.type] || "#8b7bf0"; ctx.fill();
      if (n.done) { ctx.strokeStyle = "#3fc78a"; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = Math.max(9, Math.min(11, 200 / (n.label.length + 5))) + "px Inter, sans-serif";
      ctx.textAlign = "center"; ctx.fillText(n.label.slice(0, 25), n.x, n.y + RADIUS + 13);
    }
    ctx.restore();
    animRef.current = requestAnimationFrame(simulate);
  }, [scale, offset]);

  useEffect(() => { animRef.current = requestAnimationFrame(simulate); return () => cancelAnimationFrame(animRef.current); }, [simulate]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return;
    const mx = (e.clientX - rect.left - offset.x) / scale, my = (e.clientY - rect.top - offset.y) / scale;
    const node = simRef.current.find(n => Math.hypot(n.x - mx, n.y - my) < RADIUS + 5);
    if (node) { const gn = data.nodes.find(n => n.id === node.id); if (gn) onNodeClick?.(gn); }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return;
    const mx = (e.clientX - rect.left - offset.x) / scale, my = (e.clientY - rect.top - offset.y) / scale;
    const node = simRef.current.find(n => Math.hypot(n.x - mx, n.y - my) < RADIUS + 5);
    if (node) { dragRef.current = { node, mx: e.clientX, my: e.clientY }; node.pinned = true; }
    else { panStart.current = { x: e.clientX - offset.x, y: e.clientY - offset.y }; setPanning(true); }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragRef.current.node) {
      const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return;
      dragRef.current.node.x = (e.clientX - rect.left - offset.x) / scale;
      dragRef.current.node.y = (e.clientY - rect.top - offset.y) / scale;
    } else if (panning) setOffset({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y });
  };

  const handleMouseUp = () => { if (dragRef.current.node) { dragRef.current.node.pinned = false; dragRef.current.node = null; } setPanning(false); };
  const handleWheel = (e: React.WheelEvent) => { setScale(s => Math.max(0.2, Math.min(5, s * (e.deltaY > 0 ? 0.9 : 1.1)))); };

  return (
    <div className="graph-container" style={{ position: "relative", width, height }}>
      <canvas ref={canvasRef} width={width * 2} height={height * 2}
        style={{ width, height, cursor: panning ? "grabbing" : "grab", borderRadius: 12 }}
        onClick={handleClick} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onWheel={handleWheel} />
      <div className="graph-controls">
        <button onClick={() => setScale(s => Math.min(5, s * 1.3))}><ZoomIn size={14} /></button>
        <button onClick={() => setScale(s => Math.max(0.2, s * 0.7))}><ZoomOut size={14} /></button>
        <button onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}><Maximize2 size={14} /></button>
        {onClose && <button onClick={onClose}><X size={14} /></button>}
      </div>
    </div>
  );
};

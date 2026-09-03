import React, { useRef, useEffect, useState } from "react";
import type { GraphNode, GraphData } from "../api/types";
import { ZoomIn, ZoomOut, Maximize2, X, Settings2 } from "lucide-react";

interface Props {
  data: GraphData; onNodeClick?: (node: GraphNode) => void; onClose?: () => void;
}

interface SimNode { id: string; type: string; x: number; y: number; vx: number; vy: number; pinned: boolean; done?: boolean; }
interface SimEdge { source: string; target: string; }

const MIN_DIST = 30;
const MAX_SPEED = 12;
const VELOCITY_THRESHOLD = 0.08;

export default function GraphView({ data, onNodeClick, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: 600, h: 500 });
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [showSettings, setShowSettings] = useState(false);

  // Settings (state for the UI, mirrored into a ref for the physics loop)
  const [repulsion, setRepulsion] = useState(400);
  const [centerGravity, setCenterGravity] = useState(0.0006);
  const [damping, setDamping] = useState(0.9);
  const [attraction, setAttraction] = useState(0.01);
  const [nodeRadius, setNodeRadius] = useState(12);
  const [edgeWidth, setEdgeWidth] = useState(0.7);
  const [edgeRestLength, setEdgeRestLength] = useState(110);
  const [edgeSpring, setEdgeSpring] = useState(0.006);
  const [noteColor, setNoteColor] = useState("#3fc7ab");
  const [taskColor, setTaskColor] = useState("#f0a63d");

  const simRef = useRef<SimNode[]>([]);
  const edgeRef = useRef<SimEdge[]>([]);
  const dragRef = useRef<{ node: SimNode | null }>({ node: null });
  const dragTarget = useRef<GraphNode | null>(null);
  const downPos = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panningRef = useRef(false);
  const runningRef = useRef(true);
  const rafRef = useRef<number>(0);

  // Live mirrors so the single persistent loop always sees fresh values
  const p = useRef({ repulsion, centerGravity, damping, attraction, nodeRadius, edgeWidth, edgeRestLength, edgeSpring, noteColor, taskColor });
  p.current = { repulsion, centerGravity, damping, attraction, nodeRadius, edgeWidth, edgeRestLength, edgeSpring, noteColor, taskColor };
  const dimsRef = useRef(dims); dimsRef.current = dims;
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const offsetRef = useRef(offset); offsetRef.current = offset;

  // ResizeObserver → adaptive canvas
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) setDims({ w: Math.round(width), h: Math.round(height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // (Re)initialize node positions when graph data or size changes.
  // Initial scatter is near the center so nodes spread outward then settle.
  useEffect(() => {
    const cx = dims.w / 2, cy = dims.h / 2;
    const spread = Math.max(Math.min(cx, cy) * 0.35, 40);
    const ns: SimNode[] = data.nodes.map((n, i) => ({
      id: n.id, type: n.type,
      x: cx + (i % 2 === 0 ? 1 : -1) * ((i + 1) * 23 % spread),
      y: cy + (i % 3 === 0 ? 1 : -1) * ((i + 1) * 19 % spread),
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      pinned: false, done: n.done,
    }));
    simRef.current = ns;
    edgeRef.current = data.edges.map(e => ({ source: e.source, target: e.target }));
    runningRef.current = true;
  }, [data, dims]);
  // SINGLE persistent animation loop — created once, never re-created on re-render.
  useEffect(() => {
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      step();
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function step() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ns = simRef.current, es = edgeRef.current;
    if (!ns.length) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const S = p.current;
    const dimsV = dimsRef.current;
    const w = dimsV.w, h = dimsV.h;
    const sc = scaleRef.current, off = offsetRef.current;
    const cx = w / 2, cy = h / 2;
    let maxVel = 0;

    if (runningRef.current) {
      // Repulsion + center gravity
      for (const n of ns) {
        if (n.pinned) continue;
        n.vx += (cx - n.x) * S.centerGravity;
        n.vy += (cy - n.y) * S.centerGravity;
        for (const o of ns) {
          if (o.id === n.id) continue;
          const dx = n.x - o.x, dy = n.y - o.y;
          const d = Math.max(Math.sqrt(dx*dx+dy*dy), MIN_DIST);
          const f = S.repulsion / (d * d);
          n.vx += (dx/d) * f;
          n.vy += (dy/d) * f;
        }
      }
      // Spring edges (stretch/contract) + attraction
      for (const e of es) {
        const s = ns.find(n => n.id === e.source), t = ns.find(n => n.id === e.target);
        if (!s || !t) continue;
        const dx = t.x - s.x, dy = t.y - s.y;
        const d = Math.sqrt(dx*dx+dy*dy);
        if (d < 1) continue;
        const spring = (d - S.edgeRestLength) * S.edgeSpring;
        const fx = (dx/d) * spring, fy = (dy/d) * spring;
        if (!s.pinned) { s.vx += fx; s.vy += fy; }
        if (!t.pinned) { t.vx -= fx; t.vy -= fy; }
        const f2 = d * S.attraction;
        if (!s.pinned) { s.vx += (dx/d)*f2; s.vy += (dy/d)*f2; }
        if (!t.pinned) { t.vx -= (dx/d)*f2; t.vy -= (dy/d)*f2; }
      }
      // Integrate: damp, clamp velocity (numerical stability)
      for (const n of ns) {
        if (n.pinned) continue;
        n.vx *= S.damping; n.vy *= S.damping;
        const sp = Math.sqrt(n.vx*n.vx + n.vy*n.vy);
        if (sp > MAX_SPEED) { n.vx *= MAX_SPEED/sp; n.vy *= MAX_SPEED/sp; }
        n.x += n.vx; n.y += n.vy;
        const v = Math.sqrt(n.vx*n.vx + n.vy*n.vy);
        if (v > maxVel) maxVel = v;
      }
      if (maxVel < VELOCITY_THRESHOLD) runningRef.current = false;
    }

    // Draw (cheap when settled)
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(off.x, off.y);
    ctx.scale(sc, sc);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = S.edgeWidth;
    for (const e of es) {
      const s = ns.find(n => n.id === e.source), t = ns.find(n => n.id === e.target);
      if (!s || !t) continue;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
    }
    for (const n of ns) {
      const c = n.type === "note" ? S.noteColor : S.taskColor;
      ctx.beginPath(); ctx.arc(n.x, n.y, S.nodeRadius, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      if (n.pinned) { ctx.strokeStyle = "rgba(255,255,255,0.65)"; ctx.lineWidth = 2; ctx.stroke(); }
      else if (n.done) { ctx.strokeStyle = "#3fc78a"; ctx.lineWidth = 2; ctx.stroke(); }
    }
    // Labels drawn in a separate pass so they aren't overdrawn by node circles
    const labels = simRef.current;
    for (const n of labels) {
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.font = (S.nodeRadius > 9 ? 10 : 8.5) + "px Inter, sans-serif";
      ctx.textAlign = "center";
      const lbl = (data.nodes.find(gn => gn.id === n.id)?.label || "").slice(0, 25);
      if (lbl) ctx.fillText(lbl, n.x, n.y + S.nodeRadius + 11);
    }
    ctx.restore();
  }
  const restartSim = () => { runningRef.current = true; };

  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const off = offsetRef.current, sc = scaleRef.current;
    const mx = (e.clientX - rect.left - off.x) / sc, my = (e.clientY - rect.top - off.y) / sc;
    const R = p.current.nodeRadius;
    const node = simRef.current.find(n => Math.hypot(n.x - mx, n.y - my) < R + 5);
    downPos.current = { x: e.clientX, y: e.clientY };
    movedRef.current = false;
    if (node) {
      dragRef.current = { node };
      dragTarget.current = data.nodes.find(n => n.id === node.id) ?? null;
      node.pinned = true; node.vx = 0; node.vy = 0;
      restartSim();
    } else {
      dragTarget.current = null;
      panStart.current = { x: e.clientX - off.x, y: e.clientY - off.y };
      panningRef.current = true;
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (e.buttons === 0) { panningRef.current = false; return; }
    const dx = e.clientX - downPos.current.x, dy = e.clientY - downPos.current.y;
    if (Math.hypot(dx, dy) > 4) movedRef.current = true;
    const nd = dragRef.current.node;
    if (nd) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const off = offsetRef.current, sc = scaleRef.current;
      const nx = (e.clientX - rect.left - off.x) / sc;
      const ny = (e.clientY - rect.top - off.y) / sc;
      nd.vx = (nx - nd.x) * 0.5;
      nd.vy = (ny - nd.y) * 0.5;
      nd.x = nx; nd.y = ny;
      restartSim();
    } else if (panningRef.current) {
      setOffset({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y });
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // A real click = no significant movement. Ignore click if panning/dragging happened.
    if (!movedRef.current && dragTarget.current) {
      const gn = dragTarget.current;
      if (gn) onNodeClick?.(gn);
    }
    if (dragRef.current.node) {
      dragRef.current.node.pinned = false;
      dragRef.current.node = null;
      restartSim();
    }
    dragTarget.current = null;
    panningRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    setScale(s => Math.max(0.2, Math.min(5, s * (e.deltaY > 0 ? 0.9 : 1.1))));
  };

  const fld = (label: string, val: React.ReactNode) => (
    <div className="graph-settings-row">
      <span>{label}</span>
      {val}
    </div>
  );
  return (
    <div ref={containerRef} className="graph-container" style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas ref={canvasRef} width={dims.w} height={dims.h}
        style={{ width: dims.w, height: dims.h, cursor: "grab", display: "block" }}
        onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onWheel={handleWheel} />
      <div className="graph-controls">
        <button onClick={() => setScale(s => Math.min(5, s * 1.3))}><ZoomIn size={14} /></button>
        <button onClick={() => setScale(s => Math.max(0.2, s * 0.7))}><ZoomOut size={14} /></button>
        <button onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}><Maximize2 size={14} /></button>
        {onClose && <button onClick={onClose}><X size={14} /></button>}
      </div>

      <button className="graph-settings-toggle" onClick={() => setShowSettings(s => !s)} title="Graph settings">
        <Settings2 size={14} />
      </button>

      {showSettings && (
        <div className="graph-settings-panel">
          <div className="graph-settings-label">Forces</div>
          {fld("Repulsion", <>
            <input type="range" min={50} max={2000} value={repulsion} onChange={e => { setRepulsion(Number(e.target.value)); restartSim(); }} />
            <span className="graph-settings-val">{repulsion}</span>
          </>)}
          {fld("Gravity", <>
            <input type="range" min={0} max={30} value={centerGravity * 10000} onChange={e => { setCenterGravity(Number(e.target.value) / 10000); restartSim(); }} />
            <span className="graph-settings-val">{(centerGravity * 10000).toFixed(0)}</span>
          </>)}
          {fld("Damping", <>
            <input type="range" min={50} max={99} value={damping * 100} onChange={e => { setDamping(Number(e.target.value) / 100); restartSim(); }} />
            <span className="graph-settings-val">{(damping * 100).toFixed(0)}</span>
          </>)}
          {fld("Speed", <>
            <input type="range" min={1} max={50} value={attraction * 1000} onChange={e => { setAttraction(Number(e.target.value) / 1000); restartSim(); }} />
            <span className="graph-settings-val">{(attraction * 1000).toFixed(0)}</span>
          </>)}
          <div className="graph-settings-label">Spring</div>
          {fld("Rest Len", <>
            <input type="range" min={20} max={300} value={edgeRestLength} onChange={e => { setEdgeRestLength(Number(e.target.value)); restartSim(); }} />
            <span className="graph-settings-val">{edgeRestLength}</span>
          </>)}
          {fld("Spring", <>
            <input type="range" min={0} max={50} value={edgeSpring * 1000} onChange={e => { setEdgeSpring(Number(e.target.value) / 1000); restartSim(); }} />
            <span className="graph-settings-val">{(edgeSpring * 1000).toFixed(0)}</span>
          </>)}
          <div className="graph-settings-label">Appearance</div>
          {fld("Node Size", <>
            <input type="range" min={4} max={30} value={nodeRadius} onChange={e => { setNodeRadius(Number(e.target.value)); }} />
            <span className="graph-settings-val">{nodeRadius}</span>
          </>)}
          {fld("Edge Width", <>
            <input type="range" min={1} max={30} value={edgeWidth * 10} onChange={e => { setEdgeWidth(Number(e.target.value) / 10); }} />
            <span className="graph-settings-val">{(edgeWidth * 10).toFixed(0)}</span>
          </>)}
          {fld("Note", <input type="color" value={noteColor} onChange={e => setNoteColor(e.target.value)} />)}
          {fld("Task", <input type="color" value={taskColor} onChange={e => setTaskColor(e.target.value)} />)}
        </div>
      )}
    </div>
  );
}
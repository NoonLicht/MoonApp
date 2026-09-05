import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  ReactFlow, MiniMap, Controls, Background, BackgroundVariant,
  useNodesState, useEdgesState, addEdge, Connection, Edge, Node,
  ReactFlowProvider, useReactFlow, SelectionMode, ReactFlowInstance, Panel, MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import StickyNode from "./holst/StickyNode";
import ShapeNode from "./holst/ShapeNode";
import FrameNode from "./holst/FrameNode";
import NoteCardNode from "./holst/NoteCardNode";
import ImageNode from "./holst/ImageNode";
import HolstToolbar from "./holst/HolstToolbar";
import type { HolstNodeType, ShapeGeometry, HolstNode as IHolstNode, HolstEdge as IHolstEdge, HolstFile } from "./holst/types";
import { api } from "../api/client";
import { useI18n } from "../i18n";

const nodeTypes: Record<string, React.ComponentType<any>> = {
  sticky: StickyNode,
  shape: ShapeNode,
  frame: FrameNode,
  noteCard: NoteCardNode,
  image: ImageNode,
  text: StickyNode,
  taskCard: StickyNode,
};

const defaultEdgeStyle: React.CSSProperties = {
  stroke: "var(--glass-border)",
  strokeWidth: 2,
};
const defaultEdgeOptions = {
  style: defaultEdgeStyle,
  type: "smoothstep" as const,
  animated: false,
  markerEnd: { type: MarkerType.ArrowClosed, color: "var(--glass-border)" },
};

let idCounter = 0;
function genId(prefix = "node") {
  return prefix + "-" + (++idCounter) + "-" + Date.now();
}

function HolstFlow({ canvasName, onBacklinksChange, onCreateCanvas }: { canvasName: string; onBacklinksChange?: (backlinks: string[]) => void; onCreateCanvas?: (name: string) => void }) {
  const { t } = useI18n();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const [activeTool, setActiveTool] = useState<string | null>("select");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const undoStack = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const redoStack = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const zoomRef = useRef(1);

  useEffect(() => {
    if (!canvasName) { setLoading(false); return; }
    setLoading(true); setError("");
    api.myspaceReadCanvas(canvasName).then((data: HolstFile | null) => {
      if (data && data.nodes && data.nodes.length) {
        setNodes(data.nodes.map((n: IHolstNode) => ({
          id: n.id, type: n.type, position: n.position, data: n.data,
          style: n.style || {}, zIndex: n.zIndex || 0,
          width: n.width || 200, height: n.height || 200, selected: false,
        })));
        setEdges((data.edges || []).map((e: IHolstEdge) => ({
          id: e.id, source: e.source, target: e.target, label: e.label || "",
          animated: e.animated || false, type: e.type || "smoothstep",
          style: e.style || defaultEdgeStyle,
          markerEnd: { type: MarkerType.ArrowClosed, color: (e.style as any)?.stroke || "var(--glass-border)" },
        })));
        if (data.viewport && rfInstance) rfInstance.setViewport(data.viewport);
        else if (rfInstance) rfInstance.fitView({ padding: 0.2 });
        if (data.nodes) {
          const linked = data.nodes.filter((n: IHolstNode) => n.data?.notePath).map((n: IHolstNode) => n.data!.notePath! as string);
          onBacklinksChange?.(linked);
        }
      } else { setNodes([]); setEdges([]); if (rfInstance) rfInstance.fitView({ padding: 0.2 }); }
      setDirty(false); setLoading(false);
    }).catch((e: Error) => { setError(e.message); setLoading(false); });
  }, [canvasName]);

  const pushUndo = useCallback(() => {
    undoStack.current.push({ nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) });
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
  }, [nodes, edges]);

  const handleSave = useCallback(() => {
    if (!canvasName || !rfInstance) return;
    const vp = rfInstance.getViewport();
    const data: HolstFile = {
      version: 1,
      viewport: { x: vp.x, y: vp.y, zoom: vp.zoom },
      nodes: nodes.map((n) => ({
        id: n.id, type: n.type as HolstNodeType, position: n.position,
        width: n.width, height: n.height,
        data: n.data as any, style: n.style as any, zIndex: n.zIndex || 0,
      })),
      edges: edges.map((e) => ({
        id: e.id, source: e.source, target: e.target,
        label: e.label as string, animated: e.animated, type: e.type as any,
        style: e.style as any,
        endArrow: e.markerEnd ? "arrowclosed" : "none",
        startArrow: e.markerStart ? "arrowclosed" : "none",
      })),
      metadata: { name: canvasName, created: new Date().toISOString(), modified: new Date().toISOString() },
    };
    api.myspaceWriteCanvas(canvasName, data).then(() => setDirty(false)).catch((e: Error) => setError(e.message));
  }, [canvasName, nodes, edges, rfInstance]);

  const handleAddNode = useCallback((type: HolstNodeType, shapeType?: ShapeGeometry) => {
    pushUndo();
    const vp = rfInstance?.getViewport();
    const center = {
      x: vp ? (window.innerWidth / 2 - vp.x) / vp.zoom : 400,
      y: vp ? (window.innerHeight / 2 - vp.y) / vp.zoom : 300,
    };
    const id = genId(type);
    const baseData: any = { text: "", color: type === "sticky" ? "#fef08a" : undefined, fontSize: 14 };
    if (type === "shape") {
      baseData.shapeType = shapeType || "rectangle";
      baseData.color = "var(--glass)"; baseData.strokeColor = "var(--glass-border)"; baseData.fillOpacity = 0.6;
    }
    if (type === "frame") { baseData.childNodeIds = []; baseData.text = "Frame"; }
    const w = type === "shape" ? 160 : type === "frame" ? 400 : 200;
    const h = type === "shape" ? 120 : type === "frame" ? 300 : 200;
    setNodes((nds) => [...nds, { id, type, position: center, data: baseData, width: w, height: h, zIndex: type === "frame" ? -1 : 0, selected: false }]);
    setDirty(true);
  }, [pushUndo, rfInstance, setNodes]);

  const onConnect = useCallback((params: Connection) => {
    pushUndo();
    setEdges((eds) => addEdge({ ...params, id: genId("edge"), type: "smoothstep", style: defaultEdgeStyle, markerEnd: { type: MarkerType.ArrowClosed, color: "var(--glass-border)" } }, eds));
    setDirty(true);
  }, [pushUndo, setEdges]);

  const onNodesDelete = useCallback(() => { pushUndo(); setDirty(true); }, [pushUndo]);
  const onEdgesDelete = useCallback(() => { pushUndo(); setDirty(true); }, [pushUndo]);

  const handleUndo = useCallback(() => {
    if (!undoStack.current.length) return;
    redoStack.current.push({ nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) });
    const prev = undoStack.current.pop()!;
    setNodes(prev.nodes); setEdges(prev.edges); setDirty(true);
  }, [nodes, edges, setNodes, setEdges]);

  const handleRedo = useCallback(() => {
    if (!redoStack.current.length) return;
    undoStack.current.push({ nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) });
    const next = redoStack.current.pop()!;
    setNodes(next.nodes); setEdges(next.edges); setDirty(true);
  }, [nodes, edges, setNodes, setEdges]);

  const handleExport = useCallback(() => {
    const el = reactFlowWrapper.current?.querySelector(".react-flow__viewport");
    if (!el || !canvasName) { handleSave(); return; }
    try {
      const canvas = document.createElement("canvas");
      const rect = (el as HTMLElement).getBoundingClientRect();
      canvas.width = rect.width; canvas.height = rect.height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#1a1a2e"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#fef08a"; ctx.font = "14px monospace"; ctx.fillText("Export via screenshot (Ctrl+P)", 20, 30);
      }
      canvas.toBlob((blob) => {
        if (blob) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = canvasName + ".png"; a.click(); }
      });
    } catch { handleSave(); }
  }, [canvasName, handleSave]);

  useEffect(() => {
    if (!dirty || !canvasName) return;
    const t = setTimeout(() => handleSave(), 30000);
    return () => clearTimeout(t);
  }, [dirty, canvasName, handleSave]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); if (e.shiftKey) handleRedo(); else handleUndo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [handleUndo, handleRedo, handleSave]);

  const [newCanvasName, setNewCanvasName] = useState("");
const inputRef = useRef<HTMLInputElement>(null);

const onNodeDragStop = useCallback(() => setDirty(true), []);
  const onViewportChange = useCallback((vp: { x: number; y: number; zoom: number }) => { zoomRef.current = vp.zoom; }, []);

  if (loading && canvasName) {
    return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>Loading canvas...</div>;
  }

  if (!canvasName) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, gap: 12, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
        <span style={{ fontSize: 48, opacity: 0.5 }}>🎨</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Holst Canvas</span>
        <span style={{ fontSize: 12 }}>Create or select a canvas from the explorer</span>
        <button onClick={() => handleAddNode("sticky")}
          style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid var(--teal)", background: "var(--teal)", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
          Create Canvas +
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "center", padding: "6px 8px 0", flexShrink: 0, zIndex: 10 }}>
        <HolstToolbar
          activeTool={activeTool} setActiveTool={setActiveTool}
          onAddNode={handleAddNode} onSave={handleSave} onExport={handleExport}
          onZoomIn={() => rfInstance?.zoomIn()} onZoomOut={() => rfInstance?.zoomOut()}
          onZoomReset={() => rfInstance?.fitView({ padding: 0.2 })}
          zoomLevel={zoomRef.current}
          canUndo={undoStack.current.length > 0} canRedo={redoStack.current.length > 0}
          onUndo={handleUndo} onRedo={handleRedo}
        />
      </div>
      <div ref={reactFlowWrapper} style={{ flex: 1, minHeight: 0 }}>
        <ReactFlow
          nodes={nodes} edges={edges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onConnect={onConnect} onInit={setRfInstance}
          onNodeDragStop={onNodeDragStop} onNodesDelete={onNodesDelete} onEdgesDelete={onEdgesDelete}
          onViewportChange={onViewportChange}
          nodeTypes={nodeTypes} defaultEdgeOptions={defaultEdgeOptions}
          selectionMode={SelectionMode.Partial} selectionOnDrag={activeTool === "select"}
          panOnDrag={activeTool === "pan"} panOnScroll={false} zoomOnScroll={true}
          fitView minZoom={0.1} maxZoom={5} deleteKeyCode="Delete" multiSelectionKeyCode="Shift"
          snapToGrid snapGrid={[10, 10]}
          style={{ background: "var(--surface-glass)" }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.06)" />
          <MiniMap
            style={{ background: "var(--surface-glass)", border: "1px solid var(--glass-border)", borderRadius: 8, overflow: "hidden" }}
            maskColor="rgba(0,0,0,0.4)"
            nodeColor={(n: any) => { if (n.type === "sticky") return "#fef08a"; if (n.type === "noteCard") return "var(--teal)"; if (n.type === "frame") return "rgba(255,255,255,0.2)"; return "var(--glass-border)"; }}
          />
          <Controls style={{ background: "var(--surface-glass)", border: "1px solid var(--glass-border)", borderRadius: 8, overflow: "hidden" }} />
          <Panel position="top-left">
            <div style={{ padding: "4px 10px", background: "var(--surface-glass)", border: "1px solid var(--glass-border)", borderRadius: 8, fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", gap: 6 }}>
              <span>🎨</span> {canvasName} {dirty && <span style={{ color: "var(--amber)", fontSize: 10 }}>●</span>}
            </div>
          </Panel>
        </ReactFlow>
      </div>
      {error && <div onClick={() => setError("")} style={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", padding: "6px 14px", borderRadius: 8, background: "var(--coral)", color: "#fff", fontSize: 12, zIndex: 100, fontFamily: "var(--font-mono)", cursor: "pointer" }}>{error}</div>}
      {dirty && <div style={{ position: "absolute", bottom: 16, right: 16, padding: "3px 10px", borderRadius: 6, background: "var(--amber)", color: "#1a1a2e", fontSize: 10, fontFamily: "var(--font-mono)", opacity: 0.8 }}>Unsaved</div>}
    </div>
  );
}

export default function HolstCanvas(props: { canvasName: string; onBacklinksChange?: (backlinks: string[]) => void; onCreateCanvas?: (name: string) => void }) {
  return <ReactFlowProvider><HolstFlow {...props} /></ReactFlowProvider>;
}





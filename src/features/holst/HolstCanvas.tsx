import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  Tldraw,
  Editor,
  createShapeId,
  TLShape,
  TLStoreSnapshot,
  useEditor,
  TLAnyShapeUtilityConstructor,
  TLEditorSnapshot,
} from "@tldraw/tldraw";
import "@tldraw/tldraw/tldraw.css";
import "../../styles/holst.css";

import {
  CustomNoteShapeUtil,
  CustomTaskShapeUtil,
  PipelineNodeShapeUtil,
  KanbanFrameShapeUtil,
} from "./shapes";
import { HolstToolbar } from "./toolbar/HolstToolbar";
import { SlashCommandMenu } from "./slash/SlashCommandMenu";
import { autoLayout, pipelineLayout } from "./auto-layout";

const customShapeUtils: TLAnyShapeUtilityConstructor[] = [
  CustomNoteShapeUtil,
  CustomTaskShapeUtil,
  PipelineNodeShapeUtil,
  KanbanFrameShapeUtil,
];

interface HolstCanvasProps {
  canvasName: string;
  onBacklinksChange?: (backlinks: string[]) => void;
  onCreateCanvas?: (name: string) => void;
  onSave?: () => void;
}
function HolstInner({ canvasName, onBacklinksChange, onSave: onSaveProp }: HolstCanvasProps) {
  const editor = useEditor();
  const [dirty, setDirty] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [activeTool, setActiveTool] = useState<string>("select");
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashPos, setSlashPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!editor) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "/" && !slashOpen) {
        e.preventDefault();
        const vp = editor.getViewportScreenBounds();
        setSlashPos({ x: vp.midX - 140, y: vp.midY - 80 });
        setSlashQuery("");
        setSlashOpen(true);
        return;
      }
      if (e.key === "v" || e.key === "V") { setActiveTool("select"); editor.setCurrentTool("select"); }
      if (e.key === "d" || e.key === "D") { setActiveTool("draw"); editor.setCurrentTool("draw"); }
      if (e.key === "t" && !e.ctrlKey && !e.metaKey) { setActiveTool("text"); editor.setCurrentTool("text"); }
      if (e.key === "n" || e.key === "N") { handleInsertShape("sticky"); }
      if (e.key === "a" || e.key === "A") { setActiveTool("connector"); editor.setCurrentTool("connector"); }
      if (e.key === "p" || e.key === "P") { setActiveTool("freehand"); editor.setCurrentTool("draw"); }
      if (e.key === "Escape") { setSlashOpen(false); setActiveTool("select"); editor.setCurrentTool("select"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editor, slashOpen]);

  useEffect(() => {
    if (!editor) return;
    const unsub = editor.on("change", () => setZoomLevel(editor.getZoomLevel()));
    return () => unsub();
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const unsub = editor.on("change", () => setDirty(true));
    return () => unsub();
  }, [editor]);

  const handleInsertShape = useCallback((type: string) => {
    if (!editor) return;
    const vp = editor.getViewportScreenBounds();
    const center = editor.screenToPage({ x: vp.midX, y: vp.midY });
    const common = { x: center.x - 100, y: center.y - 80, rotation: 0 };
    let id: string;
    switch (type) {
      case "note":
      case "noteCard":
        id = createShapeId();
        editor.createShapes([{ id, type: "customNote", props: { notePath: "", markdown: "" }, ...common } as any]);
        break;
      case "task":
      case "taskCard":
        id = createShapeId();
        editor.createShapes([{ id, type: "customTask", props: { title: "New Task", status: "todo" }, ...common } as any]);
        break;
      case "pipeline":
        id = createShapeId();
        editor.createShapes([{ id, type: "pipelineNode", props: { title: "Pipeline Step", stage: 1, status: "queued" }, ...common } as any]);
        break;
      case "kanban":
        id = createShapeId();
        editor.createShapes([{ id, type: "kanbanFrame", props: { title: "New Column", columnStatus: "todo" }, ...common } as any]);
        break;
      case "sticky":
        id = createShapeId();
        editor.createShapes([{ id, type: "sticky", props: { text: "Sticky note", color: "yellow" }, ...common } as any]);
        break;
      default:
        editor.setCurrentTool(type === "text" ? "text" : "draw");
    }
  }, [editor]);

  const handleAutoLayout = useCallback(async () => {
    if (!editor) return;
    const shapes = editor.getShapes();
    if (shapes.length === 0) return;
    const nodes = shapes.filter(s => s.type !== "kanbanFrame").map(s => ({ id: s.id, width: (s.props as any)?.w ?? 200, height: (s.props as any)?.h ?? 160 }));
    const edges = shapes.filter(s => s.type === "arrow" || s.type === "line").flatMap(s => {
      const binding = editor.getBindings(s.id);
      return binding && binding.length > 0 ? [{ id: s.id, source: binding[0].fromId, target: binding[0].toId }] : [];
    });
    const result = await autoLayout(nodes, edges);
    editor.updateShapes(result.nodes.map(({ id, x, y }) => ({ id, type: editor.getShape(id)!.type, x, y })));
  }, [editor]);

  const handlePipelineLayout = useCallback(() => {
    if (!editor) return;
    const shapes = editor.getShapes().filter(s => s.type === "pipelineNode");
    if (shapes.length === 0) return;
    const nodes = shapes.map(s => ({ id: s.id, width: (s.props as any)?.w ?? 200, height: (s.props as any)?.h ?? 80 }));
    const result = pipelineLayout(nodes, 100, 100, 140);
    editor.updateShapes(result.nodes.map(({ id, x, y }) => ({ id, type: editor.getShape(id)!.type, x, y })));
  }, [editor]);

  const handleSave = useCallback(() => {
    if (!editor) return;
    const snapshot = editor.getSnapshot();
    const serialized = JSON.stringify(snapshot, null, 2);
    const event = new CustomEvent("holst-save", { detail: { canvasName, data: serialized } });
    window.dispatchEvent(event);
    setDirty(false);
    onSaveProp?.();
  }, [editor, canvasName, onSaveProp]);

  const handleExport = useCallback(async () => {
    if (!editor) return;
    try {
      const svg = await editor.getSvg({ background: true });
      if (!svg) return;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const svgStr = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
      img.onload = () => {
        canvas.width = img.width * 2;
        canvas.height = img.height * 2;
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => {
          if (b) {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(b);
            a.download = `${canvasName || "canvas"}.png`;
            a.click();
          }
        });
      };
      img.src = url;
    } catch (e) { console.error("Export failed:", e); }
  }, [editor, canvasName]);

  const slashCommands = useMemo(() => [
    { id: "note", label: "Insert Note", icon: "📝", description: "Create a linked note card", action: () => handleInsertShape("note") },
    { id: "task", label: "Insert Task", icon: "✅", description: "Create a syncable task card", action: () => handleInsertShape("task") },
    { id: "kanban", label: "Deploy Kanban Board", icon: "📋", description: "Insert a Kanban frame column", action: () => handleInsertShape("kanban") },
    { id: "pipeline", label: "Insert Pipeline Stage", icon: "⚙️", description: "Create a CI/CD pipeline step node", action: () => handleInsertShape("pipeline") },
    { id: "sticky", label: "Add Sticky Note", icon: "💛", description: "A simple sticky note", action: () => handleInsertShape("sticky") },
    { id: "auto-layout", label: "Auto-Arrange Layout", icon: "⟳", description: "Run ELK hierarchical layout", action: () => handleAutoLayout() },
    { id: "pipeline-layout", label: "Pipeline Layout", icon: "⊢", description: "Line up pipeline nodes", action: () => handlePipelineLayout() },
    { id: "fit-screen", label: "Fit to Screen", icon: "⊞", description: "Zoom to fit all shapes", action: () => editor?.zoomToFit() },
  ], [handleInsertShape, handleAutoLayout, handlePipelineLayout, editor]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "center", padding: "6px 8px 0", flexShrink: 0, zIndex: 10, pointerEvents: "none" }}>
        <div style={{ pointerEvents: "auto" }}>
          <HolstToolbar
            activeTool={activeTool}
            setActiveTool={(t) => { setActiveTool(t); editor?.setCurrentTool(t === "select" ? "select" : t === "draw" ? "draw" : t === "text" ? "text" : "select"); }}
            onSave={handleSave}
            onExport={handleExport}
            onZoomIn={() => editor?.zoomIn()}
            onZoomOut={() => editor?.zoomOut()}
            onFitScreen={() => editor?.zoomToFit()}
            zoomLevel={zoomLevel}
            onAutoLayout={handleAutoLayout}
            onPipelineLayout={handlePipelineLayout}
            onInsertShape={handleInsertShape}
            canvasName={canvasName}
            dirty={dirty}
          />
        </div>
      </div>
      <div className="holst-container" style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
        <Tldraw
          hideUi
          shapeUtils={customShapeUtils}
          onMount={(e) => {
            const stored = sessionStorage.getItem(`holst-${canvasName}`);
            if (stored) {
              try { e.loadSnapshot(JSON.parse(stored) as TLEditorSnapshot); } catch { /* */ }
            }
          }}
          autoFocus inferDarkMode
        />
      </div>
      <SlashCommandMenu isOpen={slashOpen} query={slashQuery} position={slashPos} commands={slashCommands} onClose={() => setSlashOpen(false)} />
    </div>
  );
}

export default function HolstCanvas(props: HolstCanvasProps) {
  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}>
      <Tldraw hideUi shapeUtils={customShapeUtils}>
        <HolstInner {...props} />
      </Tldraw>
    </div>
  );
}

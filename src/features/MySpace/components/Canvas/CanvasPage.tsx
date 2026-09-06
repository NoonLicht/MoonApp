import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Tldraw } from "tldraw";
import { api } from "../../../../api/client";
import { NoteCardUtil, TaskCardUtil } from "./canvasShapes";
import HolstHeader from "./HolstHeader";
import HolstToolbar from "./HolstToolbar";
import TemplatesModal from "./HolstTemplates";
import "./canvasTheme.css";

export default function CanvasPage() {
  const [boardName, setBoardName] = useState("Untitled Canvas");
  const [activeTool, setActiveTool] = useState("select");
  const [showTemplates, setShowTemplates] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  const editorRef = useRef<any>(null);
  const saveTimerRef = useRef<any>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const customShapeUtils = useMemo(() => [NoteCardUtil, TaskCardUtil], []);

  useEffect(() => {
    const loadBoard = async () => {
      try {
        const holsts = await api.myspaceListHolsts();
        if (holsts.length > 0) {
          const last = holsts[0];
          const result = await api.myspaceReadHolst(last.name);
          if (result?.data) {
            setBoardName(last.name);
            setLoaded(true);
            return;
          }
        }
      } catch { /* first time */ }
      setLoaded(true);
    };
    loadBoard();
  }, []);

  const triggerSave = useCallback(async () => {
    if (!editorRef.current) return;
    setSaving(true);
    try {
      const snapshot = editorRef.current.getSnapshot();
      await api.myspaceWriteHolst(boardName, snapshot);
      setIsDirty(false);
    } catch (e) {
      console.error("Save failed:", e);
    }
    setSaving(false);
  }, [boardName]);

  useEffect(() => {
    if (!isDirty) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(triggerSave, 3000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [isDirty, triggerSave]);

  const handleEditorMount = useCallback((editor: any) => {
    editorRef.current = editor;
    // Clean up previous listener
    if (unsubRef.current) { try { unsubRef.current(); } catch {} }
    // Subscribe to store changes
    unsubRef.current = editor.store.listen(() => setIsDirty(true));
  }, []);

  // Cleanup store listener on unmount
  useEffect(() => {
    return () => {
      if (unsubRef.current) { try { unsubRef.current(); } catch {} }
    };
  }, []);

  const handleToolChange = useCallback((toolId: string) => {
    setActiveTool(toolId);
    if (!editorRef.current) return;
    const e = editorRef.current;
    switch (toolId) {
      case "select": e.setCurrentTool("select"); break;
      case "hand": e.setCurrentTool("hand"); break;
      case "draw": e.setCurrentTool("draw"); break;
      case "eraser": e.setCurrentTool("eraser"); break;
    }
  }, []);

  const handleTemplate = useCallback((templateId: string) => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    const shapes: any[] = [];
    switch (templateId) {
      case "mindmap":
        shapes.push({ id: "mm-center", type: "noteCard", x: 400, y: 300, props: { title: "Central Idea", body: "Branch out" } });
        shapes.push({ id: "mm-1", type: "noteCard", x: 200, y: 420, props: { title: "Idea 1", body: "" } });
        shapes.push({ id: "mm-2", type: "noteCard", x: 600, y: 420, props: { title: "Idea 2", body: "" } });
        break;
      case "retro":
        ["Start", "Stop", "Continue"].forEach((title, i) => {
          shapes.push({ id: `retro-${i}`, type: "noteCard", x: 80 + i * 300, y: 250, props: { title, body: "" } });
        });
        break;
      case "sprint":
        shapes.push({ id: "sp-header", type: "noteCard", x: 300, y: 150, props: { title: "Effort vs Impact", body: "Drag tasks into grid" } });
        break;
      case "flowchart":
        shapes.push({ id: "fc-start", type: "noteCard", x: 300, y: 200, props: { title: "Start", body: "Begin" } });
        shapes.push({ id: "fc-decision", type: "noteCard", x: 300, y: 350, props: { title: "Decision?", body: "Yes/No" } });
        shapes.push({ id: "fc-end", type: "noteCard", x: 300, y: 500, props: { title: "End", body: "" } });
        break;
    }
    for (const s of shapes) {
      try { editor.createShape(s); } catch { /* skip */ }
    }
    setIsDirty(true);
  }, []);

  const handleExport = useCallback(async () => {
    if (!editorRef.current) return;
    try {
      const blob = await editorRef.current.toImage({ format: "png", background: false });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${boardName}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* fallback */ }
  }, [boardName]);

  if (!loaded) {
    return (
      <div className="holst-canvas-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
        Loading canvas...
      </div>
    );
  }

  return (
    <div className="holst-canvas-wrapper">
      <HolstHeader boardName={boardName} onNameChange={setBoardName} onSave={triggerSave} onTemplates={() => setShowTemplates(true)} onExport={handleExport} zoom={zoom} saving={saving} />
      <HolstToolbar activeTool={activeTool} onChange={handleToolChange} />
      {showTemplates && <TemplatesModal onClose={() => setShowTemplates(false)} onSelect={handleTemplate} />}
      <div style={{ width: "100%", height: "100%", paddingTop: 40 }}>
        <Tldraw hideUi shapeUtils={customShapeUtils} onMount={handleEditorMount} />
      </div>
    </div>
  );
}
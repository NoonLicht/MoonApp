import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  MarkerType,
  ConnectionLineType,
} from "@xyflow/react";
import dagre from "dagre";
import { api } from "@/api/client";
import { nodeTypes, edgeTypes } from "@/pages/myspace/canvas/nodes";
import HolstHeader from "@/pages/myspace/canvas/HolstHeader";
import HolstToolbar, { type LineProps } from "@/pages/myspace/canvas/HolstToolbar";
import TemplatesModal from "@/pages/myspace/canvas/HolstTemplates";
import { STICKY_COLORS, type CanvasTool, type ShapeKind } from "@/pages/myspace/canvas/types";
import { TEMPLATES } from "@/pages/myspace/canvas/templates";
import "@/styles/canvas.css";
import "@xyflow/react/dist/style.css";

/* ───────────────────────── helpers ───────────────────────── */

let seq = 0;
const uid = (p: string) =>
  `${p}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** Strip runtime functions from node data — .holst stays plain JSON (RAM guardrails). */
const clean = (list: any[]) => JSON.parse(JSON.stringify(list));

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
};

const defaultSize: Record<string, { width: number; height: number }> = {
  sticky: { width: 170, height: 150 },
  text: { width: 200, height: 44 },
  shape: { width: 160, height: 90 },
  frame: { width: 420, height: 320 },
  task: { width: 210, height: 120 },
  md: { width: 190, height: 150 },
  matrix: { width: 460, height: 330 },
  sticker: { width: 48, height: 48 },
  image: { width: 320, height: 200 },
};

/** Файл → data URL (для вставленных/перетащенных изображений — храним прямо в .holst JSON). */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Натуральный размер картинки по data URL, чтобы новый узел не растягивал/сплющивал вставленный скриншот. */
function imageNaturalSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 320, h: img.naturalHeight || 200 });
    img.onerror = () => resolve({ w: 320, h: 200 });
    img.src = src;
  });
}

/* ───────────────────────── inner canvas ───────────────────────── */

function CanvasInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const { screenToFlowPosition, zoomIn, zoomOut, setViewport, getViewport, fitView } =
    useReactFlow();

  const [boardName, setBoardName] = useState("Untitled Holst 01");
  const [tool, setTool] = useState<CanvasTool>("select");
  const [shape, setShape] = useState<ShapeKind>("rounded");
  const [sticker, setSticker] = useState("👍");
  const [lineProps, setLineProps] = useState<LineProps>({
    style: "bezier",
    dash: "solid",
    arrowStart: false,
    arrowEnd: true,
    animated: false,
  });

  const [showTemplates, setShowTemplates] = useState(false);
  const [slash, setSlash] = useState<{ x: number; y: number; fx: number; fy: number } | null>(null);
  const [connectMenu, setConnectMenu] = useState<{
    x: number;
    y: number;
    fx: number;
    fy: number;
    source: string;
    handle: string;
  } | null>(null);
  const [penPreview, setPenPreview] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);

  const [zoom, setZoom] = useState(1);
  const [loaded, setLoaded] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const past = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const future = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const [, forceHist] = useState(0);
  const skipSave = useRef(true);
  const saveTimer = useRef<any>(null);
  const dirtyRef = useRef(false);
  const frameDrag = useRef<{
    frameId: string;
    children: string[];
    starts: Record<string, { x: number; y: number }>;
    origin: { x: number; y: number };
  } | null>(null);
  const penPoints = useRef<{ x: number; y: number }[]>([]);
  const penOrigin = useRef<{ x: number; y: number } | null>(null);

  /* ── history (Ctrl+Z / Ctrl+Y) ── */
  const pushHistory = useCallback(
    (snapshot?: { nodes: Node[]; edges: Edge[] }) => {
      past.current = [
        ...past.current.slice(-49),
        snapshot || { nodes: clean(nodes), edges: clean(edges) },
      ];
      future.current = [];
      forceHist((v) => v + 1);
    },
    [nodes, edges],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current = [...future.current, { nodes: clean(nodes), edges: clean(edges) }];
    setNodes(prev.nodes);
    setEdges(prev.edges);
    forceHist((v) => v + 1);
  }, [nodes, edges, setNodes, setEdges]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current = [...past.current, { nodes: clean(nodes), edges: clean(edges) }];
    setNodes(next.nodes);
    setEdges(next.edges);
    forceHist((v) => v + 1);
  }, [nodes, edges, setNodes, setEdges]);

  /* ── node factory ── */
  const addNode = useCallback(
    (type: string, pos: { x: number; y: number }, data: any, extra?: Partial<Node>): Node => {
      const size = defaultSize[type] || { width: 160, height: 90 };
      const n: Node = {
        id: uid(type),
        type,
        position: pos,
        data,
        style: { width: size.width, height: size.height },
        ...(type === "frame" ? { zIndex: -1 } : {}),
        ...extra,
      };
      setNodes((ns) => [...ns, n]);
      return n;
    },
    [setNodes],
  );

  const setData = useCallback(
    (id: string, patch: any) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    },
    [setNodes],
  );

  const addConnectorEdge = useCallback(
    (source: string, sourceHandle: string | null, target: string, targetHandle: string | null) => {
      setEdges((es) => [
        ...es,
        {
          id: uid("e"),
          source,
          target,
          sourceHandle: sourceHandle || undefined,
          targetHandle: targetHandle || undefined,
          type: "connector",
          markerEnd: { type: MarkerType.ArrowClosed, color: "#8b7bf0" },
          style: { stroke: "#8b7bf0", strokeWidth: 2 },
          data: { ...lineProps },
        } as Edge,
      ]);
    },
    [setEdges, lineProps],
  );

  /* ── persistence: load .holst on mount ── */
  useEffect(() => {
    (async () => {
      try {
        const list = await api.myspaceListHolsts();
        const mine = (list as any[]).find((h: any) => h.name === boardName) || (list as any[])[0];
        if (mine) {
          const res: any = await api.myspaceReadHolst(mine.name);
          const doc = res?.data;
          if (doc && doc.version === 2 && Array.isArray(doc.nodes)) {
            setBoardName(doc.name || mine.name);
            // re-attach runtime callbacks stripped during JSON persistence
            setNodes(
              (doc.nodes as any[]).map((n) => ({
                ...n,
                data: { ...n.data, setData },
              })),
            );
            setEdges(doc.edges || []);
            if (doc.viewport) setViewport(doc.viewport);
          }
        }
      } catch {
        /* first run */
      }
      skipSave.current = false;
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── autosave (debounced, flat JSON) ── */
  const save = useCallback(async () => {
    if (skipSave.current) return;
    try {
      await api.myspaceWriteHolst(boardName, {
        version: 2,
        name: boardName,
        nodes: clean(nodes),
        edges: clean(edges),
        viewport: getViewport(),
        updatedAt: new Date().toISOString(),
      });
      dirtyRef.current = false;
    } catch (e) {
      console.error("holst save failed", e);
    }
  }, [boardName, nodes, edges, getViewport]);

  useEffect(() => {
    if (skipSave.current || !loaded) return;
    dirtyRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 2500);
    return () => clearTimeout(saveTimer.current);
  }, [nodes, edges, boardName, loaded, save]);

  useEffect(() => {
    const onBeforeUnload = () => {
      if (dirtyRef.current) save();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [save]);

  /* ── zoom indicator sync ── */
  useEffect(() => {
    const iv = setInterval(() => setZoom(getViewport().zoom), 350);
    return () => clearInterval(iv);
  }, [getViewport]);

  /* ── toolbar factory clicks ── */
  const spawnForTool = useCallback(
    (flowPos: { x: number; y: number }) => {
      pushHistory();
      switch (tool) {
        case "sticky":
          addNode("sticky", flowPos, {
            text: "",
            color: STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)],
            setData,
          });
          break;
        case "text":
          addNode("text", flowPos, {
            text: "Text",
            fontSize: 16,
            weight: 600,
            align: "left",
            setData,
          });
          break;
        case "shape":
          addNode("shape", flowPos, {
            shape,
            label: "Label",
            fill: STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)],
            stroke: "#16181f",
            w: 160,
            h: 90,
            setData,
          });
          break;
        case "frame":
          addNode("frame", flowPos, { label: "Frame", color: "#3fc7ab", w: 420, h: 320, setData });
          break;
        case "task":
          addNode("task", flowPos, {
            title: "New task",
            status: "todo",
            subtasks: [{ text: "step", done: false }],
            setData,
          });
          break;
        case "sticker": {
          if (sticker.startsWith("pill:")) {
            const pill = sticker.slice(5);
            addNode(
              "shape",
              flowPos,
              {
                shape: "rounded",
                label: pill,
                fill: pill === "CRITICAL" ? "#fed7aa" : "#bbf7d0",
                stroke: "#16181f",
                w: 130,
                h: 44,
                setData,
              },
              { style: { width: 130, height: 44 } },
            );
          } else {
            addNode("sticker", flowPos, { emoji: sticker, setData });
          }
          break;
        }
        default:
          return false;
      }
      setTool("select");
      return true;
    },
    [tool, shape, sticker, addNode, setData, pushHistory],
  );

  /* ── smart frame: moving a frame carries its children ── */
  const onNodeDragStart = useCallback(
    (_: any, node: Node) => {
      pushHistory();
      if (node.type !== "frame") {
        frameDrag.current = null;
        return;
      }
      const fw = (node.style?.width as number) || 420;
      const fh = (node.style?.height as number) || 320;
      const children = nodes.filter((n) => {
        if (n.id === node.id || n.type === "frame") return false;
        const cx = n.position.x + ((n.style?.width as number) || 160) / 2;
        const cy = n.position.y + ((n.style?.height as number) || 90) / 2;
        return (
          cx > node.position.x &&
          cx < node.position.x + fw &&
          cy > node.position.y &&
          cy < node.position.y + fh
        );
      });
      frameDrag.current = {
        frameId: node.id,
        children: children.map((c) => c.id),
        starts: Object.fromEntries(children.map((c) => [c.id, { ...c.position }])),
        origin: { ...node.position },
      };
    },
    [nodes, pushHistory],
  );

  const onNodeDrag = useCallback(
    (_: any, node: Node) => {
      const fd = frameDrag.current;
      if (!fd || node.id !== fd.frameId) return;
      const dx = node.position.x - fd.origin.x;
      const dy = node.position.y - fd.origin.y;
      setNodes((ns) =>
        ns.map((n) => {
          const s = fd.starts[n.id];
          if (!s) return n;
          return { ...n, position: { x: s.x + dx, y: s.y + dy } };
        }),
      );
    },
    [setNodes],
  );

  /* ── connect (smart connectors) ── */
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      pushHistory();
      addConnectorEdge(c.source, c.sourceHandle, c.target, c.targetHandle);
    },
    [addConnectorEdge, pushHistory],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: any) => {
      if (!state || state.isValid) return;
      const fromNode = state.fromNode;
      if (!fromNode) return;
      const pt = "touches" in event ? event.touches[0] : (event as MouseEvent);
      const rect = wrapRef.current?.getBoundingClientRect();
      const x = pt.clientX - (rect?.left || 0);
      const y = pt.clientY - (rect?.top || 0);
      const flow = screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
      setConnectMenu({
        x,
        y,
        fx: flow.x,
        fy: flow.y,
        source: fromNode.id,
        handle: state.fromHandle?.id || "r",
      });
    },
    [screenToFlowPosition],
  );

  const connectSpawn = useCallback(
    (kind: "note" | "task" | "decision") => {
      if (!connectMenu) return;
      pushHistory();
      let n: Node;
      if (kind === "note")
        n = addNode(
          "sticky",
          { x: connectMenu.fx, y: connectMenu.fy },
          { text: "", color: STICKY_COLORS[2], setData },
        );
      else if (kind === "task")
        n = addNode(
          "task",
          { x: connectMenu.fx, y: connectMenu.fy },
          { title: "New task", status: "todo", subtasks: [], setData },
        );
      else
        n = addNode(
          "shape",
          { x: connectMenu.fx, y: connectMenu.fy },
          {
            shape: "diamond",
            label: "Decision",
            fill: STICKY_COLORS[0],
            stroke: "#16181f",
            w: 160,
            h: 90,
            setData,
          },
        );
      addConnectorEdge(connectMenu.source, connectMenu.handle, n.id, "l");
      setConnectMenu(null);
    },
    [connectMenu, addNode, addConnectorEdge, pushHistory, setData],
  );

  /* ── slash palette insert ── */
  const slashInsert = useCallback(
    (kind: string) => {
      if (!slash) return;
      pushHistory();
      const pos = { x: slash.fx, y: slash.fy };
      switch (kind) {
        case "note":
          addNode("sticky", pos, { text: "", color: STICKY_COLORS[3], setData });
          break;
        case "task":
          addNode("task", pos, { title: "New task", status: "todo", subtasks: [], setData });
          break;
        case "sticky":
          addNode("sticky", pos, { text: "", color: STICKY_COLORS[0], setData });
          break;
        case "matrix":
          addNode("matrix", pos, {
            title: "Impact Matrix",
            columns: ["Quick Wins", "Major", "Fill-ins", "Thankless"],
            items: [],
            setData,
          });
          break;
        case "frame":
          addNode("frame", pos, {
            label: "Retro Frame",
            color: "#e9d5ff",
            w: 420,
            h: 320,
            setData,
          });
          break;
        case "text":
          addNode("text", pos, { text: "Text", fontSize: 16, weight: 600, align: "left", setData });
          break;
      }
      setSlash(null);
    },
    [slash, addNode, setData, pushHistory],
  );

  /* ── drop .md from MySpace sidebar, либо файл изображения (скриншот) с диска ── */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      const imageFile = [...event.dataTransfer.files].find((f) => f.type.startsWith("image/"));
      if (imageFile) {
        void (async () => {
          const src = await fileToDataUrl(imageFile);
          const { w, h } = await imageNaturalSize(src);
          pushHistory();
          const scale = Math.min(1, 480 / w);
          addNode(
            "image",
            flow,
            { src, w, h },
            { style: { width: Math.round(w * scale), height: Math.round(h * scale) } },
          );
        })();
        return;
      }

      const mdPath = event.dataTransfer.getData("text/plain");
      if (!mdPath || !mdPath.toLowerCase().endsWith(".md")) return;
      pushHistory();
      addNode("md", flow, {
        path: mdPath,
        name: mdPath.split("/").pop() || mdPath,
        loaded: false,
        setData,
      });
    },
    [screenToFlowPosition, addNode, setData, pushHistory],
  );

  /* ── вставка скриншота/картинки из буфера обмена (Ctrl+V) — "экранные заметки":
     сделал снимок (например через будущую страницу Скриншотов или штатный
     инструмент Windows), вставил на холст, обвёл/подписал уже существующими
     инструментами (Pen/стикеры/текст) ── */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageItem = [...items].find((it) => it.type.startsWith("image/"));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      void (async () => {
        const src = await fileToDataUrl(file);
        const { w, h } = await imageNaturalSize(src);
        const wrap = wrapRef.current;
        const center = wrap
          ? screenToFlowPosition({
              x: wrap.getBoundingClientRect().left + wrap.clientWidth / 2,
              y: wrap.getBoundingClientRect().top + wrap.clientHeight / 2,
            })
          : { x: 0, y: 0 };
        pushHistory();
        const scale = Math.min(1, 480 / w);
        addNode(
          "image",
          { x: center.x - (w * scale) / 2, y: center.y - (h * scale) / 2 },
          { src, w, h },
          { style: { width: Math.round(w * scale), height: Math.round(h * scale) } },
        );
      })();
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [screenToFlowPosition, addNode, pushHistory]);

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes("text/plain")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  /* ── pen (freehand strokes) ── */
  const onPenDown = useCallback(
    (e: React.PointerEvent) => {
      if (tool !== "pen" || e.button !== 0) return;
      const rect = wrapRef.current!.getBoundingClientRect();
      penOrigin.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      penPoints.current = [penOrigin.current];
      setPenPreview({
        x1: penOrigin.current.x,
        y1: penOrigin.current.y,
        x2: penOrigin.current.x,
        y2: penOrigin.current.y,
      });
    },
    [tool],
  );

  const onPenMove = useCallback(
    (e: React.PointerEvent) => {
      if (tool !== "pen" || penPoints.current.length === 0) return;
      const rect = wrapRef.current!.getBoundingClientRect();
      penPoints.current.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      setPenPreview({
        x1: penOrigin.current!.x,
        y1: penOrigin.current!.y,
        x2: e.clientX - rect.left,
        y2: e.clientY - rect.top,
      });
    },
    [tool],
  );

  const onPenUp = useCallback(() => {
    if (tool !== "pen" || penPoints.current.length < 2) {
      setPenPreview(null);
      penPoints.current = [];
      return;
    }
    const screenPts = penPoints.current;
    const minX = Math.min(...screenPts.map((p) => p.x)) - 12;
    const minY = Math.min(...screenPts.map((p) => p.y)) - 12;
    const maxX = Math.max(...screenPts.map((p) => p.x)) + 12;
    const maxY = Math.max(...screenPts.map((p) => p.y)) + 12;
    const tl = screenToFlowPosition({ x: minX, y: minY });
    const br = screenToFlowPosition({ x: maxX, y: maxY });
    const w = br.x - tl.x,
      h = br.y - tl.y;
    const pts = screenPts.map((p) => [p.x - minX, p.y - minY] as [number, number]);
    pushHistory();
    addNode(
      "stroke",
      tl,
      { points: pts, color: "#f0a63d", width: 3, opacity: 0.9, w, h },
      { style: { width: w, height: h }, draggable: false },
    );
    penPoints.current = [];
    setPenPreview(null);
  }, [tool, screenToFlowPosition, addNode, pushHistory]);

  /* ── auto-layout (dagre) ── */
  const autoLayout = useCallback(() => {
    if (nodes.length === 0) return;
    pushHistory();
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 90 });
    g.setDefaultEdgeLabel(() => ({}));
    nodes.forEach((n) => {
      const w = (n.style?.width as number) || (n.measured?.width as number) || 180;
      const h = (n.style?.height as number) || (n.measured?.height as number) || 100;
      g.setNode(n.id, { width: w, height: h });
    });
    edges.forEach((e) => {
      if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
    });
    dagre.layout(g);
    setNodes((ns) =>
      ns.map((n) => {
        const pos = g.node(n.id);
        if (!pos) return n;
        const w = (n.style?.width as number) || 180;
        const h = (n.style?.height as number) || 100;
        return { ...n, position: { x: pos.x - w / 2, y: pos.y - h / 2 } };
      }),
    );
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 60);
  }, [nodes, edges, setNodes, fitView, pushHistory]);

  /* ── export ── */
  const exportJson = useCallback(() => {
    const doc = {
      version: 2,
      name: boardName,
      nodes: clean(nodes),
      edges: clean(edges),
      viewport: getViewport(),
      updatedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${boardName || "holst"}.holst`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [boardName, nodes, edges, getViewport]);

  const exportImage = useCallback(
    async (fmt: "png" | "svg") => {
      const viewportEl = wrapRef.current?.querySelector(
        ".react-flow__viewport",
      ) as HTMLElement | null;
      if (!viewportEl) return;
      const clone = viewportEl.cloneNode(true) as HTMLElement;
      const srcEls = [viewportEl, ...Array.from(viewportEl.querySelectorAll("*"))] as HTMLElement[];
      const dstEls = [clone, ...Array.from(clone.querySelectorAll("*"))] as HTMLElement[];
      const cssProps = [
        "position",
        "left",
        "top",
        "width",
        "height",
        "margin",
        "padding",
        "background-color",
        "background",
        "border",
        "border-radius",
        "box-shadow",
        "color",
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
        "text-align",
        "display",
        "flex-direction",
        "align-items",
        "justify-content",
        "gap",
        "overflow",
        "opacity",
        "transform",
        "stroke",
        "fill",
        "stroke-width",
        "stroke-dasharray",
        "letter-spacing",
        "white-space",
      ];
      srcEls.forEach((src, i) => {
        const cs = window.getComputedStyle(src);
        const dst = dstEls[i];
        if (!dst) return;
        const css = cssProps.map((k) => `${k}:${cs.getPropertyValue(k)};`).join("");
        dst.setAttribute("style", css + (dst.getAttribute("style") || ""));
      });
      const bbox = viewportEl.getBoundingClientRect();
      const wrapRect = wrapRef.current!.getBoundingClientRect();
      const offX = bbox.left - wrapRect.left,
        offY = bbox.top - wrapRect.top;
      const W = Math.ceil(bbox.width),
        H = Math.ceil(bbox.height);
      const html = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;height:${H}px;overflow:hidden;position:relative;">
          <div style="position:absolute;left:${-offX}px;top:${-offY}px;">${clone.outerHTML}</div>
        </div>
      </foreignObject>
    </svg>`;
      const url = URL.createObjectURL(new Blob([html], { type: "image/svg+xml;charset=utf-8" }));
      const a = document.createElement("a");
      a.download = `${boardName || "holst"}.${fmt}`;
      if (fmt === "svg") {
        a.href = url;
        a.click();
      } else {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = url;
        });
        const canvas = document.createElement("canvas");
        const scale = 2;
        canvas.width = W * scale;
        canvas.height = H * scale;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#11141f";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        a.href = canvas.toDataURL("image/png");
        a.click();
      }
      URL.revokeObjectURL(url);
    },
    [boardName],
  );

  const onExport = useCallback(
    (fmt: "png" | "svg" | "json") => {
      if (fmt === "json") exportJson();
      else exportImage(fmt).catch(() => exportJson());
    },
    [exportJson, exportImage],
  );

  /* ── templates ── */
  const applyTemplate = useCallback(
    (id: string) => {
      const tpl = TEMPLATES.find((t) => t.id === id);
      if (!tpl) return;
      const rect = wrapRef.current!.getBoundingClientRect();
      const c = screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      const { nodes: tn, edges: te } = tpl.gen(c.x - 300, c.y - 200);
      pushHistory();
      setNodes((ns) => [...ns, ...tn.map((n) => ({ ...n, data: { ...n.data, setData } }))]);
      setEdges((es) => [...es, ...te]);
      setTimeout(() => fitView({ padding: 0.2, duration: 350 }), 80);
    },
    [screenToFlowPosition, pushHistory, setNodes, setEdges, setData, fitView],
  );

  /* ── keyboard: tools, undo/redo, slash, delete, fit ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (meta) return;
      if (e.key === "Escape") {
        setSlash(null);
        setConnectMenu(null);
        setShowTemplates(false);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const selN = nodes.filter((n) => n.selected);
        const selE = edges.filter((ed) => ed.selected);
        if (selN.length || selE.length) {
          e.preventDefault();
          pushHistory();
          setNodes((ns) => ns.filter((n) => !n.selected));
          setEdges((es) => es.filter((ed) => !ed.selected));
        }
        return;
      }
      if (e.key === "!") {
        e.preventDefault();
        fitView({ padding: 0.3, duration: 250 });
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        const rect = wrapRef.current!.getBoundingClientRect();
        const cx = rect.left + rect.width / 2,
          cy = rect.top + rect.height / 2;
        const f = screenToFlowPosition({ x: cx, y: cy });
        setSlash({ x: rect.width / 2 - 120, y: rect.height / 2 - 60, fx: f.x, fy: f.y });
        return;
      }
      const map: Record<string, CanvasTool> = {
        v: "select",
        h: "hand",
        n: "sticky",
        t: "text",
        s: "shape",
        a: "connector",
        f: "frame",
        k: "task",
        p: "pen",
        e: "sticker",
      };
      const k = e.key.toLowerCase();
      if (map[k]) {
        setTool(map[k]);
        setSlash(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, redo, nodes, edges, setNodes, setEdges, pushHistory, fitView, screenToFlowPosition]);

  if (!loaded) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--text-tertiary)",
          fontSize: 13,
        }}
      >
        Loading canvas…
      </div>
    );
  }

  const cursor =
    tool === "hand"
      ? "grab"
      : tool === "pen"
        ? "crosshair"
        : tool === "select"
          ? "default"
          : "copy";

  return (
    <div
      ref={wrapRef}
      className="holst-page"
      style={{ cursor }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerDown={onPenDown}
      onPointerMove={onPenMove}
      onPointerUp={onPenUp}
      onPointerLeave={onPenUp}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={save}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionLineType={ConnectionLineType.Bezier}
        connectionRadius={34}
        onlyRenderVisibleElements={true}
        panOnDrag={tool === "hand"}
        selectionOnDrag={tool === "select"}
        nodesDraggable={tool !== "pen" && tool !== "hand"}
        zoomOnDoubleClick={false}
        minZoom={0.08}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
        onPaneClick={(ev) => {
          const f = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
          spawnForTool(f);
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="#262a3f" />
      </ReactFlow>

      {/* pen live preview */}
      {penPreview && (
        <svg
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 45,
          }}
        >
          <line
            x1={penPreview.x1}
            y1={penPreview.y1}
            x2={penPreview.x2}
            y2={penPreview.y2}
            stroke="#f0a63d"
            strokeWidth={3}
            strokeLinecap="round"
            opacity={0.9}
          />
        </svg>
      )}

      {/* header */}
      <HolstHeader
        boardName={boardName}
        onName={setBoardName}
        canUndo={past.current.length > 0}
        canRedo={future.current.length > 0}
        onUndo={undo}
        onRedo={redo}
        onTemplates={() => setShowTemplates(true)}
        onExport={onExport}
        zoom={zoom}
        onZoomIn={() => zoomIn({ duration: 150 })}
        onZoomOut={() => zoomOut({ duration: 150 })}
        onFit={() => fitView({ padding: 0.25, duration: 250 })}
        onResetZoom={() => setViewport({ ...getViewport(), zoom: 1 }, { duration: 200 })}
      />

      {/* left dock */}
      <HolstToolbar
        activeTool={tool}
        onTool={setTool}
        shape={shape}
        onShape={setShape}
        lineProps={lineProps}
        onLineProps={(patch) => setLineProps((lp) => ({ ...lp, ...patch }))}
        sticker={sticker}
        onSticker={setSticker}
        onAutoLayout={autoLayout}
      />

      {/* slash command palette */}
      {slash && (
        <div
          className="holst-slash"
          style={{ left: slash.x, top: slash.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(
            [
              ["note", "📝", "Note"],
              ["sticky", "🟡", "Sticky note"],
              ["task", "✅", "Task"],
              ["matrix", "📋", "Impact Matrix"],
              ["frame", "🖼", "Retro Frame"],
              ["text", "🅣", "Text label"],
            ] as const
          ).map(([id, ico, label]) => (
            <button key={id} className="holst-pop-item" onClick={() => slashInsert(id)}>
              <span>{ico}</span> {label}
            </button>
          ))}
        </div>
      )}

      {/* quick-connect branching menu */}
      {connectMenu && (
        <div
          className="holst-pop"
          style={{ left: connectMenu.x, top: connectMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button className="holst-pop-item" onClick={() => connectSpawn("note")}>
            📝 Create connected Note
          </button>
          <button className="holst-pop-item" onClick={() => connectSpawn("task")}>
            ✅ Create connected Task
          </button>
          <button className="holst-pop-item" onClick={() => connectSpawn("decision")}>
            💠 Create Decision Node
          </button>
        </div>
      )}

      {/* tool hint */}
      {tool !== "select" && (
        <div className="holst-canvas-hint">
          {tool === "hand" && "Hand: drag to pan · scroll to zoom"}
          {tool === "sticky" && "Click empty canvas to drop a sticky note"}
          {tool === "text" && "Click to place a text label"}
          {tool === "shape" && `Click to place ${shape}`}
          {tool === "connector" && "Drag from a node handle to another node"}
          {tool === "frame" && "Click to draw a smart frame"}
          {tool === "task" && "Click to place a synced task card"}
          {tool === "pen" && "Draw freehand · strokes become vector nodes"}
          {tool === "sticker" &&
            `Click to place ${sticker.startsWith("pill:") ? sticker.slice(5) + " pill" : sticker}`}
        </div>
      )}

      {showTemplates && (
        <TemplatesModal onClose={() => setShowTemplates(false)} onSelect={applyTemplate} />
      )}
    </div>
  );
}

/* ───────────────────────── export ───────────────────────── */

export default function CanvasPage() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

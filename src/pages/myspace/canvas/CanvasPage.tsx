import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dagre from "dagre";
import { toPng, toSvg } from "html-to-image";
import { api } from "@/api/client";
import { useI18n } from "@/app/i18n";
import {
  alignDeltas,
  boundsOf,
  boxesTouch,
  center,
  distributeDeltas,
  lineGeom,
  make,
  rotatePt,
  snapMove,
  unionBox,
  type AlignKind,
  type Box,
  type Guide,
  type HolstDoc,
  type Obj,
  type Pt,
  type ShapeKind,
} from "@/pages/myspace/canvas/model";
import {
  cloneObjs,
  deleteObjs,
  fitGroups,
  groupObjs,
  mapById,
  moveObjs,
  reorder,
  reparent,
  rotateAround,
  selectionBox,
  topGroupOf,
  ungroupObjs,
  withChildren,
  type Order,
} from "@/pages/myspace/canvas/board";
import { fromFlow } from "@/pages/myspace/canvas/legacy";
import { TEMPLATES } from "@/pages/myspace/canvas/templates";
import { strings } from "@/pages/myspace/canvas/strings";
import { useBoard } from "@/pages/myspace/canvas/useBoard";
import { ObjectView } from "@/pages/myspace/canvas/ObjectView";
import { SelectionLayer, type HandleId } from "@/pages/myspace/canvas/SelectionLayer";
import { ToolDock, type Tool } from "@/pages/myspace/canvas/ToolDock";
import { TopBar, type BoardEntry } from "@/pages/myspace/canvas/TopBar";
import { Inspector, type InspectorActions } from "@/pages/myspace/canvas/Inspector";
import { LayersPanel } from "@/pages/myspace/canvas/Layers";
import { Minimap } from "@/pages/myspace/canvas/Minimap";
import { ContextMenu, type MenuItem } from "@/pages/myspace/canvas/ContextMenu";
import { TemplatesModal } from "@/pages/myspace/canvas/TemplatePicker";
import "@/styles/canvas.css";

/* ───────────── вспомогательное ───────────── */

const MIN_Z = 0.05;
const MAX_Z = 8;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const LS = {
  file: "holst.file",
  wheel: "holst.wheelZoom",
  grid: "holst.grid",
  snap: "holst.snap",
};
const lsGet = (k: string, d: string): string => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* без запоминания */
  }
};

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
};

/** Картинка → data URL, уменьшенная так, чтобы доска оставалась лёгкой. */
async function imageToData(file: Blob): Promise<{ src: string; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const max = 1600;
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(img, 0, 0, w, h);
    const keepAlpha = file.type === "image/png" || file.type === "image/webp";
    const src =
      keepAlpha && k === 1 && file.size < 400_000
        ? c.toDataURL("image/png")
        : c.toDataURL("image/webp", 0.88);
    return { src, w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Gesture =
  | { kind: "pan"; vx: number; vy: number; cx: number; cy: number }
  | {
      kind: "move";
      ids: Set<string>;
      start: Pt;
      moved: boolean;
      only: string | null;
      shift: boolean;
      cloned: boolean;
    }
  | { kind: "resize"; handle: HandleId; start: Pt; ids: string[] }
  | { kind: "rotate"; start: number; c: Pt; ids: string[]; base: number }
  | { kind: "marquee"; start: Pt; base: string[] }
  | { kind: "create"; tool: Tool; start: Pt; id: string | null; shift: boolean }
  | { kind: "pen"; pts: Pt[] }
  | { kind: "link"; id: string; end: "from" | "to"; start: Pt; moved: boolean }
  | null;

/* ───────────── страница ───────────── */

export default function CanvasPage() {
  const { lang } = useI18n();
  const ru = lang.toLowerCase().startsWith("ru");
  const t = useMemo(() => strings(lang), [lang]);

  const board = useBoard();
  const { objs } = board;
  const byId = useMemo(() => mapById(objs), [objs]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  const [sel, setSelState] = useState<string[]>([]);
  const selRef = useRef<string[]>([]);
  const setSel = useCallback((ids: string[]) => {
    selRef.current = ids;
    setSelState(ids);
  }, []);

  const [tool, setToolState] = useState<Tool>("select");
  const toolRef = useRef<Tool>("select");
  const setTool = useCallback((tl: Tool) => {
    toolRef.current = tl;
    setToolState(tl);
  }, []);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rounded");
  const [emoji, setEmoji] = useState("👍");
  const [penColor, setPenColor] = useState("#f59e0b");
  const [penWidth, setPenWidth] = useState(4);
  const [marker, setMarker] = useState(false);

  const [view, setViewState] = useState({ x: 0, y: 0, z: 1 });
  const viewRef = useRef(view);
  const setView = useCallback((v: { x: number; y: number; z: number }) => {
    viewRef.current = v;
    setViewState(v);
  }, []);
  const [size, setSize] = useState({ w: 800, h: 600 });

  const [editing, setEditing] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [penPts, setPenPts] = useState<Pt[] | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [rightTab, setRightTab] = useState<"props" | "layers">("props");
  const [dropping, setDropping] = useState(false);

  const [grid, setGrid] = useState(lsGet(LS.grid, "1") === "1");
  const [snap, setSnap] = useState(lsGet(LS.snap, "1") === "1");
  const [wheelZoom, setWheelZoom] = useState(lsGet(LS.wheel, "1") === "1");

  const [boards, setBoards] = useState<BoardEntry[]>([]);
  const [file, setFile] = useState("");
  const [name, setName] = useState("");
  const [save, setSave] = useState<"saved" | "saving" | "error">("saved");
  const [ready, setReady] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const gesture = useRef<Gesture>(null);
  const spaceHeld = useRef(false);
  const clip = useRef<string>("");
  const pasteN = useRef(0);
  const nameRef = useRef(name);
  nameRef.current = name;
  const fileRef = useRef(file);
  fileRef.current = file;
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const clientToWorld = useCallback((cx: number, cy: number): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z };
  }, []);

  /* размеры области */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /* ───────────── загрузка и сохранение ───────────── */

  const refreshBoards = useCallback(async () => {
    const list = (await api.myspaceListHolsts()) as { name: string; title?: string | null }[];
    const entries = list.map((h) => ({
      file: h.name,
      title: h.title || h.name.replace(/_/g, " "),
    }));
    setBoards(entries);
    return entries;
  }, []);

  const applyDoc = useCallback(
    (data: any, fileName: string) => {
      let list: Obj[] = [];
      let title = "";
      let vp: { x: number; y: number; zoom: number } | undefined;
      let g = true;
      if (data && data.version === 3 && Array.isArray(data.objs)) {
        list = data.objs as Obj[];
        title = data.name ?? "";
        vp = data.viewport;
        if (typeof data.grid === "boolean") g = data.grid;
      } else if (data && Array.isArray(data.nodes)) {
        list = fromFlow(data.nodes, data.edges ?? []);
        title = data.name ?? "";
        vp = data.viewport;
      }
      board.reset(list);
      setSel([]);
      setEditing(null);
      setName(title || fileName.replace(/_/g, " "));
      setFile(fileName);
      lsSet(LS.file, fileName);
      void g;
      if (vp && Number.isFinite(vp.zoom))
        setView({ x: vp.x, y: vp.y, z: clamp(vp.zoom, MIN_Z, MAX_Z) });
      else setView({ x: size.w / 2, y: size.h / 2, z: 1 });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board.reset, setSel, setView, size.w, size.h],
  );

  const loadBoard = useCallback(
    async (fileName: string) => {
      try {
        const res: any = await api.myspaceReadHolst(fileName);
        applyDoc(res?.data, fileName);
      } catch {
        applyDoc(null, fileName);
      }
    },
    [applyDoc],
  );

  const newFile = () => `board_${Date.now().toString(36)}`;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let list = await refreshBoards();
        if (!live) return;
        const stored = lsGet(LS.file, "");
        let pick = list.find((b) => b.file === stored)?.file ?? list[0]?.file;
        if (!pick) {
          pick = newFile();
          await api.myspaceWriteHolst(pick, {
            version: 3,
            name: ru ? "Моя доска" : "My board",
            objs: [],
          });
          list = await refreshBoards();
        }
        if (live) await loadBoard(pick);
      } catch {
        if (live) applyDoc(null, newFile());
      }
      if (live) setReady(true);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const flush = useCallback(async () => {
    if (!dirty.current || !fileRef.current) return;
    dirty.current = false;
    setSave("saving");
    const doc: HolstDoc = {
      version: 3,
      name: nameRef.current,
      objs: board.ref.current,
      viewport: { x: viewRef.current.x, y: viewRef.current.y, zoom: viewRef.current.z },
      updatedAt: new Date().toISOString(),
    };
    try {
      await api.myspaceWriteHolst(fileRef.current, doc);
      setSave(dirty.current ? "saving" : "saved");
    } catch {
      dirty.current = true;
      setSave("error");
    }
  }, [board.ref]);

  const touch = useCallback(() => {
    dirty.current = true;
    setSave("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flush(), 1200);
  }, [flush]);

  const first = useRef(true);
  useEffect(() => {
    if (!ready) return;
    if (first.current) {
      first.current = false;
      return;
    }
    touch();
  }, [objs, name, ready, touch]);

  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      void flush();
    };
  }, [flush]);

  const openBoard = async (f: string) => {
    if (f === file) return;
    await flush();
    await loadBoard(f);
  };
  const createBoard = async () => {
    await flush();
    const f = newFile();
    const title = ru ? `Доска ${boards.length + 1}` : `Board ${boards.length + 1}`;
    await api.myspaceWriteHolst(f, { version: 3, name: title, objs: [] });
    await refreshBoards();
    await loadBoard(f);
  };
  const removeBoard = async (f: string) => {
    if (!window.confirm(t("delBoard"))) return;
    await api.myspaceDeleteHolst(f);
    const list = await refreshBoards();
    if (f === file) {
      dirty.current = false;
      await loadBoard(list[0]?.file ?? newFile());
    }
  };

  /* ───────────── правки ───────────── */

  const onPatch = useCallback(
    (id: string, patch: Partial<Obj>, history = true) => {
      const fn = (o: Obj[]) => o.map((x) => (x.id === id ? { ...x, ...patch } : x));
      if (history) board.apply(fn);
      else board.silent(fn);
    },
    [board],
  );
  const onMeasure = useCallback(
    (id: string, h: number) => board.silent((o) => o.map((x) => (x.id === id ? { ...x, h } : x))),
    [board],
  );
  const onCommit = useCallback(
    (id: string, text: string, cancel?: boolean) => {
      setEditing(null);
      const cur = byIdRef.current.get(id);
      if (!cur) return;
      if (cancel) {
        if (cur.type === "text" && !(cur.text ?? "").trim())
          board.apply((o) => deleteObjs(o, [id]));
        return;
      }
      if (cur.type === "frame") {
        board.apply((o) => o.map((x) => (x.id === id ? { ...x, name: text.trim() || x.name } : x)));
        return;
      }
      if (cur.type === "text" && !text.trim()) {
        board.apply((o) => deleteObjs(o, [id]));
        setSel(selRef.current.filter((s) => s !== id));
        return;
      }
      if ((cur.text ?? "") === text) return;
      board.apply((o) => o.map((x) => (x.id === id ? { ...x, text } : x)));
    },
    [board, setSel],
  );

  const selObjs = useMemo(
    () => sel.map((id) => byId.get(id)).filter((o): o is Obj => !!o),
    [sel, byId],
  );

  /** идентификаторы, к которым относится изменение оформления: группа распространяется на детей */
  const styleTargets = (ids: string[]): Set<string> => {
    const out = new Set<string>(ids);
    for (const id of ids) {
      const o = byIdRef.current.get(id);
      if (o?.type === "group") for (const d of withChildren(board.ref.current, [id])) out.add(d);
    }
    return out;
  };

  const actions: InspectorActions = {
    patch: (patch, key) => {
      const set = styleTargets(selRef.current);
      board.apply(
        (o) => o.map((x) => (set.has(x.id) && x.type !== "group" ? { ...x, ...patch } : x)),
        key ? `p:${key}` : undefined,
      );
    },
    patchGeom: (patch) => {
      const id = selRef.current[0];
      if (!id) return;
      board.apply((o) => {
        const cur = o.find((x) => x.id === id);
        if (!cur) return o;
        let next = o.map((x) => (x.id === id ? { ...x, ...patch } : x));
        const dx = (patch.x ?? cur.x) - cur.x;
        const dy = (patch.y ?? cur.y) - cur.y;
        if (dx || dy) {
          const kids = withChildren(o, [id]);
          kids.delete(id);
          next = moveObjs(next, kids, dx, dy);
        }
        return fitGroups(next);
      }, "geom");
    },
    align: (k: AlignKind) => {
      const ids = selRef.current;
      board.apply((o) => {
        const map = mapById(o);
        const boxes = new Map<string, Box>();
        for (const id of ids) {
          const ob = map.get(id);
          if (ob && ob.type !== "line") boxes.set(id, boundsOf(ob, map));
        }
        const d = alignDeltas(boxes, k);
        let next = o;
        for (const [id, p] of d) next = moveObjs(next, withChildren(next, [id]), p.x, p.y);
        return fitGroups(next);
      });
    },
    distribute: (axis) => {
      const ids = selRef.current;
      board.apply((o) => {
        const map = mapById(o);
        const boxes = new Map<string, Box>();
        for (const id of ids) {
          const ob = map.get(id);
          if (ob && ob.type !== "line") boxes.set(id, boundsOf(ob, map));
        }
        const d = distributeDeltas(boxes, axis);
        let next = o;
        for (const [id, p] of d) next = moveObjs(next, withChildren(next, [id]), p.x, p.y);
        return fitGroups(next);
      });
    },
    group: () => {
      const r = groupObjs(board.ref.current, selRef.current);
      if (!r) return;
      board.apply(() => r.objs);
      setSel([r.id]);
    },
    ungroup: () => {
      const r = ungroupObjs(board.ref.current, selRef.current);
      if (r.freed.length === 0) return;
      board.apply(() => r.objs);
      setSel(r.freed);
    },
    order: (how: Order) => board.apply((o) => reorder(o, selRef.current, how)),
    lock: () => {
      const ids = new Set(selRef.current);
      const all = selRef.current.every((id) => byIdRef.current.get(id)?.locked);
      board.apply((o) => o.map((x) => (ids.has(x.id) ? { ...x, locked: !all } : x)));
    },
    hide: () => {
      const ids = new Set(selRef.current);
      const all = selRef.current.every((id) => byIdRef.current.get(id)?.hidden);
      board.apply((o) => o.map((x) => (ids.has(x.id) ? { ...x, hidden: !all } : x)));
      if (!all) setSel([]);
    },
    duplicate: () => duplicate(),
    remove: () => removeSel(),
  };

  function removeSel() {
    const ids = selRef.current.filter((id) => !byIdRef.current.get(id)?.locked);
    if (ids.length === 0) return;
    board.apply((o) => deleteObjs(o, ids));
    setSel([]);
    setEditing(null);
  }

  function duplicate(dx = 24, dy = 24) {
    const ids = selRef.current;
    if (ids.length === 0) return;
    const { copies, roots } = cloneObjs(board.ref.current, ids, dx, dy);
    board.apply((o) => [...o, ...copies]);
    setSel(roots);
  }

  /* буфер обмена */
  function copySel(cut = false) {
    const ids = selRef.current;
    if (ids.length === 0) return;
    const all = withChildren(board.ref.current, ids);
    const items = board.ref.current.filter((o) => all.has(o.id));
    const payload = `holst:v3:${JSON.stringify({ ids, items })}`;
    clip.current = payload;
    pasteN.current = 0;
    void navigator.clipboard?.writeText(payload).catch(() => undefined);
    if (cut) removeSel();
  }
  function pasteInternal(text: string, at?: Pt) {
    try {
      const { ids, items } = JSON.parse(text.slice("holst:v3:".length)) as {
        ids: string[];
        items: Obj[];
      };
      const tmp = [...board.ref.current.filter((o) => !items.some((i) => i.id === o.id)), ...items];
      pasteN.current += 1;
      const step = 24 * pasteN.current;
      const box = selectionBox(tmp, ids);
      let dx = step;
      let dy = step;
      if (at && box) {
        dx = at.x - (box.x + box.w / 2);
        dy = at.y - (box.y + box.h / 2);
      }
      const { copies, roots } = cloneObjs(tmp, ids, dx, dy);
      board.apply((o) => [...o, ...copies]);
      setSel(roots);
    } catch {
      /* чужой текст */
    }
  }

  /* ───────────── вид ───────────── */

  const zoomAt = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      const v = viewRef.current;
      const z = clamp(v.z * factor, MIN_Z, MAX_Z);
      const px = cx ?? size.w / 2;
      const py = cy ?? size.h / 2;
      const k = z / v.z;
      setView({ z, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
    },
    [setView, size.w, size.h],
  );
  const setZoom = (z: number) => {
    const v = viewRef.current;
    const nz = clamp(z, MIN_Z, MAX_Z);
    const k = nz / v.z;
    setView({
      z: nz,
      x: size.w / 2 - (size.w / 2 - v.x) * k,
      y: size.h / 2 - (size.h / 2 - v.y) * k,
    });
  };
  const fitBox = useCallback(
    (box: Box | null, max = 1.6) => {
      if (!box || box.w <= 0 || box.h <= 0) {
        setView({ x: size.w / 2, y: size.h / 2, z: 1 });
        return;
      }
      const pad = 90;
      const z = clamp(
        Math.min((size.w - pad * 2) / box.w, (size.h - pad * 2) / box.h, max),
        MIN_Z,
        MAX_Z,
      );
      setView({
        z,
        x: size.w / 2 - (box.x + box.w / 2) * z,
        y: size.h / 2 - (box.y + box.h / 2) * z,
      });
    },
    [setView, size.w, size.h],
  );
  const fitAll = () => {
    const vis = board.ref.current.filter((o) => !o.hidden);
    const m = mapById(board.ref.current);
    fitBox(unionBox(vis.map((o) => boundsOf(o, m))));
  };
  const fitSelection = () => fitBox(selectionBox(board.ref.current, selRef.current));

  /* колесо мыши */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.("[data-ui]")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const zoom = e.ctrlKey || e.metaKey || (wheelZoomRef.current && !e.shiftKey);
      if (zoom) {
        const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
        zoomAt(k, cx, cy);
      } else {
        const v = viewRef.current;
        setView({
          ...v,
          x: v.x - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX),
          y: v.y - (e.shiftKey ? 0 : e.deltaY),
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, setView]);
  const wheelZoomRef = useRef(wheelZoom);
  wheelZoomRef.current = wheelZoom;

  /* ───────────── создание объектов ───────────── */

  const addObjs = (list: Obj[], select = true) => {
    board.apply((o) =>
      reparent(
        [...o, ...list],
        list.map((l) => l.id),
      ),
    );
    if (select) setSel(list.map((l) => l.id));
  };

  const viewCenter = (): Pt => clientCenter();
  function clientCenter(): Pt {
    const v = viewRef.current;
    return { x: (size.w / 2 - v.x) / v.z, y: (size.h / 2 - v.y) / v.z };
  }

  const addImageBlob = async (blob: Blob, at: Pt) => {
    try {
      const { src, w, h } = await imageToData(blob);
      const k = Math.min(1, 480 / w);
      const ob = make("image", at, { src, w: Math.round(w * k), h: Math.round(h * k) });
      addObjs([ob]);
      /* картинка весит много, а обновление страницы отменяет отложенную запись: сохраняем сразу */
      dirty.current = true;
      void flush();
    } catch {
      /* не картинка */
    }
  };

  const addNote = (path: string, at: Pt) => {
    const ob = make("note", at, { path, text: path.split("/").pop() || path });
    addObjs([ob]);
  };

  const applyTemplate = (id: string) => {
    const tpl = TEMPLATES.find((x) => x.id === id);
    if (!tpl) return;
    const c = clientCenter();
    const { nodes, edges } = tpl.gen(c.x - 300, c.y - 200);
    const list = fromFlow(nodes, edges);
    board.apply((o) => [...o, ...list]);
    setSel([]);
    const m = mapById(list);
    window.setTimeout(() => fitBox(unionBox(list.map((x) => boundsOf(x, m)))), 30);
  };

  const tidy = () => {
    const all = board.ref.current;
    const lines = all.filter((o) => o.type === "line" && o.from?.id && o.to?.id);
    if (lines.length === 0) return;
    const ids = selRef.current.length > 1 ? new Set(withChildren(all, selRef.current)) : null;
    const nodes = all.filter(
      (o) =>
        o.type !== "line" &&
        o.type !== "group" &&
        o.type !== "frame" &&
        !o.parent &&
        (!ids || ids.has(o.id)),
    );
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 50, ranksep: 90 });
    g.setDefaultEdgeLabel(() => ({}));
    nodes.forEach((n) => g.setNode(n.id, { width: n.w, height: n.h }));
    lines.forEach((l) => {
      if (g.hasNode(l.from!.id!) && g.hasNode(l.to!.id!)) g.setEdge(l.from!.id!, l.to!.id!);
    });
    dagre.layout(g);
    const box = unionBox(nodes.map((n) => n));
    board.apply((o) =>
      o.map((x) => {
        const p = g.node(x.id);
        if (!p) return x;
        return {
          ...x,
          x: Math.round(p.x - x.w / 2 + (box?.x ?? 0)),
          y: Math.round(p.y - x.h / 2 + (box?.y ?? 0)),
        };
      }),
    );
    window.setTimeout(fitAll, 40);
  };

  /* ───────────── жесты ───────────── */

  const hitId = (target: EventTarget | null): string | null =>
    (target as Element | null)?.closest?.("[data-oid]")?.getAttribute("data-oid") ?? null;

  /** Что под курсором на самом деле: после жеста с захватом указателя e.target — это сама сцена. */
  const under = (e: {
    clientX: number;
    clientY: number;
    target: EventTarget | null;
  }): HTMLElement =>
    (document.elementFromPoint?.(e.clientX, e.clientY) as HTMLElement | null) ??
    (e.target as HTMLElement);

  /** какой объект (не соединитель) под курсором; нужен, чтобы привязывать концы линий */
  const objectUnder = (cx: number, cy: number, skip: string): string | null => {
    for (const el of document.elementsFromPoint(cx, cy)) {
      const id = (el as Element).closest?.("[data-oid]")?.getAttribute("data-oid");
      if (!id || id === skip) continue;
      const o = byIdRef.current.get(id);
      if (o && o.type !== "line" && o.type !== "group" && !o.hidden) return id;
    }
    return null;
  };

  const resolveSelect = (id: string): string => {
    const g = topGroupOf(board.ref.current, id);
    if (g === id) return id;
    const entered = selRef.current.some(
      (s) => s !== g && s !== id && topGroupOf(board.ref.current, s) === g,
    );
    const selIsChild = selRef.current.includes(id);
    return entered || selIsChild ? id : g;
  };

  const startLink = (
    e: React.PointerEvent,
    mode: { create: Anchor0 } | { edit: string; end: "from" | "to" },
  ) => {
    const start = clientToWorld(e.clientX, e.clientY);
    board.begin();
    let id: string;
    let end: "from" | "to";
    if ("create" in mode) {
      const l = make("line", start, {
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        from: mode.create,
        to: { x: start.x, y: start.y },
      });
      id = l.id;
      end = "to";
      board.live((base) => [...base, l]);
      board.rebase();
    } else {
      id = mode.edit;
      end = mode.end;
    }
    gesture.current = { kind: "link", id, end, start, moved: false };
    setSel([id]);
  };

  type Anchor0 = { id?: string; side?: "t" | "r" | "b" | "l" | "auto"; x?: number; y?: number };

  const capture = (id: number) => {
    try {
      wrapRef.current?.setPointerCapture?.(id);
    } catch {
      /* без захвата указателя */
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-ui]") && !target.closest("[data-handle]")) return;
    if (target.closest("[data-nodrag]")) return;
    if (ctx) setCtx(null);
    const pt = clientToWorld(e.clientX, e.clientY);
    const tl = toolRef.current;

    /* пан: средняя кнопка, рука или зажатый пробел */
    if (e.button === 1 || tl === "hand" || (spaceHeld.current && e.button === 0)) {
      e.preventDefault();
      gesture.current = {
        kind: "pan",
        vx: viewRef.current.x,
        vy: viewRef.current.y,
        cx: e.clientX,
        cy: e.clientY,
      };
      capture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    if (editing) {
      // клик мимо поля ввода завершает правку (blur сам сохранит текст)
      (document.activeElement as HTMLElement | null)?.blur?.();
    }

    /* ручки выделения */
    const handle = target.closest("[data-handle]")?.getAttribute("data-handle");
    if (handle) {
      e.preventDefault();
      capture(e.pointerId);
      if (handle === "rot") {
        const ids = selRef.current;
        const box = selectionBox(board.ref.current, ids)!;
        const single = ids.length === 1 ? byIdRef.current.get(ids[0]) : null;
        const c = single ? center(single) : { x: box.x + box.w / 2, y: box.y + box.h / 2 };
        board.begin();
        gesture.current = {
          kind: "rotate",
          c,
          ids,
          start: Math.atan2(pt.y - c.y, pt.x - c.x),
          base: single?.rot ?? 0,
        };
      } else if (handle === "la" || handle === "lb") {
        startLink(e, { edit: selRef.current[0], end: handle === "la" ? "from" : "to" });
      } else if (handle.startsWith("port-")) {
        const of = (target.closest("[data-port-of]") as HTMLElement).dataset.portOf!;
        const side = handle.slice(5) as "t" | "r" | "b" | "l";
        startLink(e, { create: { id: of, side } });
      } else {
        board.begin();
        gesture.current = {
          kind: "resize",
          handle: handle as HandleId,
          start: pt,
          ids: selRef.current,
        };
      }
      return;
    }

    /* создание */
    if (tl === "line") {
      e.preventDefault();
      capture(e.pointerId);
      const under = objectUnder(e.clientX, e.clientY, "");
      startLink(e, { create: under ? { id: under, side: "auto" } : { x: pt.x, y: pt.y } });
      return;
    }
    if (tl === "pen") {
      e.preventDefault();
      capture(e.pointerId);
      gesture.current = { kind: "pen", pts: [pt] };
      setPenPts([pt]);
      setSel([]);
      return;
    }
    if (tl !== "select") {
      e.preventDefault();
      capture(e.pointerId);
      gesture.current = { kind: "create", tool: tl, start: pt, id: null, shift: e.shiftKey };
      board.begin();
      return;
    }

    /* выбор и перенос */
    const id = hitId(target);
    if (id) {
      const obj = byIdRef.current.get(id);
      if (!obj) return;
      const rid = resolveSelect(id);
      e.preventDefault();
      capture(e.pointerId);
      let ids = selRef.current;
      if (e.shiftKey) {
        ids = ids.includes(rid) ? ids.filter((s) => s !== rid) : [...ids, rid];
        setSel(ids);
        if (!ids.includes(rid)) return;
      } else if (!ids.includes(rid)) {
        ids = [rid];
        setSel(ids);
      }
      const movable = ids.filter((s) => !byIdRef.current.get(s)?.locked);
      if (movable.length === 0) return;
      board.begin();
      gesture.current = {
        kind: "move",
        ids: withChildren(board.ref.current, movable),
        start: pt,
        moved: false,
        only: !e.shiftKey && ids.length > 1 ? rid : null,
        shift: e.shiftKey,
        cloned: false,
      };
      if (e.altKey) {
        const { copies, roots } = cloneObjs(board.ref.current, movable, 0, 0);
        board.live((base) => [...base, ...copies]);
        board.rebase();
        setSel(roots);
        gesture.current = {
          kind: "move",
          ids: withChildren([...board.ref.current], roots),
          start: pt,
          moved: false,
          only: null,
          shift: false,
          cloned: true,
        };
      }
      return;
    }

    /* пустое место: рамка выбора */
    e.preventDefault();
    capture(e.pointerId);
    const base = e.shiftKey ? selRef.current : [];
    if (!e.shiftKey) setSel([]);
    gesture.current = { kind: "marquee", start: pt, base };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) {
      if (toolRef.current === "select" || toolRef.current === "line") {
        const id = hitId(e.target);
        setHover((h) => (h === id ? h : id));
      }
      return;
    }
    const pt = clientToWorld(e.clientX, e.clientY);
    const z = viewRef.current.z;

    switch (g.kind) {
      case "pan": {
        setView({ ...viewRef.current, x: g.vx + (e.clientX - g.cx), y: g.vy + (e.clientY - g.cy) });
        break;
      }
      case "move": {
        let dx = pt.x - g.start.x;
        let dy = pt.y - g.start.y;
        if (!g.moved) {
          if (Math.hypot(dx, dy) * z < 3) return;
          g.moved = true;
        }
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const baseObjs = board.ref.current;
        void baseObjs;
        board.live((base) => {
          const map = mapById(base);
          const mine = [...g.ids]
            .map((id) => map.get(id))
            .filter((o): o is Obj => !!o && o.type !== "line" && !o.parent);
          const roots = [...g.ids]
            .map((id) => map.get(id))
            .filter(
              (o): o is Obj => !!o && o.type !== "line" && (!o.parent || !g.ids.has(o.parent)),
            );
          const bb = unionBox((roots.length ? roots : mine).map((o) => boundsOf(o, map)));
          let gl: Guide[] = [];
          if (bb && snapRef.current && !e.ctrlKey && !e.metaKey) {
            const moving = { ...bb, x: bb.x + dx, y: bb.y + dy };
            const others = base
              .filter(
                (o) => !g.ids.has(o.id) && !o.hidden && o.type !== "line" && o.type !== "group",
              )
              .map((o) => boundsOf(o, map))
              .filter((b) =>
                boxesTouch(b, {
                  x: moving.x - 400,
                  y: moving.y - 400,
                  w: moving.w + 800,
                  h: moving.h + 800,
                }),
              );
            const s = snapMove(moving, others, 6 / z);
            dx += s.dx;
            dy += s.dy;
            gl = s.guides;
          }
          setGuides(gl);
          return fitGroups(moveObjs(base, g.ids, dx, dy));
        });
        break;
      }
      case "resize": {
        resize(g, pt, e);
        break;
      }
      case "rotate": {
        let delta = ((Math.atan2(pt.y - g.c.y, pt.x - g.c.x) - g.start) * 180) / Math.PI;
        if (g.ids.length === 1 && e.shiftKey)
          delta = Math.round((g.base + delta) / 15) * 15 - g.base;
        else if (e.shiftKey) delta = Math.round(delta / 15) * 15;
        board.live((base) => rotateAround(base, new Set(g.ids), g.c, delta));
        break;
      }
      case "marquee": {
        const box: Box = {
          x: Math.min(g.start.x, pt.x),
          y: Math.min(g.start.y, pt.y),
          w: Math.abs(pt.x - g.start.x),
          h: Math.abs(pt.y - g.start.y),
        };
        setMarquee(box);
        const map = byIdRef.current;
        const hit: string[] = [];
        for (const o of board.ref.current) {
          if (o.hidden || o.locked) continue;
          if (o.parent && map.get(o.parent)?.type === "group") continue;
          const b = boundsOf(o, map);
          if (o.type === "frame") {
            if (
              b.x >= box.x &&
              b.y >= box.y &&
              b.x + b.w <= box.x + box.w &&
              b.y + b.h <= box.y + box.h
            )
              hit.push(o.id);
          } else if (boxesTouch(b, box)) hit.push(o.id);
        }
        setSel([...new Set([...g.base, ...hit])]);
        break;
      }
      case "create": {
        const dx = pt.x - g.start.x;
        const dy = pt.y - g.start.y;
        if (!g.id) {
          if (Math.hypot(dx, dy) * z < 5) return;
          const ob = newByTool(g.tool, g.start);
          if (!ob) return;
          g.id = ob.id;
          board.live((base) => [...base, ob]);
          board.rebase();
        }
        const id = g.id!;
        let w = Math.abs(dx);
        let h = Math.abs(dy);
        if (g.shift || g.tool === "sticky") {
          const m = Math.max(w, h);
          w = m;
          h = m;
        }
        const x = dx < 0 ? g.start.x - w : g.start.x;
        const y = dy < 0 ? g.start.y - h : g.start.y;
        board.live((base) =>
          base.map((o) =>
            o.id === id
              ? { ...o, x, y, w: Math.max(8, w), h: g.tool === "text" ? o.h : Math.max(8, h) }
              : o,
          ),
        );
        break;
      }
      case "pen": {
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) * z < 2) return;
        g.pts.push(pt);
        setPenPts([...g.pts]);
        break;
      }
      case "link": {
        if (!g.moved && Math.hypot(pt.x - g.start.x, pt.y - g.start.y) * z < 4) return;
        g.moved = true;
        const under = objectUnder(e.clientX, e.clientY, g.id);
        setHover(under);
        board.live((base) =>
          base.map((o) => {
            if (o.id !== g.id) return o;
            const anchor = under ? { id: under, side: "auto" as const } : { x: pt.x, y: pt.y };
            return g.end === "to" ? { ...o, to: anchor } : { ...o, from: anchor };
          }),
        );
        break;
      }
    }
  };

  const newByTool = (tl: Tool, at: Pt): Obj | null => {
    switch (tl) {
      case "sticky":
        return make("sticky", at, { x: at.x, y: at.y, w: 8, h: 8 });
      case "text":
        return make("text", at, { x: at.x, y: at.y, w: 8, auto: false });
      case "shape":
        return make("shape", at, { x: at.x, y: at.y, w: 8, h: 8, shape: shapeKind });
      case "frame":
        return make("frame", at, { x: at.x, y: at.y, w: 8, h: 8 });
      case "task":
        return make("task", at, { x: at.x, y: at.y, w: 8, h: 8 });
      case "sticker":
        return make("sticker", at, { x: at.x, y: at.y, w: 8, h: 8, emoji });
      default:
        return null;
    }
  };

  const resize = (g: Extract<Gesture, { kind: "resize" }>, pt: Pt, e: React.PointerEvent) => {
    const hx = g.handle.includes("e") ? 1 : g.handle.includes("w") ? -1 : 0;
    const hy = g.handle.includes("s") ? 1 : g.handle.includes("n") ? -1 : 0;
    const single = g.ids.length === 1 ? byIdRef.current.get(g.ids[0]) : null;
    const dxw = pt.x - g.start.x;
    const dyw = pt.y - g.start.y;
    if (single && single.type !== "group" && single.type !== "line") {
      board.live((base) => {
        const o0 = base.find((x) => x.id === single.id);
        if (!o0) return base;
        const ld = rotatePt({ x: dxw, y: dyw }, { x: 0, y: 0 }, -o0.rot);
        let dw = hx * ld.x;
        let dh = hy * ld.y;
        const keep =
          (e.shiftKey
            ? !(o0.type === "image" || o0.type === "sticker")
            : o0.type === "image" || o0.type === "sticker") &&
          hx !== 0 &&
          hy !== 0;
        if (keep) {
          const s = Math.max((o0.w + dw) / o0.w, (o0.h + dh) / o0.h);
          dw = (s - 1) * o0.w;
          dh = (s - 1) * o0.h;
        }
        if (e.altKey) {
          dw *= 2;
          dh *= 2;
        }
        const w = Math.max(8, o0.w + dw);
        const h = Math.max(8, o0.h + dh);
        const adw = w - o0.w;
        const adh = h - o0.h;
        const c0 = center(o0);
        const shift = e.altKey
          ? { x: 0, y: 0 }
          : rotatePt({ x: (hx * adw) / 2, y: (hy * adh) / 2 }, { x: 0, y: 0 }, o0.rot);
        const nc = { x: c0.x + shift.x, y: c0.y + shift.y };
        return base.map((o) =>
          o.id === o0.id
            ? {
                ...o,
                w: hx === 0 ? o0.w : w,
                h: hy === 0 ? o0.h : h,
                x: nc.x - (hx === 0 ? o0.w : w) / 2,
                y: nc.y - (hy === 0 ? o0.h : h) / 2,
                auto: hy !== 0 ? false : o0.auto,
              }
            : o,
        );
      });
      return;
    }
    /* несколько объектов или группа: масштаб относительно противоположного угла габарита */
    board.live((base) => {
      const set = withChildren(base, g.ids);
      const bb = unionBox(
        g.ids
          .map((id) => base.find((x) => x.id === id))
          .filter((x): x is Obj => !!x)
          .map((x) => boundsOf(x, mapById(base))),
      );
      if (!bb) return base;
      const ax = hx > 0 ? bb.x : hx < 0 ? bb.x + bb.w : bb.x;
      const ay = hy > 0 ? bb.y : hy < 0 ? bb.y + bb.h : bb.y;
      let sx = hx === 0 ? 1 : Math.max(0.05, (bb.w + hx * dxw) / bb.w);
      let sy = hy === 0 ? 1 : Math.max(0.05, (bb.h + hy * dyw) / bb.h);
      if (e.shiftKey && hx !== 0 && hy !== 0) {
        const s = Math.max(sx, sy);
        sx = s;
        sy = s;
      }
      return fitGroups(
        base.map((o) => {
          if (!set.has(o.id) || o.type === "line") return o;
          return {
            ...o,
            x: ax + (o.x - ax) * sx,
            y: ay + (o.y - ay) * sy,
            w: Math.max(4, o.w * sx),
            h: Math.max(4, o.h * sy),
            auto: false,
          };
        }),
      );
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    try {
      wrapRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* уже освобождён */
    }
    setGuides([]);
    setMarquee(null);
    if (!g) return;
    const pt = clientToWorld(e.clientX, e.clientY);

    switch (g.kind) {
      case "move": {
        if (!g.moved) {
          board.cancel();
          if (g.only) setSel([g.only]);
          break;
        }
        board.silent((cur) => reparent(fitGroups(cur), selRef.current));
        board.commit();
        break;
      }
      case "resize":
      case "rotate":
        board.commit();
        break;
      case "create": {
        let id = g.id;
        if (!id) {
          const ob = newByTool(g.tool, pt);
          if (!ob) {
            board.cancel();
            break;
          }
          const s = ob.type === "sticker" ? { w: 56, h: 56 } : { w: ob.w, h: ob.h };
          const def = make(
            ob.type,
            pt,
            ob.type === "shape" ? { shape: shapeKind } : ob.type === "sticker" ? { emoji } : {},
          );
          void s;
          id = def.id;
          board.silent((base) => [...base, def]);
        } else {
          const cur = board.ref.current.find((o) => o.id === id);
          // слишком маленький объект получает размер по умолчанию
          if (cur && cur.w < 24 && cur.h < 24 && g.tool !== "text") {
            const d = make(
              cur.type,
              { x: cur.x, y: cur.y },
              cur.type === "shape" ? { shape: shapeKind } : cur.type === "sticker" ? { emoji } : {},
            );
            board.silent((base) => base.map((o) => (o.id === id ? { ...d, id: id! } : o)));
          } else if (cur && g.tool === "text") {
            board.silent((base) =>
              base.map((o) => (o.id === id ? { ...o, w: Math.max(60, o.w), auto: true } : o)),
            );
          }
        }
        board.silent((base) => reparent(base, [id!]));
        // рамка ложится под остальное, чтобы не закрывать уже лежащие объекты
        if (g.tool === "frame") board.silent((base) => reorder(base, [id!], "back"));
        board.commit();
        setSel([id!]);
        const created = board.ref.current.find((o) => o.id === id);
        if (created && ["sticky", "text", "shape", "task"].includes(created.type)) setEditing(id);
        if (!g.shift) setTool("select");
        break;
      }
      case "pen": {
        setPenPts(null);
        if (g.pts.length < 2) break;
        const xs = g.pts.map((p) => p.x);
        const ys = g.pts.map((p) => p.y);
        const pad = penWidth * (marker ? 1.5 : 1);
        const x = Math.min(...xs) - pad;
        const y = Math.min(...ys) - pad;
        const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
        const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
        const ob = make(
          "stroke",
          { x: 0, y: 0 },
          {
            x,
            y,
            w,
            h,
            bw: w,
            bh: h,
            pts: g.pts.map(
              (p) =>
                [Math.round((p.x - x) * 10) / 10, Math.round((p.y - y) * 10) / 10] as [
                  number,
                  number,
                ],
            ),
            stroke: penColor,
            sw: marker ? penWidth * 3 : penWidth,
            opacity: marker ? 0.45 : 1,
          },
        );
        board.apply((o) => [...o, ob]);
        break;
      }
      case "link": {
        const line = board.ref.current.find((o) => o.id === g.id);
        if (!g.moved && line && g.end === "to" && !line.to?.id && line.from?.id) {
          // без движения соединитель не создаётся
          board.cancel();
          setSel([]);
          break;
        }
        board.commit();
        setHover(null);
        if (toolRef.current === "line" && !e.shiftKey) setTool("select");
        break;
      }
      case "marquee":
      case "pan":
        break;
    }
  };

  /* двойной щелчок: правка текста / вход в группу / новый текст */
  const onDoubleClick = (e: React.MouseEvent) => {
    const target = under(e);
    if (target.closest("[data-ui]") || target.closest("[data-nodrag]")) return;
    const id = hitId(target);
    const pt = clientToWorld(e.clientX, e.clientY);
    if (id) {
      const o = byIdRef.current.get(id);
      if (!o) return;
      if (o.type === "group" || (o.parent && byIdRef.current.get(o.parent)?.type === "group")) {
        // войти в группу: выбрать то, что под курсором
        const kids = board.ref.current.filter(
          (k) =>
            k.parent &&
            topGroupOf(board.ref.current, k.id) === topGroupOf(board.ref.current, id) &&
            k.type !== "group",
        );
        const hit = [...kids].reverse().find((k) => {
          const b = boundsOf(k, byIdRef.current);
          return pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h;
        });
        if (hit) {
          setSel([hit.id]);
          if (["text", "sticky", "shape"].includes(hit.type)) setEditing(hit.id);
        }
        return;
      }
      if (o.locked) return;
      if (["shape", "sticky", "text", "task"].includes(o.type) || o.type === "frame") {
        setSel([id]);
        setEditing(id);
      } else if (o.type === "line") {
        setSel([id]);
        if (!o.text) board.apply((all) => all.map((x) => (x.id === id ? { ...x, text: "…" } : x)));
        setEditing(id);
      } else if (o.type === "image") {
        setSel([id]);
      }
      return;
    }
    if (toolRef.current !== "select") return;
    const ob = make("text", pt, { x: pt.x, y: pt.y, w: 240, auto: true });
    addObjs([ob]);
    setEditing(ob.id);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const target = under(e);
    if (target.closest("[data-ui]")) return;
    e.preventDefault();
    const id = hitId(target);
    if (id) {
      const rid = resolveSelect(id);
      if (!selRef.current.includes(rid)) setSel([rid]);
    } else {
      /* пустое место внутри рамки выделения не снимает выбор: можно выделить всё и удалить правой кнопкой */
      const wp = clientToWorld(e.clientX, e.clientY);
      const inside = selRef.current.some((s) => {
        const o = byIdRef.current.get(s);
        if (!o) return false;
        const b = boundsOf(o, byIdRef.current);
        return wp.x >= b.x && wp.x <= b.x + b.w && wp.y >= b.y && wp.y <= b.y + b.h;
      });
      if (!inside) setSel([]);
    }
    const has = selRef.current.length > 0;
    const pt = clientToWorld(e.clientX, e.clientY);
    const only = selRef.current.length === 1 ? byIdRef.current.get(selRef.current[0]) : undefined;
    const canText =
      !!only && !only.locked && ["shape", "sticky", "text", "task", "frame"].includes(only.type);
    const canFill = selRef.current.some((s) => {
      const o = byIdRef.current.get(s);
      return !!o && ["shape", "sticky", "task", "frame", "text"].includes(o.type);
    });
    const multi = selRef.current.length > 1;
    const anyGroup = selRef.current.some((s) => byIdRef.current.get(s)?.type === "group");
    const items: MenuItem[] = has
      ? [
          ...(canText
            ? [{ label: t("edit"), hint: "Enter", onClick: () => setEditing(only!.id) }]
            : []),
          ...(canFill
            ? [
                {
                  label: "",
                  onClick: () => undefined,
                  swatches: {
                    colors: [
                      "#ffffff",
                      "#fef08a",
                      "#bbf7d0",
                      "#bfdbfe",
                      "#fbcfe8",
                      "#fed7aa",
                      "#ddd6fe",
                      "#e5e7eb",
                      "#1f2937",
                    ],
                    onPick: (c: string) => actions.patch({ fill: c }, "fill"),
                  },
                },
                { sep: true, label: "", onClick: () => undefined },
              ]
            : []),
          { label: t("cut"), hint: "Ctrl+X", onClick: () => copySel(true) },
          { label: t("copy"), hint: "Ctrl+C", onClick: () => copySel() },
          {
            label: t("paste"),
            hint: "Ctrl+V",
            onClick: () => clip.current && pasteInternal(clip.current, pt),
            disabled: !clip.current,
          },
          { label: t("duplicate"), hint: "Ctrl+D", onClick: () => duplicate() },
          { sep: true, label: "", onClick: () => undefined },
          ...(multi ? [{ label: t("group"), hint: "Ctrl+G", onClick: actions.group }] : []),
          ...(anyGroup ? [{ label: t("ungroup"), hint: "Ctrl+⇧G", onClick: actions.ungroup }] : []),
          { label: t("front"), hint: "Ctrl+⇧]", onClick: () => actions.order("front") },
          { label: t("back"), hint: "Ctrl+⇧[", onClick: () => actions.order("back") },
          { label: t("lock"), hint: "Ctrl+⇧L", onClick: actions.lock },
          { label: t("hide"), onClick: actions.hide },
          { sep: true, label: "", onClick: () => undefined },
          { label: t("del"), hint: "Del", danger: true, onClick: removeSel },
        ]
      : [
          {
            label: t("paste"),
            hint: "Ctrl+V",
            onClick: () => clip.current && pasteInternal(clip.current, pt),
            disabled: !clip.current,
          },
          {
            label: t("selectAll"),
            hint: "Ctrl+A",
            onClick: () =>
              setSel(board.ref.current.filter((o) => !o.parent && !o.hidden).map((o) => o.id)),
          },
          {
            label: t("delAll"),
            danger: true,
            disabled: board.ref.current.length === 0,
            onClick: () => {
              setSel([]);
              board.apply(() => []);
            },
          },
          { label: t("tidy"), onClick: tidy },
          { label: t("fit"), hint: "⇧1", onClick: fitAll },
        ];
    setCtx({ x: e.clientX, y: e.clientY, items });
  };

  /* ───────────── клавиатура ───────────── */

  const kb = useRef<(e: KeyboardEvent) => void>(() => undefined);
  kb.current = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    const meta = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.code === "Space" && !e.repeat) {
      spaceHeld.current = true;
      wrapRef.current?.classList.add("hc-space");
      e.preventDefault();
      return;
    }
    if (meta && k === "z") {
      e.preventDefault();
      if (e.shiftKey) board.redo();
      else board.undo();
      setSel(selRef.current.filter((id) => board.ref.current.some((o) => o.id === id)));
      return;
    }
    if (meta && k === "y") {
      e.preventDefault();
      board.redo();
      return;
    }
    if (meta && k === "a") {
      e.preventDefault();
      setSel(board.ref.current.filter((o) => !o.parent && !o.hidden && !o.locked).map((o) => o.id));
      return;
    }
    if (meta && k === "c") {
      copySel();
      return;
    }
    if (meta && k === "x") {
      e.preventDefault();
      copySel(true);
      return;
    }
    if (meta && k === "d") {
      e.preventDefault();
      duplicate();
      return;
    }
    if (meta && k === "g") {
      e.preventDefault();
      if (e.shiftKey) actions.ungroup();
      else actions.group();
      return;
    }
    if (meta && k === "l" && e.shiftKey) {
      e.preventDefault();
      actions.lock();
      return;
    }
    if (meta && (e.key === "]" || e.key === "[")) {
      e.preventDefault();
      actions.order(
        e.key === "]" ? (e.shiftKey ? "front" : "forward") : e.shiftKey ? "back" : "backward",
      );
      return;
    }
    if (meta) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeSel();
      return;
    }
    if (e.key === "Escape") {
      if (gesture.current) {
        board.cancel();
        gesture.current = null;
        setPenPts(null);
      } else if (selRef.current.length) setSel([]);
      else setTool("select");
      setCtx(null);
      return;
    }
    if (e.key === "Enter" && selRef.current.length === 1) {
      const o = byIdRef.current.get(selRef.current[0]);
      if (o && !o.locked && ["shape", "sticky", "text", "task", "frame"].includes(o.type)) {
        e.preventDefault();
        setEditing(o.id);
      }
      return;
    }
    if (e.key.startsWith("Arrow") && selRef.current.length) {
      e.preventDefault();
      const s = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -s : e.key === "ArrowRight" ? s : 0;
      const dy = e.key === "ArrowUp" ? -s : e.key === "ArrowDown" ? s : 0;
      const ids = withChildren(
        board.ref.current,
        selRef.current.filter((id) => !byIdRef.current.get(id)?.locked),
      );
      board.apply((o) => fitGroups(moveObjs(o, ids, dx, dy)), "nudge");
      return;
    }
    if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) {
      e.preventDefault();
      fitAll();
      return;
    }
    if (e.shiftKey && (e.key === "@" || e.code === "Digit2")) {
      e.preventDefault();
      fitSelection();
      return;
    }
    if (e.key === "+" || e.key === "=") return zoomAt(1.25);
    if (e.key === "-") return zoomAt(0.8);
    const map: Record<string, Tool> = {
      v: "select",
      h: "hand",
      s: "sticky",
      t: "text",
      r: "shape",
      l: "line",
      f: "frame",
      p: "pen",
      k: "task",
      e: "sticker",
    };
    if (map[k] && !e.altKey) {
      setTool(map[k]);
      return;
    }
    if (k === "i") fileInput.current?.click();
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => kb.current(e);
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceHeld.current = false;
        wrapRef.current?.classList.remove("hc-space");
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  /* вставка: картинки, свои объекты, обычный текст */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const wrap = wrapRef.current;
      if (!wrap || !wrap.offsetParent) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        void addImageBlob(files[0], clientCenter());
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.startsWith("holst:v3:")) {
        e.preventDefault();
        pasteInternal(text);
      } else if (text.trim()) {
        e.preventDefault();
        const ob = make("sticky", clientCenter(), { text: text.slice(0, 600) });
        addObjs([ob]);
      } else if (clip.current) pasteInternal(clip.current);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const at = clientToWorld(e.clientX, e.clientY);
    const img = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
    if (img) {
      void addImageBlob(img, at);
      return;
    }
    const text = e.dataTransfer.getData("text/plain");
    if (text && text.toLowerCase().endsWith(".md")) addNote(text, at);
  };

  /* ───────────── экспорт ───────────── */

  const exportBoard = async (fmt: "png" | "svg" | "json") => {
    const all = board.ref.current.filter((o) => !o.hidden);
    const dl = (href: string, ext: string) => {
      const a = document.createElement("a");
      a.href = href;
      a.download = `${name || "holst"}.${ext}`;
      a.click();
    };
    if (fmt === "json") {
      const doc: HolstDoc = {
        version: 3,
        name,
        objs: board.ref.current,
        viewport: { x: view.x, y: view.y, zoom: view.z },
        updatedAt: new Date().toISOString(),
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
      );
      dl(url, "holst");
      URL.revokeObjectURL(url);
      return;
    }
    const box = unionBox(all.map((o) => boundsOf(o, byIdRef.current)));
    const el = worldRef.current;
    if (!box || !el) return;
    const pad = 48;
    const bg = getComputedStyle(wrapRef.current!).backgroundColor || "#11141f";
    const opts = {
      width: Math.ceil(box.w + pad * 2),
      height: Math.ceil(box.h + pad * 2),
      pixelRatio: 2,
      backgroundColor: bg,
      style: {
        transform: `translate(${pad - box.x}px, ${pad - box.y}px) scale(1)`,
        transformOrigin: "0 0",
      } as Record<string, string>,
      filter: (n: Node) => !(n instanceof HTMLElement && n.dataset.exportSkip),
    };
    try {
      dl(fmt === "png" ? await toPng(el, opts) : await toSvg(el, opts), fmt);
    } catch {
      /* экспорт картинки не удался */
    }
  };

  /* ───────────── отрисовка ───────────── */

  const geoms = useMemo(() => {
    const m = new Map<string, ReturnType<typeof lineGeom>>();
    for (const o of objs) if (o.type === "line") m.set(o.id, lineGeom(o, byId));
    return m;
  }, [objs, byId]);

  const penOpts = tool === "pen";
  const side = penOpts ? (
    <div className="hc-insp hc-float" data-ui>
      <div className="hc-row">
        <div className="hc-row-label">{t("color")}</div>
        <div className="hc-swatches">
          {[
            "#1c1d2b",
            "#ef4444",
            "#f59e0b",
            "#22c55e",
            "#3b82f6",
            "#8b5cf6",
            "#ec4899",
            "#ffffff",
          ].map((c) => (
            <button
              key={c}
              type="button"
              className={`hc-sw${penColor === c ? " on" : ""}`}
              style={{ background: c }}
              onClick={() => setPenColor(c)}
            />
          ))}
        </div>
      </div>
      <div className="hc-row">
        <div className="hc-row-label">{t("width")}</div>
        <div className="hc-line">
          <input
            type="range"
            min={1}
            max={24}
            value={penWidth}
            onChange={(e) => setPenWidth(Number(e.target.value))}
          />
          <span>{penWidth}</span>
        </div>
      </div>
      <label className="hc-check">
        <input type="checkbox" checked={marker} onChange={(e) => setMarker(e.target.checked)} />
        {ru ? "Маркер" : "Highlighter"}
      </label>
    </div>
  ) : selObjs.length > 0 && rightTab === "props" ? (
    <Inspector sel={selObjs} a={actions} t={t} ru={ru} />
  ) : null;

  const cursor = tool === "hand" ? "grab" : tool === "select" ? "default" : "crosshair";

  return (
    <div className="hc-root">
      <div
        ref={wrapRef}
        className="hc-stage"
        style={{
          cursor,
          backgroundSize: grid ? `${24 * view.z}px ${24 * view.z}px` : undefined,
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundImage: grid
            ? "radial-gradient(circle, var(--hc-dot) 1.2px, transparent 1.4px)"
            : "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onDragOver={(e) => {
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={onDrop}
      >
        <div
          ref={worldRef}
          className="hc-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
        >
          {objs.map((o) => (
            <ObjectView
              key={o.id}
              o={o}
              editing={editing === o.id}
              selected={sel.includes(o.id)}
              geom={geoms.get(o.id)}
              onCommit={onCommit}
              onPatch={onPatch}
              onMeasure={onMeasure}
            />
          ))}
          <div data-export-skip="1">
            <SelectionLayer
              objs={objs}
              byId={byId}
              sel={sel}
              hover={hover}
              z={view.z}
              guides={guides}
              marquee={marquee}
              pen={penPts}
              penColor={penColor}
              penWidth={penWidth}
              showPorts={(tool === "select" || tool === "line") && !editing}
            />
          </div>
        </div>

        {objs.length === 0 && ready && <div className="hc-empty">{t("empty")}</div>}
        {dropping && <div className="hc-drop-hint">{t("dropHere")}</div>}
      </div>

      <TopBar
        t={t}
        boards={boards}
        file={file}
        name={name}
        onName={setName}
        onOpenBoard={(f) => void openBoard(f)}
        onNewBoard={() => void createBoard()}
        onDeleteBoard={(f) => void removeBoard(f)}
        canUndo={board.canUndo}
        canRedo={board.canRedo}
        onUndo={() => board.undo()}
        onRedo={() => board.redo()}
        zoom={view.z}
        onZoom={setZoom}
        onFit={fitAll}
        onFitSel={fitSelection}
        hasSel={sel.length > 0}
        grid={grid}
        onGrid={() => {
          setGrid(!grid);
          lsSet(LS.grid, grid ? "0" : "1");
        }}
        snap={snap}
        onSnap={() => {
          setSnap(!snap);
          lsSet(LS.snap, snap ? "0" : "1");
        }}
        wheelZoom={wheelZoom}
        onWheel={() => {
          setWheelZoom(!wheelZoom);
          lsSet(LS.wheel, wheelZoom ? "0" : "1");
        }}
        onTemplates={() => setTplOpen(true)}
        onExport={(f) => void exportBoard(f)}
        save={save}
      />
      <ToolDock
        tool={tool}
        onTool={setTool}
        shape={shapeKind}
        onShape={setShapeKind}
        emoji={emoji}
        onEmoji={setEmoji}
        onImage={() => fileInput.current?.click()}
        t={t}
        ru={ru}
      />
      <div className="hc-side" data-ui>
        <div className="hc-tabs hc-float">
          <button
            type="button"
            className={rightTab === "props" ? "on" : ""}
            onClick={() => setRightTab("props")}
          >
            {t("props")}
          </button>
          <button
            type="button"
            className={rightTab === "layers" ? "on" : ""}
            onClick={() => setRightTab("layers")}
          >
            {t("layers")}
          </button>
        </div>
        {rightTab === "layers" ? (
          <div className="hc-insp hc-float" data-ui>
            <LayersPanel
              objs={objs}
              sel={sel}
              t={t}
              onSelect={(id, add) => {
                const o = byIdRef.current.get(id);
                if (!o || o.hidden) return;
                setSel(
                  add
                    ? selRef.current.includes(id)
                      ? selRef.current.filter((s) => s !== id)
                      : [...selRef.current, id]
                    : [id],
                );
              }}
              onToggle={(id, what) =>
                board.apply((all) => all.map((x) => (x.id === id ? { ...x, [what]: !x[what] } : x)))
              }
              onRename={(id, nm) =>
                board.apply((all) =>
                  all.map((x) => (x.id === id ? { ...x, name: nm.trim() || undefined } : x)),
                )
              }
            />
          </div>
        ) : (
          side
        )}
      </div>
      <Minimap
        objs={objs}
        byId={byId}
        view={view}
        size={size}
        onJump={(wx, wy) =>
          setView({
            ...viewRef.current,
            x: size.w / 2 - wx * viewRef.current.z,
            y: size.h / 2 - wy * viewRef.current.z,
          })
        }
      />

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        multiple
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          let n = 0;
          for (const f of files) {
            const c = viewCenter();
            void addImageBlob(f, { x: c.x + n * 30, y: c.y + n * 30 });
            n++;
          }
        }}
      />
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
      {tplOpen && (
        <TemplatesModal t={t} onClose={() => setTplOpen(false)} onSelect={applyTemplate} />
      )}
    </div>
  );
}

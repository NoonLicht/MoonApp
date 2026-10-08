/* Перенос старых досок (.holst версии 2, узлы React Flow) в модель v3. */
import { make, uid, type Obj, type ShapeKind } from "@/pages/myspace/canvas/model";

interface FlowNode {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data?: Record<string, any>;
  style?: { width?: number; height?: number };
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
}
interface FlowEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data?: Record<string, any>;
  style?: { stroke?: string; strokeWidth?: number };
}

const SHAPE_MAP: Record<string, ShapeKind> = {
  rect: "rect",
  rounded: "rounded",
  circle: "ellipse",
  diamond: "diamond",
  star: "star",
  cloud: "cloud",
};

const sizeOf = (n: FlowNode, dw: number, dh: number) => ({
  w: Math.round(n.style?.width ?? n.measured?.width ?? n.width ?? n.data?.w ?? dw),
  h: Math.round(n.style?.height ?? n.measured?.height ?? n.height ?? n.data?.h ?? dh),
});

const sideOf = (h?: string | null): "t" | "r" | "b" | "l" | "auto" => {
  const s = (h ?? "").toLowerCase();
  if (s.includes("top")) return "t";
  if (s.includes("bottom")) return "b";
  if (s.includes("left")) return "l";
  if (s.includes("right")) return "r";
  return "auto";
};

/** Узлы и связи старого формата → объекты нового. Идентификаторы сохраняются, чтобы не терять связи. */
export function fromFlow(nodes: unknown[], edges: unknown[]): Obj[] {
  const out: Obj[] = [];
  const ids = new Set<string>();
  for (const raw of nodes as FlowNode[]) {
    if (!raw || typeof raw.id !== "string") continue;
    const p = raw.position ?? { x: 0, y: 0 };
    const d = raw.data ?? {};
    const put = (o: Obj) => {
      out.push({ ...o, id: raw.id, x: Math.round(p.x), y: Math.round(p.y) });
      ids.add(raw.id);
    };
    const at = { x: p.x, y: p.y };
    switch (raw.type) {
      case "sticky": {
        const s = sizeOf(raw, 170, 150);
        put(
          make("sticky", at, {
            ...s,
            text: d.text ?? "",
            fill: d.color ?? "#fef08a",
            x: p.x,
            y: p.y,
          }),
        );
        break;
      }
      case "text": {
        const s = sizeOf(raw, 200, 44);
        put(
          make("text", at, {
            ...s,
            text: d.text ?? "",
            fs: d.fontSize ?? 20,
            fw: d.weight ?? 500,
            ta: d.align ?? "left",
            tc: d.color,
            x: p.x,
            y: p.y,
          }),
        );
        break;
      }
      case "shape": {
        const s = sizeOf(raw, 160, 90);
        put(
          make("shape", at, {
            ...s,
            shape: SHAPE_MAP[d.shape] ?? "rounded",
            text: d.label ?? "",
            fill: d.fill ?? "#bfdbfe",
            stroke: d.stroke ?? "#1f2937",
            x: p.x,
            y: p.y,
          }),
        );
        break;
      }
      case "frame": {
        const s = sizeOf(raw, 420, 320);
        put(
          make("frame", at, {
            ...s,
            name: d.label || "Рамка",
            fill: "#ffffff",
            stroke: d.color ?? "#94a3b8",
            opacity: 1,
            x: p.x,
            y: p.y,
          }),
        );
        break;
      }
      case "task": {
        const s = sizeOf(raw, 210, 120);
        put(
          make("task", at, {
            ...s,
            text: d.title ?? "",
            status: d.status ?? "todo",
            due: d.due,
            subtasks: Array.isArray(d.subtasks) ? d.subtasks : [],
            x: p.x,
            y: p.y,
          }),
        );
        break;
      }
      case "md": {
        const s = sizeOf(raw, 190, 150);
        put(
          make("note", at, {
            ...s,
            path: d.path,
            text: d.name ?? "",
            preview: d.preview,
            x: p.x,
            y: p.y,
          }),
        );
        break;
      }
      case "sticker": {
        put(make("sticker", at, { emoji: d.emoji ?? "👍", x: p.x, y: p.y }));
        break;
      }
      case "image": {
        const s = sizeOf(raw, 320, 200);
        if (typeof d.src === "string") put(make("image", at, { ...s, src: d.src, x: p.x, y: p.y }));
        break;
      }
      case "stroke": {
        const s = sizeOf(raw, d.w ?? 10, d.h ?? 10);
        put(
          make("stroke", at, {
            ...s,
            pts: Array.isArray(d.points) ? d.points : [],
            bw: d.w ?? s.w,
            bh: d.h ?? s.h,
            stroke: d.color ?? "#f59e0b",
            sw: d.width ?? 3,
            opacity: d.opacity ?? 1,
            x: p.x,
            y: p.y,
          }),
        );
        break;
      }
      case "matrix": {
        /* матрица распадается на рамку-заголовок и колонки со стикерами */
        const s = sizeOf(raw, 460, 330);
        const cols: string[] = Array.isArray(d.columns) ? d.columns : [];
        const frame = make("frame", at, {
          ...s,
          name: d.title ?? "Матрица",
          x: p.x,
          y: p.y,
        });
        frame.id = raw.id;
        out.push(frame);
        ids.add(raw.id);
        const colW = s.w / Math.max(1, cols.length);
        cols.forEach((c, i) => {
          out.push(
            make(
              "text",
              { x: p.x + colW * i + colW / 2, y: p.y + 28 },
              { w: colW - 16, text: c, fw: 700, ta: "center", parent: raw.id },
            ),
          );
        });
        const used: number[] = cols.map(() => 0);
        for (const it of (d.items ?? []) as { col: number; text: string; color: string }[]) {
          const c = Math.max(0, Math.min(cols.length - 1, it.col ?? 0));
          out.push(
            make(
              "sticky",
              { x: p.x + colW * c + colW / 2, y: p.y + 100 + used[c] * 120 },
              {
                w: Math.min(150, colW - 20),
                h: 100,
                text: it.text,
                fill: it.color,
                parent: raw.id,
              },
            ),
          );
          used[c]++;
        }
        break;
      }
      default:
        break;
    }
  }
  for (const e of edges as FlowEdge[]) {
    if (!e || !ids.has(e.source) || !ids.has(e.target)) continue;
    const d = e.data ?? {};
    out.push(
      make(
        "line",
        { x: 0, y: 0 },
        {
          id: e.id || uid(),
          from: { id: e.source, side: sideOf(e.sourceHandle) },
          to: { id: e.target, side: sideOf(e.targetHandle) },
          ls: d.style === "straight" ? "straight" : d.style === "step" ? "step" : "curve",
          dash: d.dash ?? "solid",
          h1: d.arrowStart ? "arrow" : "none",
          h2: d.arrowEnd === false ? "none" : "arrow",
          stroke: e.style?.stroke ?? "#8b7bf0",
          sw: e.style?.strokeWidth ?? 2,
          animated: !!d.animated,
        },
      ),
    );
  }
  return out;
}

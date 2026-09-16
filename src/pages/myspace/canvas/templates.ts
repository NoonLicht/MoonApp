import type { Node, Edge } from "@xyflow/react";
import { EMPTY_CONNECTOR, STICKY_COLORS } from "@/pages/myspace/canvas/types";

/* Template generators — return plain { nodes, edges } JSON. */

let tplSeq = 0;
const uid = (p: string) =>
  `${p}_t${Date.now().toString(36)}${(tplSeq++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

export interface TplResult {
  nodes: Node[];
  edges: Edge[];
}

type NodeBuilder = (id: string, x: number, y: number, data: any, extra?: Partial<Node>) => Node;
const mk: NodeBuilder = (id, x, y, data, extra = {}) =>
  ({ id, position: { x, y }, data, ...extra }) as Node;

const sticky = (x: number, y: number, text: string, color = STICKY_COLORS[0]) =>
  mk(uid("sticky"), x, y, { text, color }, { type: "sticky", style: { width: 170, height: 150 } });

const shape = (x: number, y: number, s: any) =>
  mk(uid("shape"), x, y, s, { type: "shape", style: { width: s.w, height: s.h } });

const frame = (x: number, y: number, label: string, color: string, w: number, h: number) =>
  mk(
    uid("frame"),
    x,
    y,
    { label, color, w, h },
    { type: "frame", zIndex: -1, style: { width: w, height: h } },
  );

const task = (x: number, y: number, title: string, status = "todo") =>
  mk(
    uid("task"),
    x,
    y,
    { title, status, subtasks: [{ text: "step", done: false }] },
    { type: "task", style: { width: 210, height: 120 } },
  );

const matrix = (x: number, y: number, title: string, columns: string[], items: any[]) =>
  mk(
    uid("matrix"),
    x,
    y,
    { title, columns, items },
    { type: "matrix", style: { width: 460, height: 330 } },
  );

const conn = (src: string, dst: string, extraData: any = {}) =>
  ({
    id: uid("e"),
    source: src,
    target: dst,
    type: "connector",
    markerEnd: { type: "arrowclosed", color: "#8b7bf0" },
    style: { stroke: "#8b7bf0", strokeWidth: 2 },
    data: { ...EMPTY_CONNECTOR, ...extraData },
  }) as Edge;

/* ── Generators ── */

export function generateRetro(ox: number, oy: number): TplResult {
  const cols = [
    { label: "Went Well", color: "#bbf7d0", items: ["Clear scope", "Fast reviews"] },
    { label: "To Improve", color: "#fef08a", items: ["Late deploy"] },
    { label: "Action Items", color: "#bfdbfe", items: ["Add CI checks"] },
  ];
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  cols.forEach((c, i) => {
    const x = ox + i * 230;
    const f = frame(x, oy, c.label, c.color, 210, 240);
    nodes.push(f);
    c.items.forEach((it, k) => nodes.push(sticky(x + 20, oy + 46 + k * 95, it, c.color)));
  });
  return { nodes, edges };
}

export function generateSprint(ox: number, oy: number): TplResult {
  const nodes = [
    matrix(
      ox,
      oy,
      "Sprint Impact Matrix",
      ["Quick Wins", "Major Projects", "Fill-ins", "Thankless"],
      [
        { col: 0, text: "Fix onboarding", color: "#bbf7d0" },
        { col: 1, text: "New editor", color: "#fef08a" },
        { col: 2, text: "Docs", color: "#bfdbfe" },
        { col: 3, text: "Legacy cleanup", color: "#fbcfe8" },
      ],
    ),
  ];
  return { nodes, edges: [] };
}

export function generateMindMap(ox: number, oy: number): TplResult {
  const center = sticky(ox + 90, oy + 90, "Core Idea", "#e9d5ff");
  const branches = ["Research", "Design", "Build", "Launch"];
  const nodes: Node[] = [center];
  const edges: Edge[] = [];
  branches.forEach((b, i) => {
    const ang = (Math.PI / 2) * i + Math.PI / 4;
    const x = ox + 120 + Math.cos(ang) * 260;
    const y = oy + 120 + Math.sin(ang) * 170;
    const n = sticky(x, y, b, STICKY_COLORS[i % STICKY_COLORS.length]);
    nodes.push(n);
    edges.push(conn(center.id, n.id));
  });
  return { nodes, edges };
}

export function generateCJM(ox: number, oy: number): TplResult {
  const stages = ["Discover", "Evaluate", "Purchase", "Use", "Advocate"];
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let prevId: string | null = null;
  stages.forEach((s, i) => {
    const x = ox + i * 220;
    const n = shape(x, oy, {
      shape: "rounded",
      label: s,
      fill: STICKY_COLORS[i % 6],
      stroke: "#16181f",
      w: 180,
      h: 70,
    });
    nodes.push(n);
    nodes.push(sticky(x + 10, oy + 100, "Touchpoint…", "#e5e7eb"));
    if (prevId) edges.push(conn(prevId, n.id, { style: "step" }));
    prevId = n.id;
  });
  return { nodes, edges };
}

export function generateFlowchart(ox: number, oy: number): TplResult {
  const start = shape(ox, oy + 60, {
    shape: "rounded",
    label: "Start",
    fill: "#bbf7d0",
    stroke: "#16181f",
    w: 130,
    h: 56,
  });
  const build = shape(ox + 220, oy + 60, {
    shape: "rounded",
    label: "Build",
    fill: "#bfdbfe",
    stroke: "#16181f",
    w: 130,
    h: 56,
  });
  const decision = shape(ox + 440, oy + 40, {
    shape: "diamond",
    label: "Tests pass?",
    fill: "#fef08a",
    stroke: "#16181f",
    w: 170,
    h: 100,
  });
  const ship = shape(ox + 700, oy, {
    shape: "rounded",
    label: "Ship 🚀",
    fill: "#bbf7d0",
    stroke: "#16181f",
    w: 130,
    h: 56,
  });
  const fix = task(ox + 700, oy + 140, "Fix failing test", "inprogress");
  const nodes = [start, build, decision, ship, fix];
  const edges = [
    conn(start.id, build.id, { style: "step" }),
    conn(build.id, decision.id, { style: "step" }),
    conn(decision.id, ship.id, { style: "step" }),
    conn(decision.id, fix.id, { style: "step" }),
  ];
  return { nodes, edges };
}

export const TEMPLATES: {
  id: string;
  name: string;
  desc: string;
  emoji: string;
  gen: (x: number, y: number) => TplResult;
}[] = [
  {
    id: "retro",
    name: "Agile Retrospective",
    desc: "Went well / Improve / Actions columns",
    emoji: "🔄",
    gen: generateRetro,
  },
  {
    id: "sprint",
    name: "Sprint Impact Matrix",
    desc: "Effort × impact quadrants",
    emoji: "📋",
    gen: generateSprint,
  },
  {
    id: "mindmap",
    name: "Mind Map",
    desc: "Central topic with branches",
    emoji: "🧠",
    gen: generateMindMap,
  },
  {
    id: "cjm",
    name: "Customer Journey Map",
    desc: "5-stage CJM pipeline",
    emoji: "🛤",
    gen: generateCJM,
  },
  {
    id: "flowchart",
    name: "Flowchart Pipeline",
    desc: "Decision tree with tasks",
    emoji: "🔀",
    gen: generateFlowchart,
  },
];

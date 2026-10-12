/**
 * Игры: время игры, бэклог, рекомендации под целевой FPS и сравнение замеров.
 *
 * Время берётся из трекера окон (appTimeTracker): имя процесса сопоставляется
 * с именем exe карточки. Замеры FPS приходят из PresentMon / CapFrameX / MSI
 * Afterburner (CSV с временем кадра) — приложение само кадры не перехватывает.
 * Всё ядро чистое, чтобы его можно было тестировать без Windows.
 */
import path from "path";

export type GameStatus = "backlog" | "playing" | "done" | "dropped";

/** Секунды по процессам за всё время (имя процесса без .exe, регистр не важен). */
export function playSecondsFor(exePath: string, totals: Record<string, number>): number {
  const base = path.basename(String(exePath || "")).replace(/\.exe$/i, "").toLowerCase();
  if (!base) return 0;
  let sum = 0;
  for (const [name, sec] of Object.entries(totals)) {
    if (name.replace(/\.exe$/i, "").toLowerCase() === base) sum += sec;
  }
  return sum;
}

export interface BacklogItem {
  id: string;
  name: string;
  status: GameStatus;
  playSeconds: number;
  createdAt: number;
}

/**
 * Порядок «во что играть дальше»: сначала те, что в процессе (по времени
 * последней игры не знаем — по наибольшему времени), затем бэклог от давно
 * добавленных к новым; законченные и брошенные — в конце.
 */
export function backlogOrder(items: BacklogItem[]): BacklogItem[] {
  const rank: Record<GameStatus, number> = { playing: 0, backlog: 1, done: 2, dropped: 3 };
  return [...items].sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (a.status === "playing" ? b.playSeconds - a.playSeconds : a.createdAt - b.createdAt) ||
      a.name.localeCompare(b.name),
  );
}

/* --------------------------- Рекомендации под FPS --------------------------- */

export type GpuTier = 0 | 1 | 2 | 3 | 4 | 5;

/** Грубый класс видеокарты по названию: 0 — встроенная, 5 — топ. */
export function gpuTier(name: string): GpuTier {
  const n = String(name || "").toLowerCase();
  const num = (re: RegExp): number => Number(n.match(re)?.[1] ?? NaN);
  const rtx = num(/rtx\s*(\d{4})/);
  if (!Number.isNaN(rtx)) {
    const gen = Math.floor(rtx / 100); // 20, 30, 40, 50
    const cls = rtx % 100; // 50, 60, 70, 80, 90
    const base = cls >= 90 ? 5 : cls >= 80 ? 4 : cls >= 70 ? 3 : cls >= 60 ? 2 : 1;
    return Math.min(5, Math.max(0, base + (gen < 30 ? -1 : 0))) as GpuTier;
  }
  const gtx = num(/gtx\s*(\d{3,4})/);
  if (!Number.isNaN(gtx)) {
    const cls = gtx % 100;
    return (cls >= 80 ? 2 : cls >= 60 ? 1 : 0) as GpuTier;
  }
  const rx = num(/rx\s*(\d{4})/);
  if (!Number.isNaN(rx)) {
    const d = Math.floor((rx % 1000) / 100); // 7900 → 9, 7800 → 8, 6600 → 6
    return (d >= 9 ? 5 : d >= 8 ? 4 : d >= 7 ? 3 : d >= 6 ? 2 : d >= 5 ? 1 : 0) as GpuTier;
  }
  if (/arc\s*a?\s*[5-7]\d0/.test(n)) return 2;
  return 0;
}

export interface Recommendation {
  preset: "low" | "medium" | "high" | "ultra";
  /** Доля от родного разрешения по каждой оси: 1, 0.77, 0.67, 0.58. */
  renderScale: number;
  upscaler: "none" | "quality" | "balanced" | "performance";
  frameGen: boolean;
  notes: string[];
}

/**
 * Подбирает пресет под целевой FPS. Эвристика по классу видеокарты и числу
 * пикселей: «бюджет» FPS у карты класса N на 1080p принимается за базу, дальше
 * каждое увеличение разрешения или целевого FPS съедает уровень.
 */
export function recommend(opts: {
  gpuName: string;
  vramMb?: number | null;
  targetFps: number;
  height: 1080 | 1440 | 2160 | number;
}): Recommendation {
  const tier = gpuTier(opts.gpuName);
  const resPenalty = opts.height >= 2160 ? 2 : opts.height >= 1440 ? 1 : 0;
  const fpsPenalty = opts.targetFps >= 144 ? 2 : opts.targetFps >= 90 ? 1 : 0;
  const score = tier - resPenalty - fpsPenalty; // от -4 до 5
  const notes: string[] = [];
  let preset: Recommendation["preset"];
  let upscaler: Recommendation["upscaler"] = "none";
  let renderScale = 1;
  if (score >= 3) preset = "ultra";
  else if (score >= 1) preset = "high";
  else if (score >= 0) preset = "medium";
  else preset = "low";
  if (score < 0) {
    upscaler = score <= -2 ? "performance" : "balanced";
    renderScale = upscaler === "performance" ? 0.5 : 0.58;
  } else if (score === 0 && (resPenalty > 0 || fpsPenalty > 0)) {
    upscaler = "quality";
    renderScale = 0.67;
  }
  const vram = opts.vramMb ?? null;
  if (vram !== null && vram < 6144 && (preset === "ultra" || preset === "high")) {
    preset = "medium";
    notes.push("vram-low");
  }
  if (tier === 0) notes.push("integrated-gpu");
  const frameGen = tier >= 3 && opts.targetFps >= 90;
  if (frameGen) notes.push("frame-gen");
  return { preset, renderScale, upscaler, frameGen, notes };
}

/* ----------------------------- Замеры кадров ----------------------------- */

export interface FrameStats {
  frames: number;
  avgFps: number;
  p1LowFps: number;
  p01LowFps: number;
  avgFrameMs: number;
}

const FRAME_COLS = ["msbetweenpresents", "frametime", "frametimes", "msbetweendisplaychange", "ms/frame"];

/** CSV PresentMon / CapFrameX / Afterburner: ищет столбец времени кадра в миллисекундах. */
export function parseFrameCsv(csv: string): number[] {
  const lines = String(csv || "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  let idx = header.findIndex((h) => FRAME_COLS.includes(h));
  if (idx === -1) idx = header.findIndex((h) => /frame\s*time|ms.*present/.test(h));
  if (idx === -1) return [];
  const out: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const v = Number(lines[i].split(sep)[idx]?.trim().replace(/^"|"$/g, "").replace(",", "."));
    if (Number.isFinite(v) && v > 0 && v < 10_000) out.push(v);
  }
  return out;
}

export function frameStats(frameMs: number[]): FrameStats | null {
  if (frameMs.length < 10) return null;
  const sorted = [...frameMs].sort((a, b) => b - a); // самые долгие кадры первыми
  const mean = frameMs.reduce((s, v) => s + v, 0) / frameMs.length;
  const worst = (share: number): number => {
    const n = Math.max(1, Math.ceil(frameMs.length * share));
    const avg = sorted.slice(0, n).reduce((s, v) => s + v, 0) / n;
    return 1000 / avg;
  };
  const r = (v: number): number => Math.round(v * 10) / 10;
  return {
    frames: frameMs.length,
    avgFps: r(1000 / mean),
    p1LowFps: r(worst(0.01)),
    p01LowFps: r(worst(0.001)),
    avgFrameMs: Math.round(mean * 100) / 100,
  };
}

export interface BenchRun {
  id: string;
  gameId: string;
  label: string;
  at: number;
  stats: FrameStats;
}

export interface Comparison {
  avgFpsDelta: number;
  avgFpsPct: number;
  p1LowDelta: number;
  p1LowPct: number;
  verdict: "better" | "worse" | "same";
}

/** Сравнение «после» относительно «до». Отличие меньше 2 % считается шумом. */
export function compareRuns(before: FrameStats, after: FrameStats): Comparison {
  const pct = (a: number, b: number): number => (a > 0 ? Math.round(((b - a) / a) * 1000) / 10 : 0);
  const avgPct = pct(before.avgFps, after.avgFps);
  const lowPct = pct(before.p1LowFps, after.p1LowFps);
  const main = (avgPct + lowPct) / 2;
  return {
    avgFpsDelta: Math.round((after.avgFps - before.avgFps) * 10) / 10,
    avgFpsPct: avgPct,
    p1LowDelta: Math.round((after.p1LowFps - before.p1LowFps) * 10) / 10,
    p1LowPct: lowPct,
    verdict: main > 2 ? "better" : main < -2 ? "worse" : "same",
  };
}

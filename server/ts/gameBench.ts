/**
 * Хранилище замеров FPS по играм (storage/games/benchmarks.json).
 * Сам расчёт статистики и сравнение — в gameInsights.ts.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import config from "./config";
import { parseFrameCsv, frameStats, type BenchRun } from "./gameInsights";

const file = (): string => path.join(config.DIRS.games, "benchmarks.json");
const MAX_RUNS = 500;

function readAll(): BenchRun[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function listRuns(gameId?: string): BenchRun[] {
  const all = readAll().sort((a, b) => b.at - a.at);
  return gameId ? all.filter((r) => r.gameId === gameId) : all;
}

export function addRunFromCsv(gameId: string, label: string, csv: string): BenchRun {
  const stats = frameStats(parseFrameCsv(csv));
  if (!stats) throw new Error("no_frame_data");
  const run: BenchRun = {
    id: crypto.randomBytes(6).toString("hex"),
    gameId,
    label: String(label || "").trim().slice(0, 80) || "замер",
    at: Date.now(),
    stats,
  };
  const all = [run, ...readAll()].slice(0, MAX_RUNS);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2), "utf8");
  return run;
}

export function removeRun(id: string): boolean {
  const all = readAll();
  const next = all.filter((r) => r.id !== id);
  if (next.length === all.length) return false;
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), "utf8");
  return true;
}

/**
 * История показателей и алерты монитора (перегрев, место на диске, SMART).
 *
 * Ядро — чистые функции и классы без таймеров и обращений к системе, чтобы его
 * можно было тестировать. Фоновый сбор (startMonitorAlerts) включается настройкой
 * monitor.alertsEnabled: по умолчанию выключен, чтобы не добавлять нагрузку.
 *
 * Алерт срабатывает, когда условие держится не меньше `sustainMs`, и не
 * повторяется в течение `cooldownMs` — иначе шумный датчик заспамил бы журнал.
 */
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import config from "./config";
import logger from "./logger";
import settings from "./settings";
import type { SystemSnapshot } from "./monitor";

export interface Sample {
  t: number;
  cpuTemp: number | null;
  gpuTemp: number | null;
  cpuLoad: number;
  ramPercent: number;
  /** Свободное место по дискам: буква → % свободного. */
  diskFree: Record<string, number>;
}

export interface SmartDisk {
  name: string;
  health: string;
  operational: string;
  temperatureC: number | null;
  wearPercent: number | null;
}

export interface AlertEvent {
  id: string;
  rule: string;
  message: string;
  value: number | string;
  at: number;
}

export interface Rule {
  id: string;
  /** Возвращает значение, нарушающее порог, либо null. */
  check(s: Sample, smart: SmartDisk[]): { value: number | string; message: string } | null;
  sustainMs: number;
  cooldownMs: number;
}

export const DEFAULT_RULES: Rule[] = [
  {
    id: "cpu-temp",
    sustainMs: 60_000,
    cooldownMs: 600_000,
    check: (s) =>
      s.cpuTemp !== null && s.cpuTemp >= 90
        ? { value: s.cpuTemp, message: `Процессор перегревается: ${Math.round(s.cpuTemp)} °C` }
        : null,
  },
  {
    id: "gpu-temp",
    sustainMs: 60_000,
    cooldownMs: 600_000,
    check: (s) =>
      s.gpuTemp !== null && s.gpuTemp >= 85
        ? { value: s.gpuTemp, message: `Видеокарта перегревается: ${Math.round(s.gpuTemp)} °C` }
        : null,
  },
  {
    id: "ram",
    sustainMs: 120_000,
    cooldownMs: 900_000,
    check: (s) =>
      s.ramPercent >= 95
        ? { value: s.ramPercent, message: `Память почти заполнена: ${Math.round(s.ramPercent)} %` }
        : null,
  },
  {
    id: "disk-space",
    sustainMs: 0,
    cooldownMs: 6 * 3_600_000,
    check: (s) => {
      const low = Object.entries(s.diskFree).find(([, pct]) => pct < 10);
      return low
        ? { value: low[1], message: `На диске ${low[0]} осталось ${low[1].toFixed(1)} % места` }
        : null;
    },
  },
  {
    id: "smart",
    sustainMs: 0,
    cooldownMs: 24 * 3_600_000,
    check: (_s, smart) => {
      const bad = smart.find((d) => d.health && !/^healthy$/i.test(d.health));
      return bad
        ? { value: bad.health, message: `Диск ${bad.name}: состояние «${bad.health}»` }
        : null;
    },
  },
];

export class AlertEngine {
  private since = new Map<string, number>();
  private lastFired = new Map<string, number>();
  readonly log: AlertEvent[] = [];
  constructor(
    private rules: Rule[] = DEFAULT_RULES,
    private maxLog = 100,
  ) {}

  /** Оценивает образец; возвращает только новые срабатывания. */
  evaluate(s: Sample, smart: SmartDisk[] = []): AlertEvent[] {
    const fired: AlertEvent[] = [];
    for (const r of this.rules) {
      const hit = r.check(s, smart);
      if (!hit) {
        this.since.delete(r.id);
        continue;
      }
      const from = this.since.get(r.id) ?? s.t;
      this.since.set(r.id, from);
      if (s.t - from < r.sustainMs) continue;
      const last = this.lastFired.get(r.id);
      if (last !== undefined && s.t - last < r.cooldownMs) continue;
      this.lastFired.set(r.id, s.t);
      const ev: AlertEvent = {
        id: `${r.id}-${s.t}`,
        rule: r.id,
        message: hit.message,
        value: hit.value,
        at: s.t,
      };
      fired.push(ev);
      this.log.unshift(ev);
    }
    if (this.log.length > this.maxLog) this.log.length = this.maxLog;
    return fired;
  }
}

/** Кольцевая история: хранит не больше `max` точек, на выдаче прореживает для графика. */
export class History {
  private points: Sample[] = [];
  constructor(private max = 2880) {}
  push(s: Sample): void {
    this.points.push(s);
    if (this.points.length > this.max) this.points.splice(0, this.points.length - this.max);
  }
  series(windowMs: number, maxPoints = 240, now = Date.now()): Sample[] {
    const from = now - windowMs;
    const inWin = this.points.filter((p) => p.t >= from);
    if (inWin.length <= maxPoints) return inWin;
    const step = inWin.length / maxPoints;
    return Array.from({ length: maxPoints }, (_, i) => inWin[Math.floor(i * step)]);
  }
  toJSON(): Sample[] {
    return this.points;
  }
  load(arr: unknown): void {
    if (!Array.isArray(arr)) return;
    this.points = arr.filter((p) => p && typeof p.t === "number").slice(-this.max);
  }
  get size(): number {
    return this.points.length;
  }
}

/** Средние показатели по часам суток (0–23) — «тепловая карта» нагрузки. */
export interface HourBucket {
  hour: number;
  samples: number;
  cpuLoad: number | null;
  cpuTemp: number | null;
  gpuTemp: number | null;
  ramPercent: number | null;
}

export function hourlyProfile(samples: Sample[]): HourBucket[] {
  const acc = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    n: 0,
    load: 0,
    ct: [0, 0],
    gt: [0, 0],
    ram: 0,
  }));
  for (const s of samples) {
    const b = acc[new Date(s.t).getHours()];
    b.n++;
    b.load += s.cpuLoad;
    b.ram += s.ramPercent;
    if (s.cpuTemp !== null) {
      b.ct[0] += s.cpuTemp;
      b.ct[1]++;
    }
    if (s.gpuTemp !== null) {
      b.gt[0] += s.gpuTemp;
      b.gt[1]++;
    }
  }
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  return acc.map((b) => ({
    hour: b.hour,
    samples: b.n,
    cpuLoad: b.n ? r1(b.load / b.n) : null,
    cpuTemp: b.ct[1] ? r1(b.ct[0] / b.ct[1]) : null,
    gpuTemp: b.gt[1] ? r1(b.gt[0] / b.gt[1]) : null,
    ramPercent: b.n ? r1(b.ram / b.n) : null,
  }));
}

export function sampleFromSnapshot(s: SystemSnapshot, now = Date.now()): Sample {
  const diskFree: Record<string, number> = {};
  for (const d of s.disks) {
    if (d.totalGb && d.freeGb !== null && d.totalGb > 0) {
      diskFree[d.drive] = Math.round((d.freeGb / d.totalGb) * 1000) / 10;
    }
  }
  const gpuT = s.gpu.map((g) => g.temperatureC).filter((v): v is number => v !== null);
  return {
    t: now,
    cpuTemp: s.cpu.temperatureC,
    gpuTemp: gpuT.length ? Math.max(...gpuT) : null,
    cpuLoad: s.cpu.loadTotalPercent,
    ramPercent: s.memory.usedPercent,
    diskFree,
  };
}

/** Разбор вывода `Get-PhysicalDisk | ConvertTo-Json` (один объект или массив). */
export function parseSmart(raw: string): SmartDisk[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr: Record<string, unknown>[] = Array.isArray(data) ? data : data ? [data as never] : [];
  return arr
    .map((d) => ({
      name: String(d.FriendlyName ?? d.Model ?? ""),
      health: String(d.HealthStatus ?? ""),
      operational: String(d.OperationalStatus ?? ""),
      temperatureC: typeof d.Temperature === "number" ? d.Temperature : null,
      wearPercent: typeof d.Wear === "number" ? d.Wear : null,
    }))
    .filter((d) => d.name);
}

/* ---------------------------- Фоновый сбор ---------------------------- */

const history = new History();
const engine = new AlertEngine();
let smartCache: SmartDisk[] = [];
let smartAt = 0;
let timer: NodeJS.Timeout | null = null;
let lastSave = 0;
const historyFile = (): string => path.join(config.DIRS.storage, "monitor-history.json");

function querySmart(): Promise<SmartDisk[]> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);
    const script =
      "Get-PhysicalDisk | ForEach-Object { $r = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue; " +
      "[pscustomobject]@{ FriendlyName=$_.FriendlyName; HealthStatus=[string]$_.HealthStatus; " +
      "OperationalStatus=[string]$_.OperationalStatus; Temperature=$r.Temperature; Wear=$r.Wear } } | ConvertTo-Json";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 20_000, windowsHide: true },
      (err, out) => resolve(err ? [] : parseSmart(String(out))),
    );
  });
}

export async function collectOnce(): Promise<AlertEvent[]> {
  const mon = require("./monitor") as typeof import("./monitor");
  const snap = await mon.getSnapshot();
  const now = Date.now();
  if (now - smartAt > 3_600_000) {
    smartAt = now;
    smartCache = await querySmart();
  }
  const sample = sampleFromSnapshot(snap, now);
  history.push(sample);
  const fired = engine.evaluate(sample, smartCache);
  for (const f of fired) logger.warn("monitor.alert", { rule: f.rule, message: f.message });
  if (now - lastSave > 300_000) {
    lastSave = now;
    try {
      fs.writeFileSync(historyFile(), JSON.stringify(history.toJSON()));
    } catch (e) {
      logger.warn("monitor.history.save", { error: String((e as Error).message) });
    }
  }
  return fired;
}

export function startMonitorAlerts(intervalMs = 30_000): void {
  if (timer) return;
  try {
    history.load(JSON.parse(fs.readFileSync(historyFile(), "utf8")));
  } catch {
    /* истории ещё нет */
  }
  timer = setInterval(() => {
    if (settings.get("monitor").alertsEnabled !== true) return;
    collectOnce().catch((e) => logger.warn("monitor.collect", { error: String(e?.message ?? e) }));
  }, intervalMs);
  timer.unref?.();
}

export function stopMonitorAlerts(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export const getHistory = (windowMs: number): Sample[] => history.series(windowMs);
export const getHourly = (): HourBucket[] => hourlyProfile(history.toJSON());
export const getAlerts = (): AlertEvent[] => engine.log;
export const getSmart = (): SmartDisk[] => smartCache;

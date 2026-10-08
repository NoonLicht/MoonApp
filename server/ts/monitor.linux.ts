/**
 * Linux-реализация сборщика телеметрии системы.
 *
 * В отличие от Windows-ветки (WMI + LibreHardwareMonitor + WinRing0-драйвер,
 * см. monitor.ts) на Linux нет единого API уровня администратора для чтения
 * датчиков — вместо этого используется набор независимых userspace-источников,
 * каждый из которых опционален и деградирует по отдельности, если недоступен:
 *
 *  - CPU load/freq   — /proc/stat, /proc/cpuinfo, /sys/.../cpufreq
 *  - RAM             — /proc/meminfo
 *  - Температуры     — `sensors -j` (пакет lm-sensors, требует sensors-detect)
 *  - Диски (объём)   — fs.statfsSync по точкам монтирования
 *  - Диски (SMART)   — `smartctl -a -j /dev/sdX` (best-effort, часто нужен root)
 *  - GPU (NVIDIA)    — `nvidia-smi` (тот же парсер, что и в monitor.ts)
 *  - GPU (AMD/Intel) — /sys/class/drm/cardN/device/hwmon (best-effort)
 *
 * Поля, которые физически не достать, возвращаются как null/[] — фронтенд уже
 * умеет скрывать такие виджеты (см. monitor.ts:SystemSnapshot), а не показывать
 * нули как реальные показания.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import type { SystemSnapshot, GpuInfo, DiskInfo, TempSensor } from "./monitor";

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || ""));
    });
  });
}

function readFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/* ------------------------------- CPU load ---------------------------------- */

interface ProcStatLine {
  idle: number;
  total: number;
}

function parseProcStat(text: string): ProcStatLine[] {
  const lines = text.split("\n").filter((l) => /^cpu\d/.test(l));
  return lines.map((l) => {
    const parts = l.trim().split(/\s+/).slice(1).map(Number);
    const [user, nice, sys, idle, iowait, irq, softirq, steal] = parts;
    const total =
      (user || 0) +
      (nice || 0) +
      (sys || 0) +
      (idle || 0) +
      (iowait || 0) +
      (irq || 0) +
      (softirq || 0) +
      (steal || 0);
    return { idle: (idle || 0) + (iowait || 0), total };
  });
}

let prevStat: ProcStatLine[] | null = null;
let prevAt = 0;

function computeLoad(): { totalPercent: number; perCorePercent: number[] } {
  const text = readFile("/proc/stat");
  if (!text) return { totalPercent: 0, perCorePercent: [] };
  const cur = parseProcStat(text);
  const now = Date.now();
  if (!prevStat || prevStat.length !== cur.length || now - prevAt < 50) {
    prevStat = cur;
    prevAt = now;
    return { totalPercent: 0, perCorePercent: cur.map(() => 0) };
  }
  const perCorePercent = cur.map((c, i) => {
    const dIdle = c.idle - prevStat![i].idle;
    const dTotal = c.total - prevStat![i].total;
    return dTotal > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - dIdle / dTotal)))) : 0;
  });
  const totalPercent = perCorePercent.length
    ? Math.round(perCorePercent.reduce((a, b) => a + b, 0) / perCorePercent.length)
    : 0;
  prevStat = cur;
  prevAt = now;
  return { totalPercent, perCorePercent };
}

function cpuModel(): string {
  const text = readFile("/proc/cpuinfo") || "";
  const m = text.match(/model name\s*:\s*(.+)/);
  return m ? m[1].trim() : os.cpus()[0]?.model || "Unknown CPU";
}

function cpuCurrentClockMhz(): number | null {
  // Средняя частота по ядрам через cpufreq, если есть; иначе /proc/cpuinfo "cpu MHz".
  try {
    const dirs = fs.readdirSync("/sys/devices/system/cpu").filter((d) => /^cpu\d+$/.test(d));
    const freqs: number[] = [];
    for (const d of dirs) {
      const raw = readFile(`/sys/devices/system/cpu/${d}/cpufreq/scaling_cur_freq`);
      if (raw) freqs.push(parseInt(raw.trim(), 10) / 1000);
    }
    if (freqs.length) return Math.round(freqs.reduce((a, b) => a + b, 0) / freqs.length);
  } catch {
    /* ignore */
  }
  const text = readFile("/proc/cpuinfo") || "";
  const matches = [...text.matchAll(/cpu MHz\s*:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  if (matches.length) return Math.round(matches.reduce((a, b) => a + b, 0) / matches.length);
  return null;
}

/* -------------------------------- RAM --------------------------------------- */

function readMeminfo(): { totalMb: number; usedMb: number; freeMb: number; usedPercent: number } {
  const text = readFile("/proc/meminfo") || "";
  const get = (key: string): number => {
    const m = text.match(new RegExp(`${key}:\\s*(\\d+)`));
    return m ? parseInt(m[1], 10) / 1024 : 0; // kB -> MB
  };
  const totalMb = Math.round(get("MemTotal"));
  const availMb = Math.round(get("MemAvailable") || get("MemFree"));
  const usedMb = Math.max(0, totalMb - availMb);
  return {
    totalMb,
    usedMb,
    freeMb: availMb,
    usedPercent: totalMb > 0 ? Math.round((100 * usedMb) / totalMb) : 0,
  };
}

/* ---------------------------- lm-sensors (JSON) ------------------------------ */

let sensorsAvailable: boolean | null = null;

async function readSensorsJson(): Promise<Record<string, Record<string, unknown>> | null> {
  try {
    const out = await run("sensors", ["-j"], 4000);
    sensorsAvailable = true;
    return JSON.parse(out);
  } catch {
    sensorsAvailable = sensorsAvailable === true ? true : false;
    return null;
  }
}

function pickCpuTempFromSensors(raw: Record<string, Record<string, unknown>> | null): TempSensor[] {
  if (!raw) return [];
  const out: TempSensor[] = [];
  for (const [chip, fields] of Object.entries(raw)) {
    if (!fields || typeof fields !== "object") continue;
    for (const [label, valuesUnknown] of Object.entries(fields as Record<string, unknown>)) {
      const values = valuesUnknown as Record<string, number> | undefined;
      if (!values || typeof values !== "object") continue;
      const tempKey = Object.keys(values).find((k) => /_input$/.test(k));
      if (!tempKey) continue;
      const value = values[tempKey];
      if (typeof value !== "number") continue;
      out.push({ id: `${chip}:${label}`, name: label, hw: chip, value });
    }
  }
  return out;
}

function pickCpuTemp(temps: TempSensor[]): number | null {
  const cpuTemps = temps.filter((t) => /coretemp|k10temp|zenpower|cpu/i.test(t.hw + " " + t.name));
  const preferred =
    cpuTemps.find((t) => /package|tctl|tdie/i.test(t.name)) ||
    cpuTemps.find((t) => /core 0/i.test(t.name)) ||
    cpuTemps[0];
  return preferred ? preferred.value : (temps[0]?.value ?? null);
}

/* -------------------------------- Диски -------------------------------------- */

function listMountedDisks(): DiskInfo[] {
  const out: DiskInfo[] = [];
  const text = readFile("/proc/mounts") || "";
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const [device, mountPoint, fsType] = line.split(" ");
    if (!device || !mountPoint) continue;
    // Только реальные блочные устройства — пропускаем tmpfs/proc/sysfs/overlay и т.п.
    if (!device.startsWith("/dev/")) continue;
    if (seen.has(mountPoint)) continue;
    // Не дублируем bind-mount'ы одного и того же раздела.
    seen.add(mountPoint);
    try {
      const st = fs.statfsSync(mountPoint);
      const totalGb = (st.blocks * st.bsize) / 1024 ** 3;
      const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
      out.push({
        drive: mountPoint,
        label: `${device} (${fsType || "?"})`,
        totalGb: +totalGb.toFixed(1),
        freeGb: +freeGb.toFixed(1),
        readMBs: null,
        writeMBs: null,
      });
    } catch {
      /* точка недоступна для statfs (например, потеряно сетевое соединение) */
    }
  }
  return out;
}

/* -------------------------------- GPU ----------------------------------------- */

async function queryNvidiaGpus(): Promise<GpuInfo[] | null> {
  const query =
    "name,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw";
  try {
    const stdout = await run(
      "nvidia-smi",
      ["--query-gpu=" + query, "--format=csv,noheader,nounits"],
      5000,
    );
    const gpus: GpuInfo[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const cols = line.split(",").map((c) => c.trim());
      if (cols.length < 7 || !cols[0]) continue;
      const num = (v: string): number | null => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
      };
      gpus.push({
        name: cols[0],
        temperatureC: num(cols[1]),
        utilizationPercent: num(cols[2]),
        memoryUsedMb: num(cols[3]),
        memoryTotalMb: num(cols[4]),
        fanPercent: num(cols[5]),
        powerWatt: num(cols[6]),
      });
    }
    return gpus.length ? gpus : null;
  } catch {
    return null;
  }
}

/** Best-effort: имя AMD/Intel GPU из /sys/class/drm — без гарантии temp/utilization. */
function nonNvidiaGpuNames(): GpuInfo[] {
  try {
    const cards = fs.readdirSync("/sys/class/drm").filter((d) => /^card\d+$/.test(d));
    const out: GpuInfo[] = [];
    for (const card of cards) {
      const vendorPath = `/sys/class/drm/${card}/device/vendor`;
      const vendor = readFile(vendorPath)?.trim();
      if (!vendor || vendor === "0x10de") continue; // NVIDIA уже покрыт nvidia-smi
      let name = card;
      const uevent = readFile(`/sys/class/drm/${card}/device/uevent`);
      const drvMatch = uevent?.match(/DRIVER=(\w+)/);
      if (drvMatch) name = `${drvMatch[1]} (${card})`;
      // Температура: hwmon рядом с device, если драйвер её публикует.
      let temperatureC: number | null = null;
      try {
        const hwmonRoot = `/sys/class/drm/${card}/device/hwmon`;
        const hwmons = fs.readdirSync(hwmonRoot);
        for (const hw of hwmons) {
          const raw = readFile(`${hwmonRoot}/${hw}/temp1_input`);
          if (raw) {
            temperatureC = parseInt(raw.trim(), 10) / 1000;
            break;
          }
        }
      } catch {
        /* нет hwmon у этого драйвера/карты */
      }
      out.push({
        name,
        utilizationPercent: null,
        temperatureC,
        memoryUsedMb: null,
        memoryTotalMb: null,
        fanPercent: null,
        powerWatt: null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/* ------------------------------ Сборка снапшота -------------------------------- */

export async function collectLinux(): Promise<SystemSnapshot> {
  const load = computeLoad();
  const mem = readMeminfo();
  const [sensorsJson, nvGpus] = await Promise.all([readSensorsJson(), queryNvidiaGpus()]);
  const temperatures = pickCpuTempFromSensors(sensorsJson);
  const gpu = nvGpus ?? nonNvidiaGpuNames();

  return {
    timestamp: new Date().toISOString(),
    cpu: {
      model: cpuModel(),
      coresPhysical: null, // /proc/cpuinfo не даёт физических ядер напрямую без парсинга topology — не выдумываем
      coresLogical: os.cpus().length,
      baseClockMhz: null,
      loadTotalPercent: load.totalPercent,
      loadPerCorePercent: load.perCorePercent,
      temperatureC: pickCpuTemp(temperatures),
      powerWatt: null, // RAPL (/sys/class/powercap) можно добавить отдельно — не универсально доступен
      clockMhz: cpuCurrentClockMhz(),
    },
    memory: mem,
    gpu,
    temperatures,
    fans: [],
    voltages: [],
    currents: [],
    powers: [],
    clocks: [],
    sensorsAll: temperatures.map((t) => ({
      id: t.id,
      name: t.name,
      type: "Temperature",
      parent: t.hw,
      hw: t.hw,
      value: t.value,
    })),
    hardware: [],
    disks: listMountedDisks(),
    network: [],
    system: {
      hostname: os.hostname(),
      arch: os.arch(),
      platform: os.platform(),
      osName: readFile("/etc/os-release")?.match(/PRETTY_NAME="?([^"\n]+)"?/)?.[1] || "Linux",
      osVersion: "",
      osBuild: "",
      uptimeSec: Math.round(os.uptime()),
      batteryPercent: readBatteryPercent(),
    },
    sources: { wmi: false, lhm: sensorsAvailable === true, nvidiaSmi: !!nvGpus },
  };
}

function readBatteryPercent(): number | null {
  try {
    const bats = fs.readdirSync("/sys/class/power_supply").filter((d) => /^BAT/.test(d));
    if (!bats.length) return null;
    const raw = readFile(`/sys/class/power_supply/${bats[0]}/capacity`);
    return raw ? parseInt(raw.trim(), 10) : null;
  } catch {
    return null;
  }
}

let cache: SystemSnapshot | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 500;

export async function getSnapshotLinux(): Promise<SystemSnapshot> {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  const snap = await collectLinux();
  cache = snap;
  cacheAt = Date.now();
  return snap;
}

/**
 * На Linux нет аналога LibreHardwareMonitor/WinRing0 — датчики читаются
 * напрямую из lm-sensors/nvidia-smi без отдельного "движка" и без прав
 * администратора. Эти функции существуют только для сохранения общего
 * контракта вызова из server/routes/meta.js.
 */
export async function lhmStatusLinux(): Promise<{
  wmi: boolean;
  exePath: string | null;
  pid: number | null;
  bundled: boolean;
}> {
  if (sensorsAvailable === null) await readSensorsJson();
  return { wmi: sensorsAvailable === true, exePath: null, pid: null, bundled: false };
}

export async function startLhmLinux(): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  const status = await lhmStatusLinux();
  if (status.wmi) return { ok: true, already: true };
  return {
    ok: false,
    error:
      "linux_no_lhm_equivalent: установите пакет lm-sensors и один раз выполните `sudo sensors-detect`, отдельного запуска движка не требуется",
  };
}

export async function downloadAndStartEngineLinux(): Promise<{
  ok: boolean;
  already?: boolean;
  error?: string;
}> {
  return startLhmLinux();
}

export function stopLhmLinux(): void {
  /* нет фонового процесса, который нужно останавливать */
}

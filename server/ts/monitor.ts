/**
 * Реальный сборщик телеметрии системы (Windows-first).
 *
 * Источники данных (по приоритету):
 *  1) Node os.* — загрузка CPU по ядрам (дельты счётчиков), память, аптайм, хост.
 *     Работает всегда, без зависимостей.
 *  2) Один пакетный WMI-запрос через PowerShell (Get-CimInstance):
 *     - Win32_Processor / Win32_OperatingSystem / Win32_Battery
 *     - Win32_LogicalDisk (объёмы дисков)
 *     - Win32_PerfFormattedData_PerfDisk_PhysicalDisk (скорости чтения/записи)
 *     - Win32_PerfFormattedData_Tcpip_NetworkInterface (скорости сети)
 *     - root/LibreHardwareMonitor (Sensor + Hardware): температуры, вентиляторы,
 *       напряжения, потребление, частоты — данные уровня HWiNFO.
 *     LibreHardwareMonitor опционален: если не запущен, соответствующие поля
 *     просто пустые, остальное работает.
 *  3) nvidia-smi (если есть в PATH): утилизация/температура/память/fan/power GPU.
 *
 * Дорогие вызовы кэшируются (мин. интервал + дедупликация одновременных запросов).
 */
import { execFile, exec } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import settings from "./settings";
import logger from "./logger";

/* ----------------------------- Публичные типы ---------------------------- */

export interface TempSensor { id: string; name: string; hw: string; value: number | null }
export interface FanSensor { name: string; hw: string; rpm: number | null }
export interface ValueSensor { name: string; hw: string; value: number | null }
export interface GpuInfo {
  name: string;
  utilizationPercent: number | null;
  temperatureC: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  fanPercent: number | null;
  powerWatt: number | null;
}
export interface DiskInfo {
  drive: string; label: string;
  totalGb: number | null; freeGb: number | null;
  readMBs: number | null; writeMBs: number | null;
}
export interface NetIfaceInfo { name: string; rxKBs: number | null; txKBs: number | null; ipv4: string[]; mac: string }

export interface SystemSnapshot {
  timestamp: string;
  cpu: {
    model: string;
    coresPhysical: number | null;
    coresLogical: number;
    baseClockMhz: number | null;
    loadTotalPercent: number;
    loadPerCorePercent: number[];
    temperatureC: number | null;
    powerWatt: number | null;
    clockMhz: number | null;
  };
  memory: { totalMb: number; usedMb: number; freeMb: number; usedPercent: number };
  gpu: GpuInfo[];
  temperatures: TempSensor[];
  fans: FanSensor[];
  voltages: ValueSensor[];
  currents: ValueSensor[];
  powers: ValueSensor[];
  clocks: ValueSensor[];
  /** Полный срез сенсоров по железу (для дерева датчиков HWiNFO-стиля). */
  sensorsAll: { id: string; name: string; type: string; parent: string; hw: string; value: number | null }[];
  hardware: { id: string; name: string; type: string }[];
  disks: DiskInfo[];
  network: NetIfaceInfo[];
  system: {
    hostname: string; arch: string; platform: string;
    osName: string; osVersion: string; osBuild: string;
    uptimeSec: number; batteryPercent: number | null;
  };
  sources: { wmi: boolean; lhm: boolean; nvidiaSmi: boolean };
}

/* --------------------------------- Утилиты -------------------------------- */

type Row = Record<string, unknown>;

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function toArray<T>(x: T | T[] | null | undefined): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/** Запуск PowerShell-скрипта с таймаутом; stdout c фолбэком кодировки (кириллица). */
function execPs(script: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "buffer" },
      (err, stdout) => {
        if (err) return reject(err);
        const buf = Buffer.from(stdout as unknown as Uint8Array);
        let text = buf.toString("utf8");
        // Windows PowerShell может отдать OEM/ANSI — если utf8 битый, перекодируем.
        if (text.includes("\uFFFD")) text = new TextDecoder("windows-1251").decode(buf);
        resolve(text);
      }
    );
    // На Windows kill() дочернего процесса срабатывает не всегда, а при частом
    // опросе датчиков зависшие powershell.exe копились бы (утечка процессов и
    // памяти). Если процесс не закрылся к таймауту+запас — добиваем дерево по PID.
    const killTree = (): void => {
      try { if (child.pid) exec(`taskkill /PID ${child.pid} /T /F`, { windowsHide: true }, () => { /* ignore */ }); } catch { /* ignore */ }
    };
    const killTimer = setTimeout(killTree, timeoutMs + 500);
    const clear = (): void => clearTimeout(killTimer);
    child.once("close", clear);
    child.once("error", clear);
  });
}

/* --------------------- Загрузка CPU по ядрам (os.cpus) -------------------- */

/**
 * Фоновый сэмплер: замеряет загрузку в СТРОГО фиксированном ритме
 * (окно 200 мс каждые 250 мс) и сглаживает EMA. Раньше замер вызывался
 * из каждого запроса API и из медленного WMI-сбора — окна наезжали друг
 * на друга, значения дёргались, зависали и обновлялись в произвольные моменты.
 */
interface CoreSample { idle: number; total: number }
const SAMPLE_INTERVAL_MS = 250;
const SAMPLE_WINDOW_MS = 200;
const EMA_ALPHA = 0.45; // вклад нового замера в сглаженное значение

let latestLoad: { totalPercent: number; perCorePercent: number[] } = { totalPercent: 0, perCorePercent: [] };
let samplerStarted = false;

function coreTimes(): CoreSample[] {
  return os.cpus().map((c) => ({
    idle: c.times.idle,
    total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq,
  }));
}

async function samplerLoop(): Promise<void> {
  let prev = coreTimes();
  let emaTotal = 0;
  let emaPer: number[] = [];
  while (true) {
    await sleep(SAMPLE_WINDOW_MS);
    const cur = coreTimes();
    if (cur.length === prev.length && prev.length > 0) {
      let dIdle = 0;
      let dTotal = 0;
      const rawPer = cur.map((c, i) => {
        const di = c.idle - prev[i].idle;
        const dt = c.total - prev[i].total;
        dIdle += di;
        dTotal += dt;
        return dt > 0 ? Math.max(0, Math.min(100, 100 * (1 - di / dt))) : 0;
      });
      const rawTotal = dTotal > 0 ? Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal))) : 0;
      // EMA убирает дрожание между кадрами UI.
      emaPer = rawPer.map((v, i) => (emaPer.length === rawPer.length ? emaPer[i] + EMA_ALPHA * (v - emaPer[i]) : v));
      emaTotal = emaTotal + EMA_ALPHA * (rawTotal - emaTotal);
      latestLoad = {
        totalPercent: Math.round(emaTotal),
        perCorePercent: emaPer.map((v) => Math.round(v)),
      };
    }
    prev = cur;
    await sleep(Math.max(0, SAMPLE_INTERVAL_MS - SAMPLE_WINDOW_MS));
  }
}

function ensureSampler(): void {
  if (samplerStarted) return;
  samplerStarted = true;
  void samplerLoop();
}
ensureSampler();


/* --------------------------- Пакетный WMI-опрос --------------------------- */

/** Один вызов PowerShell собирает ВСЕ WMI-источники разом (дешевле, чем 6 отдельных). */
function wmiScript(): string {
  return [
    // Кириллица в именах ОС/устройств: принудительно UTF-8 на stdout.
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$ErrorActionPreference='SilentlyContinue'",
    "$out=[ordered]@{}",
    "$out.os=Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber",
    "$out.cpu=Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed",
    "$out.battery=Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining",
    "$out.disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,Size,FreeSpace)",
    "$out.diskperf=@(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object {$_.Name -ne '_Total'} | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec)",
    "$out.netperf=@(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Where-Object {$_.Name -notmatch 'Loopback|isatap|Teredo'} | Select-Object Name,BytesReceivedPersec,BytesSentPersec)",
    "$out.lhw=@(Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Hardware | Select-Object Identifier,Name)",
    "$out.lsen=@(Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor | Select-Object Identifier,Name,SensorType,Parent,Value)",
    "ConvertTo-Json $out -Compress -Depth 4",
  ].join("; ");
}

interface WmiBatch {
  os?: Row; cpu?: Row; battery?: Row;
  disks?: Row[] | Row; diskperf?: Row[] | Row; netperf?: Row[] | Row;
  lhw?: Row[] | Row; lsen?: Row[] | Row;
}

async function queryWmi(): Promise<WmiBatch | null> {
  try {
    const stdout = await execPs(wmiScript(), 12000);
    const start = stdout.indexOf("{");
    if (start < 0) return null;
    return JSON.parse(stdout.slice(start)) as WmiBatch;
  } catch {
    return null;
  }
}

/* -------------------- Разбор сенсоров LibreHardwareMonitor ---------------- */

interface LhmSensors {
  temperatures: TempSensor[];
  fans: FanSensor[];
  voltages: ValueSensor[];
  currents: ValueSensor[];
  powers: ValueSensor[];
  clocks: ValueSensor[];
  loads: { name: string; hw: string; percent: number | null }[];
  data: { name: string; hw: string; value: number | null }[];
  /** Плоский срез ВСЕХ сенсоров — для дерева датчиков на фронтенде. */
  all: { id: string; name: string; type: string; parent: string; hw: string; value: number | null }[];
}

function parseLhm(lsen: Row[], lhw: Row[]): LhmSensors {
  const hwNames = new Map<string, string>();
  for (const h of lhw) hwNames.set(str(h.Identifier), str(h.Name));
  const hwOf = (parent: string): string => {
    if (hwNames.has(parent)) return hwNames.get(parent)!;
    // parent вида "/intelcpu/0/0" — ищем ближайший префикс
    const parts = parent.split("/").filter(Boolean);
    while (parts.length > 0) {
      parts.pop();
      const key = "/" + parts.join("/");
      if (hwNames.has(key)) return hwNames.get(key)!;
    }
    return parent || "?";
  };

  const out: LhmSensors = { temperatures: [], fans: [], voltages: [], currents: [], powers: [], clocks: [], loads: [], data: [], all: [] };
  const seenIds = new Set<string>();
  for (const s of lsen) {
    if (str(s.SensorType) === "__hwname__") continue; // служебная строка движка
    const id = str(s.Identifier);
    // Один и тот же сенсор может прийти дважды — от самого адаптера и от его
    // sub-hardware (напр. /gpu-nvidia/0/load/3). Дубли ломают уникальность
    // React-ключей в списках датчиков — оставляем только первое вхождение.
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    const name = str(s.Name);
    const type = str(s.SensorType);
    const hw = hwOf(str(s.Parent));
    const value = num(s.Value);
    out.all.push({ id, name, type, parent: str(s.Parent), hw, value });
    if (type === "Temperature") out.temperatures.push({ id, name, hw, value });
    else if (type === "Fan") out.fans.push({ name, hw, rpm: value });
    else if (type === "Voltage") out.voltages.push({ name, hw, value });
    else if (type === "Current") out.currents.push({ name, hw, value });
    else if (type === "Power") out.powers.push({ name, hw, value });
    else if (type === "Clock") out.clocks.push({ name, hw, value });
    else if (type === "Load") out.loads.push({ name, hw, percent: value });
    else if (type === "Data" || type === "SmallData") out.data.push({ name, hw, value });
  }
  return out;
}

function pickCpuTemp(temps: TempSensor[]): number | null {
  const cpuTemps = temps.filter((t) => /cpu|intelcpu|amdcpu/i.test(t.id + " " + t.hw));
  const preferred =
    cpuTemps.find((t) => /package/i.test(t.name)) ||
    cpuTemps.find((t) => /tctl|tdie|ccdit/i.test(t.name)) ||
    cpuTemps.find((t) => /^core (\(max\)|avg|max)/i.test(t.name)) ||
    cpuTemps[0];
  return preferred ? preferred.value : temps[0]?.value ?? null;
}

function pickCpuPower(powers: ValueSensor[]): number | null {
  const p =
    powers.find((x) => /package/i.test(x.name) && /cpu/i.test(x.hw)) ||
    powers.find((x) => /cpu/i.test(x.name) || /cpu/i.test(x.hw));
  return p ? p.value : null;
}

function pickCpuClock(clocks: ValueSensor[]): number | null {
  const coreClocks = clocks.filter((c) => /core/i.test(c.name) && /cpu/i.test(c.hw));
  const list = coreClocks.length ? coreClocks : clocks.filter((c) => /cpu/i.test(c.hw));
  let max: number | null = null;
  for (const c of list) if (c.value != null && (max == null || c.value > max)) max = c.value;
  return max;
}

/**
 * Фолбэк температур БЕЗ LibreHardwareMonitor: ACPI Thermal Zone через WMI
 * (root/wmi → MSAcpi_ThermalZoneTemperature). Есть на большинстве плат,
 * но обычно это зона материнской платы/CPU с грубой точностью (~±3°C).
 * CurrentTemperature — десятые доли Кельвина.
 */
async function queryAcpiTemps(): Promise<TempSensor[]> {
  try {
    const out = await execPs(
      "Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature " +
      "| Select-Object InstanceName,CurrentTemperature | ConvertTo-Json -Compress",
      5000
    );
    const rows = toArray<Row>(JSON.parse(out || "[]"));
    const temps: TempSensor[] = [];
    for (const r of rows) {
      const raw = num(r.CurrentTemperature);
      if (raw == null) continue;
      const celsius = Math.round((raw / 10 - 273.15) * 10) / 10;
      // Отсекаем мусор (датчики могут отдавать 0 K или нереальные значения)
      if (celsius < -20 || celsius > 120) continue;
      const name = str(r.InstanceName) || "Thermal Zone";
      temps.push({ id: `acpi:${name}`, name, hw: "ACPI", value: celsius });
    }
    return temps;
  } catch {
    return [];
  }
}

/**
 * Кэш ACPI-температур. Это PowerShell-запрос, а вызывается он на КАЖДОМ цикле
 * сбора, когда LibreHardwareMonitor не установлен. Без кэша при частом опросе
 * (monitor.refreshMs может быть 100 мс) powershell.exe запускался бы почти
 * непрерывно. ACPI-зоны грубые (±3°C), поэтому TTL 5 с не влияет на общую
 * картину, но снимает нагрузку. In-flight дедупликация не даёт двум
 * одновременным collect() запустить два PowerShell-процесса.
 */
let acpiCache: TempSensor[] | null = null;
let acpiAt = 0;
let acpiPending: Promise<TempSensor[]> | null = null;
const ACPI_TTL_MS = 5000;

async function getCachedAcpiTemps(): Promise<TempSensor[]> {
  if (acpiCache && Date.now() - acpiAt < ACPI_TTL_MS) return acpiCache;
  if (acpiPending) return acpiPending;
  acpiPending = queryAcpiTemps()
    .then((t) => { acpiCache = t; acpiAt = Date.now(); return t; })
    .finally(() => { acpiPending = null; });
  return acpiPending;
}

/* ------------------------------- GPU: nvidia-smi -------------------------- */

async function queryNvidiaGpus(): Promise<GpuInfo[] | null> {
  const query = "name,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw";
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("nvidia-smi", ["--query-gpu=" + query, "--format=csv,noheader,nounits"],
        { timeout: 5000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(out || "")));
    });
    const gpus: GpuInfo[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const cols = line.split(",").map((c) => c.trim());
      if (cols.length < 7 || !cols[0]) continue;
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

/** Fallback: собрать GPU-инфо из сенсоров LHM (когда nvidia-smi недоступен). */
function gpuFromLhm(s: LhmSensors): GpuInfo[] {
  const hwKeys = new Set<string>();
  for (const t of [...s.temperatures, ...s.fans, ...s.loads]) {
    const idPart = "id" in t ? String((t as TempSensor).id) : "";
    if (/gpu|nvidia|radeon|amd/i.test(t.hw + " " + idPart)) hwKeys.add(t.hw);
  }
  const gpus: GpuInfo[] = [];
  for (const hw of hwKeys) {
    const memUsed = s.data.find((d) => d.hw === hw && /memory used/i.test(d.name));
    const memTotal = s.data.find((d) => d.hw === hw && /memory total/i.test(d.name));
    const toMb = (v: number | null): number | null =>
      v == null ? null : v > 1e6 ? Math.round(v / (1024 * 1024)) : Math.round(v);
    gpus.push({
      name: hw,
      utilizationPercent:
        s.loads.find((l) => l.hw === hw && /core/i.test(l.name))?.percent ??
        s.loads.find((l) => l.hw === hw)?.percent ?? null,
      temperatureC: s.temperatures.find((t) => t.hw === hw)?.value ?? null,
      memoryUsedMb: toMb(memUsed?.value ?? null),
      memoryTotalMb: toMb(memTotal?.value ?? null),
      fanPercent: s.fans.find((f) => f.hw === hw)?.rpm ?? null,
      powerWatt: s.powers.find((p) => p.hw === hw)?.value ?? null,
    });
  }
  return gpus;
}

/* ------------------------------ Сборка снапшота --------------------------- */

function buildDisks(wmi: WmiBatch | null): DiskInfo[] {
  const perfByDrive = new Map<string, { readMBs: number | null; writeMBs: number | null }>();
  for (const p of toArray(wmi?.diskperf)) {
    const m = str(p.Name).match(/([A-Za-z]):/);
    if (!m) continue;
    perfByDrive.set(m[1].toUpperCase() + ":", {
      readMBs: num(p.DiskReadBytesPersec),
      writeMBs: num(p.DiskWriteBytesPersec),
    });
  }
  return toArray(wmi?.disks).map((d) => {
    const drive = str(d.DeviceID).toUpperCase();
    const perf = perfByDrive.get(drive);
    const sizeB = num(d.Size), freeB = num(d.FreeSpace);
    return {
      drive,
      label: str(d.VolumeName) || drive,
      totalGb: sizeB != null ? +(sizeB / 1024 ** 3).toFixed(1) : null,
      freeGb: freeB != null ? +(freeB / 1024 ** 3).toFixed(1) : null,
      readMBs: perf?.readMBs != null ? +(perf.readMBs / 1024 ** 2).toFixed(2) : null,
      writeMBs: perf?.writeMBs != null ? +(perf.writeMBs / 1024 ** 2).toFixed(2) : null,
    };
  });
}

function buildNetwork(wmi: WmiBatch | null): NetIfaceInfo[] {
  // IPv4/MAC из Node сопоставляем с WMI-именем по подстроке (совпадает частично).
  const nodeIfaces = os.networkInterfaces();
  return toArray(wmi?.netperf).map((n) => {
    const wname = str(n.Name);
    let ipv4: string[] = [];
    let mac = "";
    for (const [key, addrs] of Object.entries(nodeIfaces)) {
      if (wname.toLowerCase().includes(key.toLowerCase())) {
        ipv4 = (addrs || []).filter((a) => a.family === "IPv4").map((a) => a.address);
        mac = (addrs || [])[0]?.mac || "";
        break;
      }
    }
    const rx = num(n.BytesReceivedPersec), tx = num(n.BytesSentPersec);
    return {
      name: wname,
      rxKBs: rx != null ? +(rx / 1024).toFixed(1) : null,
      txKBs: tx != null ? +(tx / 1024).toFixed(1) : null,
      ipv4, mac,
    };
  });
}

/* --------- Кэш WMI (медленный PowerShell) — обновляем реже, чем датчики ------- */
let wmiCache: Awaited<ReturnType<typeof queryWmi>> | null = null;
let wmiAt = 0;
let wmiPending: ReturnType<typeof queryWmi> | null = null;
const WMI_TTL_MS = 3000;

async function getCachedWmi() {
  if (wmiCache && Date.now() - wmiAt < WMI_TTL_MS) return wmiCache;
  // Дедупликация одновременных запросов: иначе фоновый цикл сбора и запрос
  // /api/monitor могли запустить два PowerShell-опроса параллельно.
  if (wmiPending) return wmiPending;
  wmiPending = queryWmi()
    .then((r) => { wmiCache = r; wmiAt = Date.now(); return r; })
    .finally(() => { wmiPending = null; });
  return wmiPending;
}

let nvCache: Awaited<ReturnType<typeof queryNvidiaGpus>> | null = null;
let nvAt = 0;
let nvPending: ReturnType<typeof queryNvidiaGpus> | null = null;
const NV_TTL_MS = 2000;

async function getCachedNvidia() {
  if (nvCache && Date.now() - nvAt < NV_TTL_MS) return nvCache;
  if (nvPending) return nvPending;
  nvPending = queryNvidiaGpus()
    .then((r) => { nvCache = r; nvAt = Date.now(); return r; })
    .finally(() => { nvPending = null; });
  return nvPending;
}

async function collect(): Promise<SystemSnapshot> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  const [wmi, nvGpus] = await Promise.all([getCachedWmi(), getCachedNvidia()]);
  // Приоритет сенсоров: наш headless-движок (GitHub-библиотека) → установленный
  // LibreHardwareMonitor (WMI). Диски/сеть/ОС WMI даёт в обоих случаях.
  const engine = readEngineSensors();
  const engineLhw = engine ? engine.lhw : [];
  const lhm = parseLhm(
    engine ? engine.lsen : toArray(wmi?.lsen),
    engine ? engineLhw : toArray(wmi?.lhw)
  );
  const hardware: { id: string; name: string; type: string }[] =
    engine?.hwlist ??
    toArray(wmi?.lhw).map((h) => ({ id: str(h.Identifier), name: str(h.Name), type: "" }));

  const gpu: GpuInfo[] = nvGpus ?? gpuFromLhm(lhm);

  // Если LHM не даёт температур — пробуем ACPI Thermal Zone (без установки ПО).
  let temperatures = lhm.temperatures;
  if (temperatures.length === 0) temperatures = await getCachedAcpiTemps();

  const totalMb = Math.round(totalMem / 1024 ** 2);
  const usedMb = Math.round((totalMem - freeMem) / 1024 ** 2);
  const batteryRaw = wmi?.battery ? (wmi.battery as Row) : null;

  return {
    timestamp: new Date().toISOString(),
    cpu: {
      model: str(wmi?.cpu?.Name) || cpusModel(),
      coresPhysical: num(wmi?.cpu?.NumberOfCores),
      coresLogical: os.cpus().length,
      baseClockMhz: num(wmi?.cpu?.MaxClockSpeed),
      // Нагрузку подставляет computeFast() из фонового сэмплера — здесь заглушки.
      loadTotalPercent: 0,
      loadPerCorePercent: [],
      temperatureC: pickCpuTemp(temperatures),
      powerWatt: pickCpuPower(lhm.powers),
      clockMhz: pickCpuClock(lhm.clocks) ?? num(wmi?.cpu?.MaxClockSpeed),
    },
    memory: {
      totalMb, usedMb,
      freeMb: Math.round(freeMem / 1024 ** 2),
      usedPercent: totalMb > 0 ? Math.round((100 * usedMb) / totalMb) : 0,
    },
    gpu,
    temperatures,
    fans: lhm.fans,
    voltages: lhm.voltages,
    currents: lhm.currents,
    powers: lhm.powers,
    clocks: lhm.clocks,
    sensorsAll: lhm.all,
    hardware,
    disks: buildDisks(wmi),
    network: buildNetwork(wmi),
    system: {
      hostname: os.hostname(),
      arch: os.arch(),
      platform: os.platform(),
      osName: str(wmi?.os?.Caption) || "Windows",
      osVersion: str(wmi?.os?.Version),
      osBuild: str(wmi?.os?.BuildNumber),
      uptimeSec: Math.round(os.uptime()),
      batteryPercent: batteryRaw ? num(batteryRaw.EstimatedChargeRemaining) : null,
    },
    sources: { wmi: !!wmi, lhm: engine !== null || toArray(wmi?.lsen).length > 0, nvidiaSmi: !!nvGpus },
  };
}

let modelCache = "";
function cpusModel(): string {
  if (!modelCache) modelCache = os.cpus()[0]?.model || "Unknown CPU";
  return modelCache;
}

/* --------- Кэш «медленных» данных + быстрый оверлей (без фризов) ---------- */

/**
 * Раньше /api/monitor ждал завершения WMI-опроса (0.3–3 с) — каждые ~2 секунды
 * числа замирали ровно на время запроса. Теперь сбор идёт в фоновом цикле,
 * а обработчик запроса мгновенно отдаёт последний снимок со свежей загрузкой CPU.
 */

function sensorPollMs(): number {
  const cfg = (settings.get("monitor") || {}) as { refreshMs?: number };
  const ms = cfg.refreshMs;
  const n = typeof ms === "number" ? ms : parseInt(String(ms || ""), 10);
  return Math.min(1000, Math.max(100, Number.isFinite(n) ? n : 500));
}

let slowStarted = false;
let slowCache: SystemSnapshot | null = null;
let slowAt = 0;

function ensureSlowLoop(): void {
  if (slowStarted) return;
  slowStarted = true;
  void (async () => {
    while (true) {
      try {
        const snap = await collect();
        slowCache = snap;
        slowAt = Date.now();
      } catch (e) {
        logger.warn("monitor.slow_error", { error: (e as Error).message });
      }
      await sleep(sensorPollMs());
    }
  })();
}

function computeFast(base: SystemSnapshot): SystemSnapshot {
  const load = latestLoad; // фиксированный ритм сэмплера, EMA-сглаживание
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const totalMb = Math.round(totalMem / 1024 ** 2);
  const usedMb = Math.round((totalMem - freeMem) / 1024 ** 2);
  return {
    ...base,
    timestamp: new Date().toISOString(),
    cpu: {
      ...base.cpu,
      loadTotalPercent: load.totalPercent,
      loadPerCorePercent: load.perCorePercent,
    },
    memory: {
      totalMb,
      usedMb,
      freeMb: Math.round(freeMem / 1024 ** 2),
      usedPercent: totalMb > 0 ? Math.round((100 * usedMb) / totalMb) : 0,
    },
  };
}

/** Мгновенный снимок: свежая нагрузка CPU/RAM + кэшированные сенсоры. */
export function getSnapshot(_legacyMinAgeMs = 900): Promise<SystemSnapshot> {
  ensureSlowLoop();
  if (slowCache && Date.now() - slowAt < 15000) return Promise.resolve(computeFast(slowCache));
  // Первый вызов после старта процесса — единственный раз ждём первичный сбор.
  return collect().then((base) => {
    slowCache = base;
    slowAt = Date.now();
    return computeFast(base);
  });
}

/* ------------------- LibreHardwareMonitor: автоуправление ------------------ */

let lhmPid: number | null = null;

const LHM_EXE = "LibreHardwareMonitor.exe";
// Headless-движок на библиотеке из официального репозитория
// https://github.com/LibreHardwareMonitor/LibreHardwareMonitor (MPL-2.0).
// Библиотека ВСТРОЕНА в проект: server/vendor/lhm — пользователю ничего
// скачивать не нужно. Скачивание остаётся только как dev-фолбэк.
// DLL читаются из vendor; генерируемые артефакты (engine.ps1, sensors.json,
// pid.txt) пишутся в storage/bin/lhm — там точно можно писать и вне asar.
const VENDOR_DIR = path.join(__dirname, "..", "vendor", "lhm");
const BIN_DIR = path.join(
  process.env.MOONAPP_STORAGE || path.join(__dirname, "..", "storage"),
  "bin", "lhm"
);
function resolveDllDir(): string {
  try {
    if (fs.existsSync(path.join(VENDOR_DIR, "LibreHardwareMonitorLib.dll"))) return VENDOR_DIR;
  } catch { /* ignore */ }
  return BIN_DIR;
}
const ENGINE_DLL = path.join(resolveDllDir(), "LibreHardwareMonitorLib.dll");
const ENGINE_DIR = BIN_DIR;
const ENGINE_OUT = path.join(ENGINE_DIR, "sensors.json");

function engineFilesPresent(): boolean {
  try { return fs.existsSync(ENGINE_DLL); } catch { return false; }
}

/** Ищем установленный GUI-LHM в стандартных местах (альтернативный источник). */
function findLhmExe(): string | null {
  const roots = [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env["LOCALAPPDATA"] && path.join(process.env["LOCALAPPDATA"], "Programs"),
  ].filter((r): r is string => !!r);
  for (const root of roots) {
    const candidate = path.join(root, "LibreHardwareMonitor", LHM_EXE);
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return null;
}

function engineOutputFresh(maxAgeMs = 10000): boolean {
  try { return Date.now() - fs.statSync(ENGINE_OUT).mtimeMs < maxAgeMs; } catch { return false; }
}

/** Файл записан текущей версией схемы (со списком hardware)? */
function engineSchemaCurrent(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(ENGINE_OUT, "utf8"));
    return raw && raw.v === 2;
  } catch { return false; }
}

/**
 * Скачивает релиз LHM с GitHub и извлекает в storage/bin/lhm только нужное:
 * LibreHardwareMonitorLib.dll (+ драйвер WinRing0, если лежит рядом).
 * GUI-программа LibreHardwareMonitor.exe не требуется.
 */
export async function downloadEngine(): Promise<{ ok: boolean; error?: string }> {
  if (engineFilesPresent()) return { ok: true };
  // Резолвим ассет через GitHub API: имена в релизах меняются.
  const apiRes = await fetch(
    "https://api.github.com/repos/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest",
    { headers: { "User-Agent": "MoonApp" }, signal: AbortSignal.timeout(20000) }
  );
  if (!apiRes.ok) return { ok: false, error: `GitHub API HTTP ${apiRes.status}` };
  const meta = await apiRes.json() as { assets?: { name: string; browser_download_url: string }[] };
  const assets = meta.assets || [];
  const asset =
    assets.find((a) => a.name === "LibreHardwareMonitor.zip") ||
    assets.find((a) => /\.zip$/i.test(a.name) && !/NET\s*\.?\s*10/i.test(a.name));
  if (!asset) return { ok: false, error: "no suitable zip in latest release" };

  const zipPath = path.join(ENGINE_DIR, "lhm.zip");
  const tmpDir = path.join(ENGINE_DIR, "tmp");
  try {
    fs.mkdirSync(ENGINE_DIR, { recursive: true });
    logger.info("monitor.lhm_download_start", { url: asset.browser_download_url });
    const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    await execPs(
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`,
      60000
    );
    // Копируем ВСЕ dll/sys из архива: у Lib есть компаньоны
    // (RAMSPDToolkit-NDD, DiskInfoToolkit и т.п.), без которых типы не грузятся.
    const found = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else if (/\.(dll|sys)$/i.test(name) && !found.has(name)) found.set(name, full);
      }
    };
    walk(tmpDir);
    for (const [name, src] of found) fs.copyFileSync(src, path.join(ENGINE_DIR, name));
    if (!fs.existsSync(ENGINE_DLL)) throw new Error("LibreHardwareMonitorLib.dll not found in archive");
    logger.info("monitor.lhm_download_ok", {});
    return { ok: true };
  } catch (e) {
    logger.warn("monitor.lhm_download_failed", { error: (e as Error).message });
    return { ok: false, error: (e as Error).message };
  } finally {
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}


/**
 * Отвечает ли WMI-пространство root/LibreHardwareMonitor.
 * Это PowerShell-запрос, а вызывается он и из lhmStatus() (UI опрашивает статус
 * каждые 5 с), и из автозапуска. Кэш 10 с убирает лишние спавны; force=true
 * используется там, где мы ЖДЁМ появления LHM (startLhm) — там нужна свежесть.
 */
const LHM_ALIVE_TTL_MS = 10000;
let lhmAliveCache = false;
let lhmAliveAt = 0;
let lhmAlivePending: Promise<boolean> | null = null;

async function probeLhmWmi(): Promise<boolean> {
  try {
    const out = await execPs(
      "(Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor | Measure-Object).Count",
      4000
    );
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) && n > 0;
  } catch {
    return false;
  }
}

async function lhmWmiAlive(force = false): Promise<boolean> {
  if (!force) {
    if (lhmAliveAt && Date.now() - lhmAliveAt < LHM_ALIVE_TTL_MS) return lhmAliveCache;
    if (lhmAlivePending) return lhmAlivePending;
  }
  const run = probeLhmWmi().then((v) => { lhmAliveCache = v; lhmAliveAt = Date.now(); return v; });
  if (force) return run;
  lhmAlivePending = run.finally(() => { lhmAlivePending = null; });
  return lhmAlivePending;
}

/**
 * PowerShell-скрипт headless-движка: загружает библиотеку из GitHub-релиза,
 * раз в ~0.9 с обновляет сенсоры и пишет их в sensors.json. GUI не нужен.
 */
function writeEngineScript(): void {
  const dll = ENGINE_DLL.replace(/'/g, "''");
  const out = ENGINE_OUT.replace(/'/g, "''");
  const interval = sensorPollMs();
  const script = `
$ErrorActionPreference = 'Stop'
# Убиваем предыдущий экземпляр движка (мы запущены с теми же правами).
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*engine.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Add-Type -Path '${dll}'

$comp = New-Object LibreHardwareMonitor.Hardware.Computer
$comp.IsCpuEnabled = $true
$comp.IsGpuEnabled = $true
$comp.IsMemoryEnabled = $true
$comp.IsMotherboardEnabled = $true
$comp.IsStorageEnabled = $true
$comp.IsNetworkEnabled = $false
$comp.IsControllerEnabled = $false
$comp.IsPsuEnabled = $true
$comp.Open()
$out = '${out}'
$culture = [System.Globalization.CultureInfo]::InvariantCulture
while ($true) {
  try {
    foreach ($hw in $comp.Hardware) {
      $hw.Update()
      foreach ($sub in @($hw.SubHardware)) { $sub.Update() }
    }
    $rows = @()
    $hwrows = @()
    # Один и тот же сенсор может прийти и от адаптера, и от его sub-hardware
    # (напр. /gpu-nvidia/0/load/3) — дедуплицируем по Identifier.
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($hw in $comp.Hardware) {
      $hwrows += '{"id":"' + (('' + $hw.Identifier).Replace('\\', '\\\\').Replace('"', '\\\\"')) + '","name":"' + (('' + $hw.Name).Replace('\\', '\\\\').Replace('"', '\\\\"')) + '","type":"' + $hw.HardwareType + '"}'
      $items = @($hw) + @($hw.SubHardware)
      foreach ($h in $items) {
        $hid = ('' + $h.Identifier).Replace('\\', '\\\\').Replace('"', '\\\\"')
        foreach ($s in @($h.Sensors)) {
          if ($null -eq $s.Value) { continue }
          $sid = ('' + $s.Identifier).Replace('\\', '\\\\').Replace('"', '\\\\"')
          if (-not $seen.Add($sid)) { continue }
          $sname = ('' + $s.Name).Replace('\\', '\\\\').Replace('"', '\\\\"')
          $valStr = ([double]$s.Value).ToString('R', $culture)
          $rows += '{"id":"' + $sid + '","name":"' + $sname + '","type":"' + $s.SensorType + '","parent":"' + $hid + '","value":' + $valStr + '}'
        }
      }
    }
$json = '{"v":2,"ts":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"hardware":[' + ($hwrows -join ',') + '],"sensors":[' + ($rows -join ',') + ']}'
    
[System.IO.File]::WriteAllText($out, $json)
    
  } catch { }
  Start-Sleep -Milliseconds ${interval}
}
`;
  fs.writeFileSync(path.join(ENGINE_DIR, "engine.ps1"), script.trimStart(), "utf8");
}

/** Запуск headless-движка (нужен UAC — загрузка драйвера WinRing0). */
export async function startEngine(timeoutMs = 30000): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  if (engineOutputFresh() && engineSchemaCurrent()) return { ok: true, already: true };
  if (!engineFilesPresent()) return { ok: false, error: "not_downloaded" };

  writeEngineScript();
  // Убедимся, что драйвер есть: если в архиве его не было, возьмём из установленного LHM
  if (!fs.existsSync(path.join(ENGINE_DIR, "WinRing0x64.sys"))) {
    const exeDir = findLhmExe();
    if (exeDir) {
      for (const f of ["WinRing0x64.sys", "WinRing0x64.dll"]) {
        const src = path.join(path.dirname(exeDir), f);
        try { if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ENGINE_DIR, f)); } catch { /* ignore */ }
      }
    }
  }

  const runner = path.join(ENGINE_DIR, "engine.ps1");
  const ps =
    "$p=Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','" +
    runner.replace(/'/g, "''") +
    "' -Verb RunAs -WindowStyle Hidden -PassThru; $p.Id";
  try {
    const out = await execPs(ps, 30000);
    const parsed = parseInt(out.trim().split(/\r?\n/).pop() || "", 10);
    lhmPid = Number.isFinite(parsed) ? parsed : null;
    // PID на диск: чтобы остановить движок даже после перезапуска приложения.
    try {
      if (lhmPid != null) fs.writeFileSync(path.join(ENGINE_DIR, "pid.txt"), String(lhmPid), "utf8");
    } catch { /* ignore */ }
  } catch {
    return { ok: false, error: "elevation_denied_or_failed" };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(700);
    if (engineOutputFresh()) return { ok: true };
  }
  return { ok: false, error: "timeout_waiting_sensors" };
}

/**
 * Кэш разбора sensors.json (~350 мс). Фоновый сбор может вызываться по
 * monitor.refreshMs (вплоть до 100 мс), а движок переписывает файл лишь раз в
 * ~0.9 с — без кэша мы бы парсили ~22 КБ JSON десятки раз в секунду впустую.
 * На «свежесть» это не влияет: движок всё равно отдаёт новые данные реже.
 */
let engineReadAt = 0;
let engineReadCache: {
  lsen: Row[]; lhw: Row[]; hwlist: { id: string; name: string; type: string }[];
} | null = null;
const ENGINE_READ_TTL_MS = 350;

function readEngineSensors(): {
  lsen: Row[]; lhw: Row[]; hwlist: { id: string; name: string; type: string }[];
} | null {
  if (Date.now() - engineReadAt < ENGINE_READ_TTL_MS) return engineReadCache;
  engineReadAt = Date.now();
  engineReadCache = parseEngineSensors();
  return engineReadCache;
}

function parseEngineSensors(): {
  lsen: Row[]; lhw: Row[]; hwlist: { id: string; name: string; type: string }[];
} | null {
  if (!engineOutputFresh() || !engineSchemaCurrent()) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(ENGINE_OUT, "utf8")) as {
      hardware?: { id: string; name: string; type: string }[];
      sensors: { id: string; name: string; type: string; parent: string; value: number }[];
    };
    const lsen: Row[] = [];
    for (const s of raw.sensors || []) {
      lsen.push({ Identifier: s.id, Name: s.name, SensorType: s.type, Parent: s.parent, Value: s.value });
    }
    const hwlist = (raw.hardware || []).map((h) => ({
      id: h.id,
      name: h.name || h.id.replace(/^\//, "").replace(/\/\d+$/, ""),
      type: h.type || "",
    }));
    const lhw: Row[] = hwlist.map((h) => ({ Identifier: h.id, Name: h.name }));
    return { lsen, lhw, hwlist };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Статус для UI: установлен? отвечает WMI? запущен нами? скачан ли движок? */
export async function lhmStatus(): Promise<{
  wmi: boolean; exePath: string | null; pid: number | null; bundled: boolean;
}> {
  const wmi = await lhmWmiAlive();
  return { wmi, exePath: findLhmExe(), pid: lhmPid, bundled: engineFilesPresent() };
}

/** Скачать движок с GitHub и сразу запустить. */
export async function downloadAndStartEngine(): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  const dl = await downloadEngine();
  if (!dl.ok) return dl;
  return startEngine();
}

/**
 * Запуск LHM (нужны права администратора — появится UAC-запрос).
 * Окно скрываем; ждём появления WMI-пространства до timeoutMs.
 */
export async function startLhm(timeoutMs = 25000): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  if (await lhmWmiAlive(true)) return { ok: true, already: true };

  const exe = findLhmExe();
  if (!exe) return { ok: false, error: "not_installed" };

  // RunAs → UAC; WindowStyle Hidden — окно не будет мешать.
  const script = "$p=Start-Process -FilePath '" + exe.replace(/'/g, "''") +
    "' -Verb RunAs -WindowStyle Hidden -PassThru; $p.Id";
  let pid: number | null = null;
  try {
    const out = await execPs(script, 30000);
    const parsed = parseInt(out.trim().split(/\r?\n/).pop() || "", 10);
    // pid остаётся null, если PowerShell не вернул числовой Id.
    if (Number.isFinite(parsed)) pid = parsed;
  } catch {
    return { ok: false, error: "elevation_denied_or_failed" };
  }
  lhmPid = pid;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(700);
    if (await lhmWmiAlive(true)) return { ok: true };
  }
  return { ok: false, error: "timeout_waiting_wmi" };
}

/** Остановить запущенный нами LHM (вызывается при выходе из приложения). */
export function stopLhm(): void {
  const pids: number[] = [];
  if (lhmPid != null) pids.push(lhmPid);
  lhmPid = null;
  // Плюс PID с прошлого запуска приложения, если остался.
  const pidFile = path.join(ENGINE_DIR, "pid.txt");
  try {
    const saved = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isFinite(saved) && !pids.includes(saved)) pids.push(saved);
    fs.rmSync(pidFile, { force: true });
  } catch { /* нет файла — ок */ }
  for (const pid of pids) {
    try {
      // /T — вместе с дочерними процессами, /F — принудительно.
      exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true }, () => { /* ignore */ });
      logger.info("monitor.lhm_stopped", { pid });
    } catch { /* ignore */ }
  }
}

/**
 * Автозапуск при старте приложения: если включён в настройках, LHM
 * установлен и ещё не отвечает — поднимаем его в фоне.
 */
export function autoStartLhmIfConfigured(): void {
  void (async () => {
    try {
      const cfg = settings.get("monitor") || {};
      if (cfg.lhmAutoStart === false) return;
      if (await lhmWmiAlive()) return;
      let st: { ok: boolean; error?: string };
      if (engineOutputFresh()) return;
      if (engineFilesPresent()) st = await startEngine();
      else if (findLhmExe()) st = await startLhm();
      else return; // не установлен и не скачан — пользователь увидит карточку в UI
      logger.info("monitor.lhm_autostart", { ...st });
    } catch (e) {
      logger.warn("monitor.lhm_autostart_error", { error: (e as Error).message });
    }
  })();
}







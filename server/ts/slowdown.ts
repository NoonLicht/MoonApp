/**
 * «Расследование тормозов»: ~30 секунд замеров (процессор, память, диск и
 * загрузка по процессам) и вывод «кто, когда, почему». Здесь — чистый анализ
 * замеров; сбор делает routes/slowdown.ts.
 */

export interface ProcSample {
  name: string;
  /** Загрузка в % одного ядра (может быть > 100). */
  cpu: number;
  /** Дисковый обмен процесса, МБ/с. */
  ioMbs: number;
  /** Приватная память, МБ. */
  memMb: number;
}

export interface Sample {
  /** Секунды от начала замера. */
  t: number;
  cpuTotal: number;
  memAvailMb: number;
  /** Загрузка диска, %. */
  diskPct: number;
  diskQueue: number;
  procs: ProcSample[];
}

export type Cause = "cpu" | "disk" | "memory" | "none";

export interface Culprit {
  name: string;
  avgCpu: number;
  peakCpu: number;
  avgIoMbs: number;
  memMb: number;
  /** Секунды, когда процесс был на пике. */
  peakAt: number;
}

export interface Finding {
  cause: Cause;
  severity: "low" | "medium" | "high";
  /** Метрики по причине. */
  value: number;
  /** Ключ пояснения («почему»), если процесс известен. */
  why: string | null;
}

export interface Verdict {
  main: Cause;
  findings: Finding[];
  culprits: Culprit[];
  avg: { cpu: number; diskPct: number; memAvailMb: number; diskQueue: number };
  peak: { cpu: number; cpuAt: number; diskPct: number; diskAt: number };
  samples: number;
  seconds: number;
}

/** Известные «виновники»: процесс → причина. */
const KNOWN: [RegExp, string][] = [
  [/^(msmpeng|mpdefendercoreservice|nissrv)/i, "defender"],
  [/^(searchindexer|searchprotocolhost|searchfilterhost)/i, "indexer"],
  [/^(tiworker|trustedinstaller|wuauclt|usoclient|musnotification)/i, "update"],
  [/^(onedrive|dropbox|googledrivefs|yandexdisk)/i, "sync"],
  [/^(system)$/i, "system"],
  [/^(vmmem|vmmemwsl|vboxheadless)/i, "vm"],
  [/^(chrome|msedge|firefox|opera|yandex|brave)/i, "browser"],
  [/^(dwm)$/i, "dwm"],
  [/^(svchost)$/i, "svchost"],
  [/^(wmiprvse)$/i, "wmi"],
  [/^(steam|steamwebhelper|epicgameslauncher)/i, "launcher"],
];

export function whyOf(proc: string): string | null {
  for (const [re, why] of KNOWN) if (re.test(proc)) return why;
  return null;
}

const IGNORE = /^(idle|_total|system idle process|memory compression)$/i;

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (x: number): number => Math.round(x * 10) / 10;

/** Процессы с одинаковым именем (chrome#1, chrome#2) складываются в одно. */
export function baseName(n: string): string {
  return n.replace(/#\d+$/, "");
}

export function analyze(samples: Sample[], o: { totalMemMb?: number } = {}): Verdict {
  const empty: Verdict = {
    main: "none",
    findings: [],
    culprits: [],
    avg: { cpu: 0, diskPct: 0, memAvailMb: 0, diskQueue: 0 },
    peak: { cpu: 0, cpuAt: 0, diskPct: 0, diskAt: 0 },
    samples: 0,
    seconds: 0,
  };
  if (!samples.length) return empty;

  // сводка по процессам
  const agg = new Map<string, { cpu: number[]; io: number[]; mem: number[]; peak: number; peakAt: number }>();
  for (const s of samples) {
    const perName = new Map<string, ProcSample>();
    for (const p of s.procs) {
      if (IGNORE.test(p.name)) continue;
      const n = baseName(p.name);
      const cur = perName.get(n) ?? { name: n, cpu: 0, ioMbs: 0, memMb: 0 };
      cur.cpu += p.cpu;
      cur.ioMbs += p.ioMbs;
      cur.memMb += p.memMb;
      perName.set(n, cur);
    }
    for (const p of perName.values()) {
      const a = agg.get(p.name) ?? { cpu: [], io: [], mem: [], peak: 0, peakAt: 0 };
      a.cpu.push(p.cpu);
      a.io.push(p.ioMbs);
      a.mem.push(p.memMb);
      if (p.cpu > a.peak) {
        a.peak = p.cpu;
        a.peakAt = s.t;
      }
      agg.set(p.name, a);
    }
  }
  const n = samples.length;
  const culprits: Culprit[] = [...agg.entries()].map(([name, a]) => ({
    name,
    // процесс, отсутствовавший в части замеров, считается нулём в этих замерах
    avgCpu: r1(a.cpu.reduce((x, y) => x + y, 0) / n),
    peakCpu: r1(a.peak),
    avgIoMbs: r1(a.io.reduce((x, y) => x + y, 0) / n),
    memMb: Math.round(Math.max(...a.mem)),
    peakAt: a.peakAt,
  }));

  const cpuAvg = avg(samples.map((s) => s.cpuTotal));
  const diskAvg = avg(samples.map((s) => s.diskPct));
  const queueAvg = avg(samples.map((s) => s.diskQueue));
  const memAvg = avg(samples.map((s) => s.memAvailMb));
  const cpuPeakS = samples.reduce((b, s) => (s.cpuTotal > b.cpuTotal ? s : b), samples[0]);
  const diskPeakS = samples.reduce((b, s) => (s.diskPct > b.diskPct ? s : b), samples[0]);

  const topCpu = [...culprits].sort((a, b) => b.avgCpu - a.avgCpu)[0];
  const topIo = [...culprits].sort((a, b) => b.avgIoMbs - a.avgIoMbs)[0];
  const topMem = [...culprits].sort((a, b) => b.memMb - a.memMb)[0];

  const findings: Finding[] = [];
  const sev = (v: number, mid: number, high: number): Finding["severity"] => (v >= high ? "high" : v >= mid ? "medium" : "low");

  if (cpuAvg >= 70 || cpuPeakS.cpuTotal >= 95) {
    findings.push({ cause: "cpu", severity: sev(cpuAvg, 70, 90), value: r1(cpuAvg), why: topCpu ? whyOf(topCpu.name) : null });
  }
  if (diskAvg >= 70 || queueAvg >= 2) {
    findings.push({ cause: "disk", severity: sev(Math.max(diskAvg, queueAvg * 30), 70, 90), value: r1(diskAvg), why: topIo ? whyOf(topIo.name) : null });
  }
  const totalMem = o.totalMemMb ?? 0;
  const lowMem = totalMem > 0 ? memAvg / totalMem < 0.1 : memAvg < 800;
  if (lowMem) {
    findings.push({ cause: "memory", severity: totalMem > 0 && memAvg / totalMem < 0.05 ? "high" : "medium", value: Math.round(memAvg), why: topMem ? whyOf(topMem.name) : null });
  }
  const rank = { high: 3, medium: 2, low: 1 } as const;
  findings.sort((a, b) => rank[b.severity] - rank[a.severity] || b.value - a.value);

  return {
    main: findings[0]?.cause ?? "none",
    findings,
    culprits: culprits
      .filter((c) => c.avgCpu >= 1 || c.avgIoMbs >= 0.5)
      .sort((a, b) => b.avgCpu + b.avgIoMbs * 10 - (a.avgCpu + a.avgIoMbs * 10))
      .slice(0, 6),
    avg: { cpu: r1(cpuAvg), diskPct: r1(diskAvg), memAvailMb: Math.round(memAvg), diskQueue: r1(queueAvg) },
    peak: { cpu: r1(cpuPeakS.cpuTotal), cpuAt: cpuPeakS.t, diskPct: r1(diskPeakS.diskPct), diskAt: diskPeakS.t },
    samples: n,
    seconds: Math.round(samples[n - 1].t - samples[0].t),
  };
}

/** Разбор строки с замером из PowerShell: одна JSON-строка. */
export function parseSample(line: string): Sample | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.t !== "number" || !Array.isArray(o.procs)) return null;
    const procs: ProcSample[] = [];
    for (const p of o.procs as unknown[]) {
      if (!Array.isArray(p)) continue;
      procs.push({
        name: String(p[0] ?? ""),
        cpu: Number(p[1]) || 0,
        ioMbs: Number(p[2]) || 0,
        memMb: Number(p[3]) || 0,
      });
    }
    return {
      t: o.t,
      cpuTotal: Number(o.cpu) || 0,
      memAvailMb: Number(o.mem) || 0,
      diskPct: Math.min(100, Number(o.disk) || 0),
      diskQueue: Number(o.queue) || 0,
      procs,
    };
  } catch {
    return null;
  }
}

export const SAMPLER_PS = (seconds: number, stepSec: number): string => `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt ${seconds}) {
  $p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } |
    Sort-Object PercentProcessorTime -Descending | Select-Object -First 25 |
    ForEach-Object { ,@($_.Name, [double]$_.PercentProcessorTime, [math]::Round($_.IODataBytesPersec / 1MB, 2), [math]::Round($_.WorkingSetPrivate / 1MB, 0)) }
  $d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
  $c = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
  $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object -First 1
  $o = [ordered]@{ t = [math]::Round($sw.Elapsed.TotalSeconds, 1); cpu = [double]$c.PercentProcessorTime; mem = [double]$m.AvailableMBytes; disk = [double]$d.PercentDiskTime; queue = [double]$d.CurrentDiskQueueLength; procs = @($p) }
  ($o | ConvertTo-Json -Compress -Depth 4)
  Start-Sleep -Seconds ${stepSec}
}
`;

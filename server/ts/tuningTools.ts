/**
 * Инструменты страницы «Тюнинг ПК», не сводящиеся к переключателю:
 * дерево USB, инвентаризация драйверов (и MSI-режим), процессы/приоритеты,
 * сведения о BIOS, бенчмарки и запуск системных утилит.
 */
import {
  KIND,
  psJson,
  readRegs,
  readState,
  regAddStep,
  regDelStep,
  regId,
  runSteps,
  writeState,
  pushHistory,
} from "./tuningEngine";
import type { BenchRun, Step } from "./tuningEngine";
import { CHECKLIST_IDS, IFEO_PRIORITY, PRIORITIES } from "./tuningCatalog";
import type { Priority } from "./tuningCatalog";
import type { PrevOp, StepResult } from "./tuningTypes";

// ───────────────────────────────── USB ─────────────────────────────────

export interface UsbController {
  name: string;
  id: string;
  devices: { name: string; id: string; status: string }[];
}

export async function usbTree(): Promise<UsbController[]> {
  const rows = await psJson<UsbController[] | UsbController>(`
$ErrorActionPreference = 'SilentlyContinue'
$pnp = @{}
Get-CimInstance Win32_PnPEntity | Where-Object { $_.DeviceID -like 'USB\\*' -or $_.DeviceID -like 'HID\\*' } | ForEach-Object { $pnp[$_.DeviceID] = $_ }
$assoc = Get-CimInstance Win32_USBControllerDevice
$res = foreach ($c in (Get-CimInstance Win32_USBController)) {
  $devs = foreach ($a in $assoc) {
    if ($a.Antecedent.DeviceID -eq $c.DeviceID) {
      $d = $pnp[$a.Dependent.DeviceID]
      if ($d -and $d.Name -notmatch 'Root Hub|Корневой|Generic USB Hub') {
        [pscustomobject]@{ name = [string]$d.Name; id = [string]$d.DeviceID; status = [string]$d.Status }
      }
    }
  }
  [pscustomobject]@{ name = [string]$c.Name; id = [string]$c.DeviceID; devices = @($devs) }
}
ConvertTo-Json -InputObject @($res) -Compress -Depth 4
`);
  if (!rows) return [];
  return Array.isArray(rows) ? rows : [rows];
}

// ─────────────────────────────── драйверы ───────────────────────────────

export interface DriverRow {
  name: string;
  cls: string;
  version: string;
  provider: string;
  date: string;
  id: string;
  /** Режим MSI: true/false для PCI-устройств, null — не применимо. */
  msi: boolean | null;
}

export async function driverList(): Promise<DriverRow[]> {
  const rows = await psJson<DriverRow[] | DriverRow>(`
$ErrorActionPreference = 'SilentlyContinue'
$cls = 'DISPLAY','NET','MEDIA','USB','HDC','SCSIADAPTER','BLUETOOTH'
$res = Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -and ($cls -contains $_.DeviceClass) -and $_.DriverVersion } | ForEach-Object {
  $msi = $null
  if ($_.DeviceID -like 'PCI\\*') {
    $p = "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\$($_.DeviceID)\\Device Parameters\\Interrupt Management\\MessageSignaledInterruptProperties"
    $v = (Get-ItemProperty -LiteralPath $p -Name MSISupported -EA SilentlyContinue).MSISupported
    $msi = ($v -eq 1)
  }
  $d = ''
  if ($_.DriverDate) { $d = ([datetime]$_.DriverDate).ToString('yyyy-MM-dd') }
  [pscustomobject]@{ name = [string]$_.DeviceName; cls = [string]$_.DeviceClass; version = [string]$_.DriverVersion; provider = [string]$_.DriverProviderName; date = $d; id = [string]$_.DeviceID; msi = $msi }
}
ConvertTo-Json -InputObject @($res) -Compress -Depth 3
`);
  if (!rows) return [];
  return (Array.isArray(rows) ? rows : [rows]).sort(
    (a, b) => a.cls.localeCompare(b.cls) || a.name.localeCompare(b.name),
  );
}

// ──────────────────────────────── процессы ────────────────────────────────

export interface ProcRow {
  pid: number;
  name: string;
  priority: string;
  affinity: number;
  mem: number;
}

export async function processList(): Promise<{ cpus: number; items: ProcRow[] }> {
  const res = await psJson<{ cpus: number; items: ProcRow[] | ProcRow }>(`
$ErrorActionPreference = 'SilentlyContinue'
$items = Get-Process | Sort-Object WorkingSet64 -Descending | ForEach-Object {
  try { $pc = $_.PriorityClass.ToString(); $af = [int64]$_.ProcessorAffinity } catch { $pc = $null }
  if ($pc) { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; priority = $pc; affinity = $af; mem = [int64]$_.WorkingSet64 } }
} | Select-Object -First 80
ConvertTo-Json -InputObject ([pscustomobject]@{ cpus = [Environment]::ProcessorCount; items = @($items) }) -Compress -Depth 4
`);
  if (!res) return { cpus: 0, items: [] };
  return { cpus: res.cpus, items: Array.isArray(res.items) ? res.items : [res.items] };
}

export async function setProcess(
  pid: number,
  priority?: string,
  affinity?: number,
): Promise<StepResult> {
  if (!Number.isInteger(pid) || pid <= 4)
    return { ok: false, failed: [], needsReboot: false, error: "bad_pid" };
  const parts = [`$p = Get-Process -Id ${pid} -ErrorAction Stop`];
  if (priority) {
    if (!(PRIORITIES as readonly string[]).includes(priority))
      return { ok: false, failed: [], needsReboot: false, error: "bad_priority" };
    parts.push(`$p.PriorityClass = '${priority}'`);
  }
  if (affinity !== undefined) {
    if (!Number.isSafeInteger(affinity) || affinity < 1)
      return { ok: false, failed: [], needsReboot: false, error: "bad_affinity" };
    parts.push(`$p.ProcessorAffinity = [IntPtr]${affinity}`);
  }
  const step: Step = { exe: "ps", args: [parts.join("\n")], admin: false, label: `process ${pid}` };
  const r = await runSteps([step]);
  const st = readState();
  pushHistory(st, "process", r.ok, `${pid} ${priority || ""} ${affinity ?? ""}`.trim());
  writeState(st);
  return r;
}

const IFEO_KEY =
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options";

export function ifeoRules(): { exe: string; priority: string }[] {
  return readState().ifeo.map((r) => ({ exe: r.exe, priority: r.priority }));
}

/** Постоянный приоритет процесса по имени exe (Image File Execution Options → PerfOptions). */
export async function ifeoAdd(exe: string, priority: string): Promise<StepResult> {
  if (!/^[\w.\- ]{1,64}\.exe$/i.test(exe) || !(priority in IFEO_PRIORITY))
    return { ok: false, failed: [], needsReboot: false, error: "bad_input" };
  const key = `${IFEO_KEY}\\${exe}\\PerfOptions`;
  const name = "CpuPriorityClass";
  const reads = await readRegs([{ key, name }]);
  const r0 = reads.get(regId(key, name));
  const prev: PrevOp = {
    t: "reg",
    key,
    name,
    exists: !!r0?.e,
    type: r0?.e ? KIND[r0.t || ""] : undefined,
    value: r0?.e && r0.v !== null ? Number(r0.v) >>> 0 : undefined,
  };
  const r = await runSteps([
    regAddStep({ key, name, type: "REG_DWORD", value: IFEO_PRIORITY[priority as Priority] }),
  ]);
  const st = readState();
  if (r.ok) {
    const old = st.ifeo.find((x) => x.exe.toLowerCase() === exe.toLowerCase());
    if (old) old.priority = priority;
    else st.ifeo.push({ exe, priority, prev });
  }
  pushHistory(st, "ifeo", r.ok, `${exe} ${priority}`);
  writeState(st);
  return r;
}

export async function ifeoRemove(exe: string): Promise<StepResult> {
  const st = readState();
  const rule = st.ifeo.find((x) => x.exe.toLowerCase() === exe.toLowerCase());
  if (!rule) return { ok: false, failed: [], needsReboot: false, error: "not_found" };
  const p = rule.prev;
  const key = `${IFEO_KEY}\\${rule.exe}\\PerfOptions`;
  const step =
    p.t === "reg" && p.exists && p.type && p.value !== undefined
      ? regAddStep({ key, name: "CpuPriorityClass", type: p.type, value: p.value })
      : regDelStep(key, "CpuPriorityClass");
  const r = await runSteps([step]);
  if (r.ok) st.ifeo = st.ifeo.filter((x) => x !== rule);
  pushHistory(st, "ifeoRemove", r.ok, rule.exe);
  writeState(st);
  return r;
}

// ────────────────────────────────── BIOS ──────────────────────────────────

export interface BiosFacts {
  biosVendor: string;
  biosVersion: string;
  biosDate: string;
  board: string;
  uefi: boolean | null;
  secureBoot: boolean | null;
  tpm: boolean | null;
  cpu: string;
  cores: number;
  threads: number;
  virtualization: boolean | null;
  ramSpeed: number;
  ramConfigured: number;
  ramModules: number;
  gpu: string[];
  hags: boolean | null;
}

export async function biosFacts(): Promise<BiosFacts | null> {
  return psJson<BiosFacts>(`
$ErrorActionPreference = 'SilentlyContinue'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS
$bb = Get-CimInstance Win32_BaseBoard
$mem = @(Get-CimInstance Win32_PhysicalMemory)
$sbKey = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecureBoot\\State' -Name UEFISecureBootEnabled
$fw = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control' -Name PEFirmwareType).PEFirmwareType
$uefi = [bool]$sbKey; if ($fw) { $uefi = ($fw -eq 2) }
$sb = $null; if ($sbKey) { $sb = ($sbKey.UEFISecureBootEnabled -eq 1) }
$tpm = $null; try { $tpm = [bool]((Get-Tpm).TpmPresent) } catch {}
$hw = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' -Name HwSchMode).HwSchMode
$hags = $null; if ($hw) { $hags = ($hw -eq 2) }
$ramSpeed = 0; $ramCfg = 0
if ($mem.Count) { $ramSpeed = [int](($mem | Measure-Object -Property Speed -Maximum).Maximum); $ramCfg = [int](($mem | Measure-Object -Property ConfiguredClockSpeed -Maximum).Maximum) }
$o = [pscustomobject]@{
  biosVendor = [string]$bios.Manufacturer; biosVersion = [string]$bios.SMBIOSBIOSVersion
  biosDate = $(if ($bios.ReleaseDate) { ([datetime]$bios.ReleaseDate).ToString('yyyy-MM-dd') } else { '' })
  board = ([string]$bb.Manufacturer + ' ' + [string]$bb.Product).Trim()
  uefi = $uefi; secureBoot = $sb; tpm = $tpm
  cpu = [string]$cpu.Name; cores = [int]$cpu.NumberOfCores; threads = [int]$cpu.NumberOfLogicalProcessors
  virtualization = $cpu.VirtualizationFirmwareEnabled
  ramSpeed = $ramSpeed; ramConfigured = $ramCfg; ramModules = $mem.Count
  gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { [string]$_.Name })
  hags = $hags
}
ConvertTo-Json -InputObject $o -Compress -Depth 3
`);
}

// ─────────────────────────────── бенчмарки ───────────────────────────────

export type BenchData = Record<string, number>;

export async function runBench(): Promise<BenchData | null> {
  const res = await psJson<BenchData>(
    `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NtTimer {
  [DllImport("ntdll.dll")] public static extern int NtQueryTimerResolution(out uint min, out uint max, out uint cur);
}
'@
$min = [uint32]0; $max = [uint32]0; $cur = [uint32]0
[void][NtTimer]::NtQueryTimerResolution([ref]$min, [ref]$max, [ref]$cur)
$sw = [System.Diagnostics.Stopwatch]::new()
$times = New-Object System.Collections.Generic.List[double]
for ($i = 0; $i -lt 200; $i++) { $sw.Restart(); [System.Threading.Thread]::Sleep(1); $times.Add($sw.Elapsed.TotalMilliseconds) }
$sorted = $times | Sort-Object
$dpc = @(); $intr = @(); $dpcRate = @()
for ($i = 0; $i -lt 5; $i++) {
  $c = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'"
  if ($c) { $dpc += [double]$c.PercentDPCTime; $intr += [double]$c.PercentInterruptTime; $dpcRate += [double]$c.DPCsQueuedPersec }
  Start-Sleep -Milliseconds 800
}
function Avg($a) { if ($a.Count) { [math]::Round(($a | Measure-Object -Average).Average, 3) } else { 0 } }
function Mx($a) { if ($a.Count) { [math]::Round(($a | Measure-Object -Maximum).Maximum, 3) } else { 0 } }
$o = [ordered]@{
  timerCur = [math]::Round($cur / 10000, 4); timerMin = [math]::Round($min / 10000, 4); timerMax = [math]::Round($max / 10000, 4)
  sleepAvg = [math]::Round(($times | Measure-Object -Average).Average, 3)
  sleepP99 = [math]::Round($sorted[[int]($sorted.Count * 0.99) - 1], 3)
  sleepMax = [math]::Round($sorted[$sorted.Count - 1], 3)
  dpcAvg = Avg $dpc; dpcMax = Mx $dpc; intAvg = Avg $intr; intMax = Mx $intr; dpcRate = Avg $dpcRate
}
ConvertTo-Json -InputObject $o -Compress
`,
    90000,
  );
  return res;
}

export function benchSave(label: string, data: BenchData): BenchRun {
  const st = readState();
  const run: BenchRun = { id: `r${Date.now()}`, at: Date.now(), label: label.slice(0, 60), data };
  st.bench.unshift(run);
  st.bench.length = Math.min(st.bench.length, 30);
  writeState(st);
  return run;
}

export function benchList(): BenchRun[] {
  return readState().bench;
}

export function benchDelete(id: string): void {
  const st = readState();
  st.bench = st.bench.filter((b) => b.id !== id);
  writeState(st);
}

// ───────────────────────────── чек-листы и утилиты ─────────────────────────────

export function checklistGet(): Record<string, boolean> {
  return readState().checklist;
}

export function checklistSet(id: string, checked: boolean): boolean {
  if (!CHECKLIST_IDS.has(id)) return false;
  const st = readState();
  if (checked) st.checklist[id] = true;
  else delete st.checklist[id];
  writeState(st);
  return true;
}

const TOOLS: Record<string, { exe: string; args: string[]; admin: boolean }> = {
  devmgmt: { exe: "cmd.exe", args: ["/c", "start", "", "devmgmt.msc"], admin: false },
  restore: { exe: "cmd.exe", args: ["/c", "start", "", "rstrui.exe"], admin: false },
  msinfo: { exe: "cmd.exe", args: ["/c", "start", "", "msinfo32.exe"], admin: false },
  eventvwr: { exe: "cmd.exe", args: ["/c", "start", "", "eventvwr.msc"], admin: false },
  uefi: { exe: "shutdown.exe", args: ["/r", "/fw", "/t", "20"], admin: true },
  abort: { exe: "shutdown.exe", args: ["/a"], admin: false },
};

export async function openTool(what: string): Promise<StepResult> {
  const t = TOOLS[what];
  if (!t) return { ok: false, failed: [], needsReboot: false, error: "unknown_tool" };
  const r = await runSteps([{ exe: t.exe, args: t.args, admin: t.admin, label: what }]);
  const st = readState();
  pushHistory(st, "tool", r.ok, what);
  writeState(st);
  return r;
}

export function historyList() {
  return readState().history;
}

// ───────────────────────────── восстановление системы ─────────────────────────

const FIXES: Record<string, { exe: string; args: string[]; admin: boolean }> = {
  sfc: { exe: "sfc.exe", args: ["/scannow"], admin: true },
  dism: { exe: "Dism.exe", args: ["/Online", "/Cleanup-Image", "/RestoreHealth"], admin: true },
  "winsock-reset": {
    exe: "cmd.exe",
    args: ["/c", "netsh winsock reset & netsh int ip reset"],
    admin: true,
  },
  "explorer-restart": {
    exe: "cmd.exe",
    args: ["/c", "taskkill /f /im explorer.exe & start explorer.exe"],
    admin: false,
  },
  "store-reset": { exe: "wsreset.exe", args: [], admin: false },
  "wu-reset": {
    exe: "ps",
    args: [
      "net stop wuauserv; net stop bits; net stop cryptsvc; " +
        "Rename-Item -Path \"$env:windir\\SoftwareDistribution\" -NewName 'SoftwareDistribution.bak' -EA SilentlyContinue; " +
        "Rename-Item -Path \"$env:windir\\System32\\catroot2\" -NewName 'catroot2.bak' -EA SilentlyContinue; " +
        "net start cryptsvc; net start bits; net start wuauserv",
    ],
    admin: true,
  },
};

export const FIX_IDS = Object.keys(FIXES);

export async function runFix(id: string): Promise<StepResult> {
  const f = FIXES[id];
  if (!f) return { ok: false, failed: [], needsReboot: false, error: "unknown_fix" };
  const step: Step =
    f.exe === "ps"
      ? { exe: "ps", args: [f.args[0]], admin: f.admin, label: id }
      : { exe: f.exe, args: f.args, admin: f.admin, label: id };
  const r = await runSteps([step]);
  const st = readState();
  pushHistory(st, "fix", r.ok, id);
  writeState(st);
  return r;
}

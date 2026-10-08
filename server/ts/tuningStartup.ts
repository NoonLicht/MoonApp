/**
 * Менеджер автозапуска («Тюнинг ПК» → Планировщик).
 *
 * Собирает всё, что Windows запускает само, — в том числе то, чего не видно в
 * диспетчере задач: ключи Run/RunOnce/Policies, папки автозагрузки, задачи
 * планировщика (вход/загрузка), службы, Winlogon (Shell/Userinit/Taskman),
 * IFEO-отладчики, AppInit_DLLs, BootExecute, Active Setup.
 *
 * Отключение для Run и папок автозагрузки — через StartupApproved (как делает
 * диспетчер задач), поэтому ничего не теряется. Удаление записывает копию в
 * «корзину» автозапуска, откуда запись можно вернуть.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import config from "./config";
import { psQuote } from "./elevate";
import { psJson, runPs, runSteps, readState, writeState, pushHistory } from "./tuningEngine";
import type { Step } from "./tuningEngine";
import type { StepResult } from "./tuningTypes";

export type StartupKind =
  | "run"
  | "runonce"
  | "policy"
  | "legacy"
  | "folder"
  | "task"
  | "service"
  | "winlogon"
  | "ifeo"
  | "appinit"
  | "bootexec"
  | "activesetup";

export interface StartupEntry {
  id: string;
  kind: StartupKind;
  scope: "user" | "machine";
  loc: string;
  name: string;
  title: string;
  cmd: string;
  enabled: boolean;
  running: boolean;
  delayed: boolean;
  /** Значение совпадает со стандартным (Winlogon). */
  std: boolean;
  acct: string;
  trig: string;
  path: string;
  exists: boolean;
  company: string;
  desc: string;
  /** Valid | NotSigned | HashMismatch | UnknownError | System | "" (не проверялось). */
  sig: string;
  signer: string;
  vkind: string;
  /** Нет в диспетчере задач и msconfig. */
  hidden: boolean;
  /** Компонент Microsoft (подпись/папка Windows). */
  ms: boolean;
  flags: string[];
  /** Какие действия применимы. */
  can: string[];
}

export interface TrashItem {
  id: string;
  at: number;
  kind: StartupKind;
  loc: string;
  name: string;
  cmd: string;
  scope: "user" | "machine";
  /** Тип значения реестра (String | ExpandString). */
  vkind?: string;
  /** Файл-копия (ярлык из папки автозагрузки) или XML задачи. */
  file?: string;
}

// ─────────────────────────────── расположения ───────────────────────────────

const CV = "Software\\Microsoft\\Windows\\CurrentVersion";
const APPROVED = `${CV}\\Explorer\\StartupApproved`;

interface RunLoc {
  key: string;
  approved?: string;
  kind: StartupKind;
  scope: "user" | "machine";
}

const RUN_LOCS: Record<string, RunLoc> = {
  "hkcu-run": {
    key: `HKCU:\\${CV}\\Run`,
    approved: `HKCU:\\${APPROVED}\\Run`,
    kind: "run",
    scope: "user",
  },
  "hklm-run": {
    key: `HKLM:\\${CV}\\Run`,
    approved: `HKLM:\\${APPROVED}\\Run`,
    kind: "run",
    scope: "machine",
  },
  "hklm-run32": {
    key: `HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run`,
    approved: `HKLM:\\${APPROVED}\\Run32`,
    kind: "run",
    scope: "machine",
  },
  "hkcu-runonce": { key: `HKCU:\\${CV}\\RunOnce`, kind: "runonce", scope: "user" },
  "hklm-runonce": { key: `HKLM:\\${CV}\\RunOnce`, kind: "runonce", scope: "machine" },
  "hklm-runonce32": {
    key: `HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce`,
    kind: "runonce",
    scope: "machine",
  },
  "hkcu-polrun": { key: `HKCU:\\${CV}\\Policies\\Explorer\\Run`, kind: "policy", scope: "user" },
  "hklm-polrun": {
    key: `HKLM:\\${CV}\\Policies\\Explorer\\Run`,
    kind: "policy",
    scope: "machine",
  },
};

const FOLDER_LOCS: Record<string, { approved: string; scope: "user" | "machine" }> = {
  "folder-user": { approved: `HKCU:\\${APPROVED}\\StartupFolder`, scope: "user" },
  "folder-common": { approved: `HKLM:\\${APPROVED}\\StartupFolder`, scope: "machine" },
};

const WINDOWS_NT = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
const IFEO = `HKLM:\\${WINDOWS_NT}\\Image File Execution Options`;
const SPE = `HKLM:\\${WINDOWS_NT}\\SilentProcessExit`;
const AS_ROOT = "HKLM:\\SOFTWARE\\Microsoft\\Active Setup\\Installed Components";
const AS_ROOT32 = "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Active Setup\\Installed Components";
const WINLOGON = `HKLM:\\${WINDOWS_NT}\\Winlogon`;
const WIN_APPINIT: Record<string, string> = {
  appinit: `HKLM:\\${WINDOWS_NT}\\Windows`,
  appinit32: `HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Windows`,
};

/** Значение реестра, которое хранит запись (для удаления/возврата). */
function regTarget(e: StartupEntry): { key: string; value: string } | null {
  const run = RUN_LOCS[e.loc];
  if (run) return { key: run.key, value: e.name };
  if (e.loc === "ifeo-debugger") return { key: `${IFEO}\\${e.name}`, value: "Debugger" };
  if (e.loc === "ifeo-monitor") return { key: `${SPE}\\${e.name}`, value: "MonitorProcess" };
  if (WIN_APPINIT[e.loc]) return { key: WIN_APPINIT[e.loc], value: "AppInit_DLLs" };
  if (e.loc === "activesetup") return { key: `${AS_ROOT}\\${e.name}`, value: "StubPath" };
  if (e.loc === "activesetup32") return { key: `${AS_ROOT32}\\${e.name}`, value: "StubPath" };
  return null;
}

// ───────────────────────────────── перечисление ─────────────────────────────────

const LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$rows = New-Object System.Collections.ArrayList
function AddRow($kind, $scope, $loc, $name, $title, $cmd, $enabled, $vkind) {
  $o = [pscustomobject]@{ kind=$kind; scope=$scope; loc=$loc; name=[string]$name; title=[string]$title; cmd=[string]$cmd; enabled=[bool]$enabled; running=$false; delayed=$false; std=$true; acct=''; trig=''; path=''; exists=$false; company=''; desc=''; sig=''; signer=''; vkind=[string]$vkind }
  [void]$rows.Add($o)
  return $o
}
function IsDisabled($ap, $n) {
  if (-not $ap) { return $false }
  $b = $ap.GetValue($n)
  if ($b -is [byte[]] -and $b.Length -gt 0) { return (($b[0] -band 1) -eq 1) }
  return $false
}

# Run / RunOnce / Policies
$runLocs = @(
  @('hkcu-run','run','user','HKCU:\Software\Microsoft\Windows\CurrentVersion\Run','HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'),
  @('hklm-run','run','machine','HKLM:\Software\Microsoft\Windows\CurrentVersion\Run','HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'),
  @('hklm-run32','run','machine','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run','HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32'),
  @('hkcu-runonce','runonce','user','HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce',''),
  @('hklm-runonce','runonce','machine','HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce',''),
  @('hklm-runonce32','runonce','machine','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce',''),
  @('hkcu-polrun','policy','user','HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run',''),
  @('hklm-polrun','policy','machine','HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run','')
)
foreach ($l in $runLocs) {
  $k = Get-Item -LiteralPath $l[3]
  if (-not $k) { continue }
  $ap = $null
  if ($l[4]) { $ap = Get-Item -LiteralPath $l[4] }
  foreach ($n in $k.GetValueNames()) {
    if ($n -eq '') { continue }
    $v = [string]$k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
    $r = AddRow $l[1] $l[2] $l[0] $n '' $v (-not (IsDisabled $ap $n)) ($k.GetValueKind($n).ToString())
  }
}

# Устаревшие Load/Run в Windows NT
$leg = Get-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows'
if ($leg) {
  foreach ($n in 'Load','Run') {
    $v = [string]$leg.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
    if ($v.Trim()) { $r = AddRow 'legacy' 'user' 'hkcu-winload' $n '' $v $true 'String' }
  }
}

# Папки автозагрузки
$sh = New-Object -ComObject WScript.Shell
$folders = @(
  @('folder-user','user',[Environment]::GetFolderPath('Startup'),'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'),
  @('folder-common','machine',[Environment]::GetFolderPath('CommonStartup'),'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder')
)
foreach ($f in $folders) {
  if (-not $f[2] -or -not (Test-Path -LiteralPath $f[2])) { continue }
  $ap = Get-Item -LiteralPath $f[3]
  foreach ($it in (Get-ChildItem -LiteralPath $f[2] -Force | Where-Object { -not $_.PSIsContainer -and $_.Name -ne 'desktop.ini' })) {
    $cmd = $it.FullName
    if ($it.Extension -eq '.lnk') {
      $s = $sh.CreateShortcut($it.FullName)
      $cmd = ('"' + $s.TargetPath + '" ' + $s.Arguments).Trim()
    }
    $r = AddRow 'folder' $f[1] $f[0] $it.Name '' $cmd (-not (IsDisabled $ap $it.Name)) ''
    $r.acct = $it.FullName
  }
}

# Задачи планировщика со входом / загрузкой
foreach ($t in (Get-ScheduledTask)) {
  $cls = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName })
  $trig = @()
  if ($cls -contains 'MSFT_TaskLogonTrigger') { $trig += 'logon' }
  if ($cls -contains 'MSFT_TaskBootTrigger') { $trig += 'boot' }
  if (-not $trig.Count) { continue }
  $a = $t.Actions | Where-Object { $_.Execute } | Select-Object -First 1
  $cmd = ''
  if ($a) {
    $e = [string]$a.Execute
    if ($e.Contains(' ') -and -not $e.StartsWith('"')) { $e = '"' + $e + '"' }
    $cmd = ($e + ' ' + $a.Arguments).Trim()
  }
  $r = AddRow 'task' 'machine' 'task' ($t.TaskPath + $t.TaskName) $t.TaskName $cmd ($t.State -ne 'Disabled') ''
  $r.trig = ($trig -join ',')
  $r.acct = [string]$t.Principal.UserId
  $r.running = ($t.State -eq 'Running')
}

# Службы с автозапуском и отключённые
foreach ($s in (Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -or $_.StartMode -eq 'Disabled' })) {
  $r = AddRow 'service' 'machine' 'service' $s.Name $s.DisplayName ([string]$s.PathName) ($s.StartMode -eq 'Auto') ''
  $r.running = ($s.State -eq 'Running')
  $r.delayed = [bool]$s.DelayedAutoStart
  $r.acct = [string]$s.StartName
}

# Winlogon
$wl = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
foreach ($n in 'Shell','Userinit','Taskman','AppSetup','VmApplet') {
  $v = [string]$wl.$n
  if (-not $v.Trim()) { continue }
  $r = AddRow 'winlogon' 'machine' 'winlogon' $n '' $v $true 'String'
  if ($n -eq 'Shell') { $r.std = ($v.Trim() -ieq 'explorer.exe') }
  elseif ($n -eq 'Userinit') { $r.std = ($v.Trim() -ieq 'C:\Windows\system32\userinit.exe,') }
  elseif ($n -eq 'VmApplet') { $r.std = ($v -match 'SystemPropertiesPerformance\.exe') }
  else { $r.std = $false }
}

# IFEO: Debugger и SilentProcessExit: MonitorProcess
foreach ($c in (Get-ChildItem -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options')) {
  $d = [string]$c.GetValue('Debugger')
  if ($d.Trim()) { $r = AddRow 'ifeo' 'machine' 'ifeo-debugger' $c.PSChildName '' $d $true 'String' }
}
foreach ($c in (Get-ChildItem -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SilentProcessExit')) {
  $d = [string]$c.GetValue('MonitorProcess')
  if ($d.Trim()) { $r = AddRow 'ifeo' 'machine' 'ifeo-monitor' $c.PSChildName '' $d $true 'String' }
}

# AppInit_DLLs
foreach ($p in @(@('appinit','HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows'),@('appinit32','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Windows'))) {
  $w = Get-ItemProperty -LiteralPath $p[1]
  $v = [string]$w.AppInit_DLLs
  if ($v.Trim()) { $r = AddRow 'appinit' 'machine' $p[0] 'AppInit_DLLs' '' $v ($w.LoadAppInit_DLLs -eq 1) 'String' }
}

# BootExecute
$be = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager').BootExecute
$i = 0
foreach ($b in @($be)) {
  $i++
  if ($b -and $b -ne 'autocheck autochk *') { $r = AddRow 'bootexec' 'machine' 'bootexec' ('BootExecute #' + $i) '' $b $true '' }
}

# Active Setup
foreach ($root in @(@('activesetup','HKLM:\SOFTWARE\Microsoft\Active Setup\Installed Components'),@('activesetup32','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Active Setup\Installed Components'))) {
  foreach ($c in (Get-ChildItem -LiteralPath $root[1])) {
    $s = [string]$c.GetValue('StubPath', $null, 'DoNotExpandEnvironmentNames')
    if ($s.Trim()) { $r = AddRow 'activesetup' 'machine' $root[0] $c.PSChildName ([string]$c.GetValue('')) $s $true ($c.GetValueKind('StubPath').ToString()) }
  }
}

# Разбор команды, сведения о файле, подпись
function Resolve-Cmd([string]$c) {
  $c = [Environment]::ExpandEnvironmentVariables($c.Trim())
  if (-not $c) { return '' }
  if ($c -match 'rundll32(\.exe)?"?(\s+/\w+)*\s+"?([^",]+?\.[A-Za-z]{2,4})("|,|\s|$)') {
    $d = $matches[3]
    if ($d -notmatch '[\\/]') { $x = Join-Path $env:windir ('System32\' + $d); if (Test-Path -LiteralPath $x) { $d = $x } }
    return $d
  }
  $f = ''
  if ($c.StartsWith('"')) {
    $e = $c.IndexOf('"', 1)
    if ($e -gt 1) { $f = $c.Substring(1, $e - 1) }
  } elseif ($c -match '^(.+?\.(exe|com|bat|cmd|scr|msi|lnk|dll|vbs|vbe|js|jse|wsf|ps1|cpl))(\s|$|,)') {
    $f = $matches[1]
  } else {
    $f = ($c -split '\s+')[0]
    if ($f -notmatch '^[A-Za-z]:\\|^\\\\|\.\w{2,4}$') { return '' }
  }
  if (-not $f) { return '' }
  if ($f -notmatch '[\\/]') {
    $g = Get-Command $f -CommandType Application | Select-Object -First 1
    if ($g) { $f = $g.Source }
  }
  return $f
}
$cache = @{}
$sys = $env:windir
foreach ($r in $rows) {
  $f = ''
  if ($r.kind -ne 'bootexec') { $f = Resolve-Cmd $r.cmd }
  if ($r.kind -eq 'service' -and $f -match 'svchost\.exe$') {
    $dll = [string](Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\' + $r.name + '\Parameters')).ServiceDll
    if (-not $dll) { $dll = [string](Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\' + $r.name)).ServiceDll }
    if ($dll) { $f = [Environment]::ExpandEnvironmentVariables($dll) }
  }
  if (-not $f) { continue }
  $r.path = $f
  $info = $cache[$f]
  if (-not $info) {
    $info = @{ exists = $false; company = ''; desc = ''; sig = ''; signer = '' }
    if (Test-Path -LiteralPath $f -PathType Leaf) {
      $info.exists = $true
      $vi = (Get-Item -LiteralPath $f).VersionInfo
      $info.company = [string]$vi.CompanyName
      $info.desc = [string]$vi.FileDescription
      $ext = [IO.Path]::GetExtension($f).ToLower()
      if ($ext -in '.exe','.dll','.scr','.sys','.ocx','.cpl','.msi') {
        $isMs = ($info.company -match 'Microsoft') -and $f.StartsWith($sys, [StringComparison]::OrdinalIgnoreCase)
        if ($isMs) { $info.sig = 'System'; $info.signer = 'Microsoft' }
        else {
          $s = Get-AuthenticodeSignature -LiteralPath $f
          $info.sig = $s.Status.ToString()
          if ($s.SignerCertificate) {
            $m = [regex]::Match($s.SignerCertificate.Subject, 'CN=("[^"]+"|[^,]+)')
            $info.signer = $m.Groups[1].Value.Trim('"')
          }
        }
      }
    }
    $cache[$f] = $info
  }
  $r.exists = $info.exists; $r.company = $info.company; $r.desc = $info.desc; $r.sig = $info.sig; $r.signer = $info.signer
}
ConvertTo-Json -InputObject @($rows.ToArray()) -Compress -Depth 4
`;

type RawRow = Omit<StartupEntry, "id" | "hidden" | "ms" | "flags" | "can">;

const HIDDEN_KINDS: ReadonlySet<StartupKind> = new Set([
  "runonce",
  "policy",
  "legacy",
  "task",
  "service",
  "winlogon",
  "ifeo",
  "appinit",
  "bootexec",
  "activesetup",
]);

const SUSPECT_PATH = /\\(temp|tmp|downloads|users\\public|\$recycle\.bin)\\/i;
const SCRIPT_HOST = /\b(powershell|pwsh|wscript|cscript|mshta|regsvr32|certutil|bitsadmin)(\.exe)?\b|cmd(\.exe)?"?\s+\/[ck]\b/i;
const ENCODED = /\s-(e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}/i;

function classify(r: RawRow): StartupEntry {
  const winDir = (process.env.SystemRoot || "C:\\Windows").toLowerCase();
  const isMs =
    /microsoft/i.test(r.company) &&
    (r.sig === "System" || r.sig === "Valid" || r.path.toLowerCase().startsWith(winDir));
  const flags: string[] = [];
  const hasFile = !!r.path && r.kind !== "bootexec";
  if (hasFile && !r.exists) flags.push("missing");
  if (r.exists && !isMs && r.sig === "NotSigned") flags.push("unsigned");
  if (r.sig === "HashMismatch") flags.push("badsig");
  else if (r.sig === "NotTrusted" || r.sig === "UnknownError") flags.push("untrusted");
  if (SUSPECT_PATH.test(r.path) || SUSPECT_PATH.test(r.cmd)) flags.push("tempPath");
  if (ENCODED.test(r.cmd)) flags.push("encoded");
  else if (SCRIPT_HOST.test(r.cmd) && !isMs) flags.push("script");
  if (r.kind === "winlogon" && !r.std) flags.push("modified");
  if (r.kind === "ifeo" || r.kind === "appinit" || r.kind === "bootexec") flags.push("injection");

  const can: string[] = [];
  const reg = !!regTarget({ ...r, id: "", hidden: false, ms: isMs, flags, can: [] });
  if (r.kind === "run" || r.kind === "folder") can.push("toggle");
  if (r.kind === "task" || r.kind === "appinit") can.push("toggle");
  if (r.kind === "service") can.push("svc");
  if (r.kind === "winlogon" && !r.std && (r.name === "Shell" || r.name === "Userinit")) can.push("reset");
  if (reg || r.kind === "folder" || r.kind === "task") can.push("delete");
  if (reg) can.push("regedit");
  if (r.path && r.exists) can.push("reveal");
  return {
    ...r,
    id: `${r.loc}|${r.name}`,
    hidden: HIDDEN_KINDS.has(r.kind),
    ms: isMs,
    flags,
    can,
  };
}

let cache: { at: number; map: Map<string, StartupEntry> } | null = null;

export async function listStartup(): Promise<StartupEntry[]> {
  const rows = await psJson<RawRow[] | RawRow>(LIST_SCRIPT, 180000);
  const list = (rows ? (Array.isArray(rows) ? rows : [rows]) : []).map(classify);
  cache = { at: Date.now(), map: new Map(list.map((e) => [e.id, e])) };
  return list;
}

async function find(id: string): Promise<StartupEntry | null> {
  if (!cache || Date.now() - cache.at > 10 * 60_000) await listStartup();
  return cache?.map.get(id) ?? null;
}

// ──────────────────────────────── «корзина» ────────────────────────────────

const DIR = path.join(config.DIRS.storage, "tuning", "startup-trash");
const INDEX = path.join(DIR, "index.json");

function readTrash(): TrashItem[] {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX, "utf8")) as TrashItem[];
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function writeTrash(list: TrashItem[]): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(list, null, 2), "utf8");
}

export const trashList = (): TrashItem[] => readTrash();

export function trashDrop(id: string): { ok: boolean } {
  const list = readTrash();
  const it = list.find((x) => x.id === id);
  if (!it) return { ok: false };
  if (it.file) fs.rm(it.file, { force: true }, () => undefined);
  writeTrash(list.filter((x) => x !== it));
  return { ok: true };
}

// ───────────────────────────────── действия ─────────────────────────────────

const fail = (error: string): StepResult => ({ ok: false, failed: [], needsReboot: false, error });

const psStep = (script: string, admin: boolean, label: string): Step => ({
  exe: "ps",
  args: ["$ErrorActionPreference = 'Stop'\n" + script],
  admin,
  label,
});

function approvedScript(approved: string, name: string, enable: boolean): string {
  return String.raw`
$p = ${psQuote(approved)}
if (-not (Test-Path -LiteralPath $p)) { New-Item -Path $p -Force | Out-Null }
$b = New-Object byte[] 12
${
  enable
    ? "$b[0] = 2"
    : "$b[0] = 3; $t = [BitConverter]::GetBytes([DateTime]::UtcNow.ToFileTime()); [Array]::Copy($t, 0, $b, 4, 8)"
}
New-ItemProperty -LiteralPath $p -Name ${psQuote(name)} -Value $b -PropertyType Binary -Force | Out-Null
`;
}

function taskParts(e: StartupEntry): { p: string; n: string } {
  const i = e.name.lastIndexOf("\\");
  return { p: e.name.slice(0, i + 1), n: e.name.slice(i + 1) };
}

export type StartupAction =
  | "enable"
  | "disable"
  | "delete"
  | "reset"
  | "reveal"
  | "regedit"
  | "svc-auto"
  | "svc-delayed"
  | "svc-manual"
  | "svc-disabled";

export async function startupAction(id: string, action: StartupAction): Promise<StepResult> {
  const e = await find(id);
  if (!e) return fail("not_found");
  const machine = e.scope === "machine";
  let steps: Step[];
  let afterOk: (() => void) | null = null;

  if (action === "reveal") {
    if (!e.path || !fs.existsSync(e.path)) return fail("no_file");
    spawn("explorer.exe", [`/select,${e.path}`], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, failed: [], needsReboot: false };
  }

  if (action === "regedit") {
    const t = regTarget(e);
    if (!t) return fail("unsupported");
    const last = "Computer\\" + t.key.replace(/^HKLM:\\/, "HKEY_LOCAL_MACHINE\\").replace(/^HKCU:\\/, "HKEY_CURRENT_USER\\");
    await runPs(
      String.raw`
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Applets\Regedit'
if (-not (Test-Path -LiteralPath $k)) { New-Item -Path $k -Force | Out-Null }
Set-ItemProperty -LiteralPath $k -Name LastKey -Value ${psQuote(last)}
Start-Process regedit.exe
`,
      20000,
    );
    return { ok: true, failed: [], needsReboot: false };
  }

  if (action === "enable" || action === "disable") {
    const enable = action === "enable";
    const run = RUN_LOCS[e.loc];
    const folder = FOLDER_LOCS[e.loc];
    if (run?.approved) steps = [psStep(approvedScript(run.approved, e.name, enable), machine, e.id)];
    else if (folder) steps = [psStep(approvedScript(folder.approved, e.name, enable), machine, e.id)];
    else if (e.kind === "task") {
      const { p, n } = taskParts(e);
      const cmd = enable ? "Enable-ScheduledTask" : "Disable-ScheduledTask";
      steps = [psStep(`${cmd} -TaskPath ${psQuote(p)} -TaskName ${psQuote(n)} | Out-Null`, true, e.id)];
    } else if (e.kind === "appinit") {
      const key = WIN_APPINIT[e.loc];
      steps = [
        psStep(
          `Set-ItemProperty -LiteralPath ${psQuote(key)} -Name LoadAppInit_DLLs -Value ${enable ? 1 : 0} -Type DWord`,
          true,
          e.id,
        ),
      ];
    } else if (e.kind === "service") {
      return startupAction(id, enable ? (e.delayed ? "svc-delayed" : "svc-auto") : "svc-disabled");
    } else return fail("unsupported");
  } else if (action.startsWith("svc-")) {
    if (e.kind !== "service" || !/^[\w.\-$@ ]{1,256}$/.test(e.name)) return fail("unsupported");
    const modes: Record<string, string> = {
      "svc-auto": "auto",
      "svc-delayed": "delayed-auto",
      "svc-manual": "demand",
      "svc-disabled": "disabled",
    };
    const mode = modes[action];
    if (!mode) return fail("bad_action");
    steps = [{ exe: "sc.exe", args: ["config", e.name, "start=", mode], admin: true, label: e.id }];
  } else if (action === "reset") {
    const def = e.name === "Shell" ? "explorer.exe" : e.name === "Userinit" ? "C:\\Windows\\system32\\userinit.exe," : null;
    if (e.kind !== "winlogon" || !def) return fail("unsupported");
    steps = [
      psStep(
        `Set-ItemProperty -LiteralPath ${psQuote(WINLOGON)} -Name ${psQuote(e.name)} -Value ${psQuote(def)}`,
        true,
        e.id,
      ),
    ];
  } else if (action === "delete") {
    const item: TrashItem = {
      id: `t${Date.now()}${Math.floor(Math.random() * 1000)}`,
      at: Date.now(),
      kind: e.kind,
      loc: e.loc,
      name: e.name,
      cmd: e.cmd,
      scope: e.scope,
      vkind: e.vkind || undefined,
    };
    const t = regTarget(e);
    if (t) {
      const val = e.loc.startsWith("appinit")
        ? `Set-ItemProperty -LiteralPath ${psQuote(t.key)} -Name AppInit_DLLs -Value ''`
        : `Remove-ItemProperty -LiteralPath ${psQuote(t.key)} -Name ${psQuote(t.value)}`;
      steps = [psStep(val, machine, e.id)];
    } else if (e.kind === "folder") {
      const src = e.acct;
      if (!src || !fs.existsSync(src)) return fail("no_file");
      fs.mkdirSync(DIR, { recursive: true });
      item.file = path.join(DIR, `${item.id}-${path.basename(src)}`);
      fs.copyFileSync(src, item.file);
      steps = [psStep(`Remove-Item -LiteralPath ${psQuote(src)} -Force`, machine, e.id)];
    } else if (e.kind === "task") {
      const { p, n } = taskParts(e);
      fs.mkdirSync(DIR, { recursive: true });
      item.file = path.join(DIR, `${item.id}.xml`);
      const xml = await runPs(
        `Export-ScheduledTask -TaskPath ${psQuote(p)} -TaskName ${psQuote(n)}`,
        30000,
      );
      if (!xml.stdout.trim()) return fail("export_failed");
      fs.writeFileSync(item.file, xml.stdout, "utf8");
      steps = [
        psStep(`Unregister-ScheduledTask -TaskPath ${psQuote(p)} -TaskName ${psQuote(n)} -Confirm:$false`, true, e.id),
      ];
    } else return fail("unsupported");
    afterOk = () => writeTrash([item, ...readTrash()].slice(0, 200));
  } else return fail("bad_action");

  const r = await runSteps(steps);
  if (r.ok && afterOk) afterOk();
  const st = readState();
  pushHistory(st, "startup", r.ok, `${action} ${e.kind}: ${e.name}`.slice(0, 160));
  writeState(st);
  cache = null;
  return r;
}

export async function startupRestore(trashId: string): Promise<StepResult> {
  const list = readTrash();
  const it = list.find((x) => x.id === trashId);
  if (!it) return fail("not_found");
  const machine = it.scope === "machine";
  let step: Step | null = null;
  const fake = { loc: it.loc, name: it.name } as StartupEntry;
  const t = regTarget(fake);
  if (t) {
    const type = it.vkind === "ExpandString" ? "ExpandString" : "String";
    step = psStep(
      `if (-not (Test-Path -LiteralPath ${psQuote(t.key)})) { New-Item -Path ${psQuote(t.key)} -Force | Out-Null }\n` +
        `New-ItemProperty -LiteralPath ${psQuote(t.key)} -Name ${psQuote(t.value)} -Value ${psQuote(it.cmd)} -PropertyType ${type} -Force | Out-Null`,
      machine,
      it.name,
    );
  } else if (it.kind === "folder" && it.file) {
    const dir =
      it.loc === "folder-common"
        ? "[Environment]::GetFolderPath('CommonStartup')"
        : "[Environment]::GetFolderPath('Startup')";
    step = psStep(
      `Copy-Item -LiteralPath ${psQuote(it.file)} -Destination (Join-Path (${dir}) ${psQuote(path.basename(it.name))}) -Force`,
      machine,
      it.name,
    );
  } else if (it.kind === "task" && it.file) {
    const i = it.name.lastIndexOf("\\");
    step = psStep(
      `Register-ScheduledTask -Xml ([IO.File]::ReadAllText(${psQuote(it.file)})) -TaskPath ${psQuote(it.name.slice(0, i + 1))} -TaskName ${psQuote(it.name.slice(i + 1))} -Force | Out-Null`,
      true,
      it.name,
    );
  }
  if (!step) return fail("unsupported");
  const r = await runSteps([step]);
  if (r.ok) {
    if (it.file) fs.rm(it.file, { force: true }, () => undefined);
    writeTrash(list.filter((x) => x !== it));
  }
  const st = readState();
  pushHistory(st, "startupRestore", r.ok, `${it.kind}: ${it.name}`.slice(0, 160));
  writeState(st);
  cache = null;
  return r;
}

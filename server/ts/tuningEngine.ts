/**
 * Движок страницы «Тюнинг ПК»: чтение состояния, применение, откат, резервные копии.
 *
 * Принципы:
 *  - перед применением снимается снимок прежних значений (`PrevOp`), по нему же
 *    твик откатывается; без снимка откат идёт к значениям Windows по умолчанию;
 *  - все изменения одной операции собираются в «шаги» и выполняются разом:
 *    записи в HKLM и системные команды требуют прав администратора, и если
 *    приложение запущено без них, шаги уходят в ОДИН elevated-скрипт (один UAC);
 *  - значения реестра читаются пакетом одним вызовом PowerShell.
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
import { runElevated, psQuote } from "./elevate";
import { TWEAKS, TWEAK_BY_ID } from "./tuningCatalog";
import type {
  BackupMeta,
  CmdOp,
  HistoryEntry,
  PrevOp,
  RegOp,
  StepResult,
  Tweak,
  TweakState,
  TweakStatus,
} from "./tuningTypes";

// ─────────────────────────── процессы и PowerShell ───────────────────────────

interface ExecOut {
  code: number;
  stdout: string;
  stderr: string;
}

export function exec(exe: string, args: string[], timeout = 30000): Promise<ExecOut> {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

const PS_HEAD =
  "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ";

let tmpSeq = 0;

function writeTmpPs(script: string): string {
  const file = path.join(config.DIRS.tmp, `tuning-${process.pid}-${Date.now()}-${tmpSeq++}.ps1`);
  // BOM нужен Windows PowerShell 5.1, иначе кириллица в скрипте читается как ANSI.
  fs.writeFileSync(file, "﻿" + PS_HEAD + script, "utf8");
  return file;
}

/** Выполнить PowerShell-скрипт (через временный файл — без проблем с кавычками). */
export async function runPs(script: string, timeout = 60000): Promise<ExecOut> {
  const file = writeTmpPs(script);
  try {
    return await exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      timeout,
    );
  } finally {
    fs.rm(file, { force: true }, () => undefined);
  }
}

/** Результат PowerShell, который печатает JSON. null при ошибке/пустом выводе. */
export async function psJson<T>(script: string, timeout = 60000): Promise<T | null> {
  const r = await runPs(script, timeout);
  const text = r.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    logger.log("warn", "tuning.psjson", {
      error: text.slice(0, 200),
      stderr: r.stderr.slice(0, 200),
    });
    return null;
  }
}

let adminCache: boolean | null = null;

/** Запущено ли приложение с правами администратора. */
export async function isAdmin(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  if (adminCache === null) adminCache = (await exec("fltmc", [], 10000)).code === 0;
  return adminCache;
}

// ───────────────────────────────── реестр ─────────────────────────────────

export interface RegRead {
  /** Ключ существует. */
  k: boolean;
  /** Значение существует. */
  e: boolean;
  v: string | number | null;
  t: string | null;
}

export const regId = (key: string, name: string): string => `${key}|${name}`.toLowerCase();

const psPath = (key: string): string =>
  "Registry::" +
  key
    .replace(/^HKLM\\/i, "HKEY_LOCAL_MACHINE\\")
    .replace(/^HKCU\\/i, "HKEY_CURRENT_USER\\")
    .replace(/^HKU\\/i, "HKEY_USERS\\");

const fromPsKey = (name: string): string =>
  name
    .replace(/^HKEY_LOCAL_MACHINE\\/i, "HKLM\\")
    .replace(/^HKEY_CURRENT_USER\\/i, "HKCU\\")
    .replace(/^HKEY_USERS\\/i, "HKU\\");

/** Прочитать пачку значений реестра одним вызовом PowerShell. */
export async function readRegs(
  items: { key: string; name: string }[],
): Promise<Map<string, RegRead>> {
  const out = new Map<string, RegRead>();
  if (!items.length) return out;
  const uniq = [...new Map(items.map((i) => [regId(i.key, i.name), i])).values()];
  const json = JSON.stringify(uniq.map((i) => ({ key: i.key, name: i.name, p: psPath(i.key) })));
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$items = @'
${json}
'@ | ConvertFrom-Json
$res = foreach ($i in $items) {
  $k = Test-Path -LiteralPath $i.p
  $e = $false; $v = $null; $t = $null
  if ($k) {
    $kk = Get-Item -LiteralPath $i.p
    if ($kk.GetValueNames() -contains $i.name) {
      $e = $true
      $v = $kk.GetValue($i.name, $null, 'DoNotExpandEnvironmentNames')
      $t = $kk.GetValueKind($i.name).ToString()
    }
  }
  [pscustomobject]@{ key = $i.key; name = $i.name; k = $k; e = $e; v = $v; t = $t }
}
ConvertTo-Json -InputObject @($res) -Compress -Depth 3
`;
  const rows = await psJson<
    {
      key: string;
      name: string;
      k: boolean;
      e: boolean;
      v: string | number | null;
      t: string | null;
    }[]
  >(script);
  for (const r of rows || []) out.set(regId(r.key, r.name), { k: r.k, e: r.e, v: r.v, t: r.t });
  return out;
}

export const KIND: Record<string, string> = {
  DWord: "REG_DWORD",
  String: "REG_SZ",
  ExpandString: "REG_EXPAND_SZ",
  QWord: "REG_QWORD",
};

function regMatches(op: RegOp, r: RegRead | undefined): boolean {
  if (!r || !r.e || r.v === null) return false;
  if (KIND[r.t || ""] !== op.type) return false;
  if (op.type === "REG_DWORD") return Number(r.v) >>> 0 === Number(op.value) >>> 0;
  return String(r.v).toLowerCase() === String(op.value).toLowerCase();
}

// ───────────────────────── динамические цели твиков ─────────────────────────

const SYS = "HKLM\\SYSTEM\\CurrentControlSet";
const dynCache = new Map<string, { at: number; ops: RegOp[] }>();

const dwordOp = (key: string, name: string, value: number, def?: number): RegOp => ({
  t: "reg",
  key,
  name,
  type: "REG_DWORD",
  value,
  def,
});

async function listStrings(script: string): Promise<string[]> {
  const rows = await psJson<string[] | string>(script);
  if (!rows) return [];
  return (Array.isArray(rows) ? rows : [rows]).filter((s) => typeof s === "string" && s);
}

async function generate(kind: string): Promise<RegOp[]> {
  if (kind === "usbpm") {
    const keys = await listStrings(
      `$r = Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\USB' -Recurse -EA SilentlyContinue | ` +
        `Where-Object { $_.PSChildName -eq 'Device Parameters' -and ($_.GetValueNames() -contains 'EnhancedPowerManagementEnabled') } | ` +
        `ForEach-Object { $_.Name }; ConvertTo-Json -InputObject @($r) -Compress`,
    );
    return keys.map((k) => dwordOp(fromPsKey(k), "EnhancedPowerManagementEnabled", 0, 1));
  }
  if (kind === "nagle") {
    const ids = await listStrings(
      `$r = Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces' -EA SilentlyContinue | ` +
        `Where-Object { $ip = $_.GetValue('IPAddress'); $dh = $_.GetValue('DhcpIPAddress'); ($ip -and $ip[0] -and $ip[0] -ne '0.0.0.0') -or ($dh -and $dh -ne '0.0.0.0') } | ` +
        `ForEach-Object { $_.PSChildName }; ConvertTo-Json -InputObject @($r) -Compress`,
    );
    return ids
      .filter((g) => /^\{[0-9a-f-]{36}\}$/i.test(g))
      .flatMap((g) => {
        const key = `${SYS}\\Services\\Tcpip\\Parameters\\Interfaces\\${g}`;
        return [dwordOp(key, "TcpAckFrequency", 1), dwordOp(key, "TCPNoDelay", 1)];
      });
  }
  const cls = kind === "msi-gpu" ? "Display" : "Net";
  const ids = await listStrings(
    `$r = Get-PnpDevice -Class ${cls} -PresentOnly -EA SilentlyContinue | ` +
      `Where-Object { $_.InstanceId -like 'PCI\\*' } | ForEach-Object { $_.InstanceId }; ConvertTo-Json -InputObject @($r) -Compress`,
  );
  return ids
    .filter((id) => /^PCI\\[\w&.\-\\]+$/i.test(id))
    .map((id) =>
      dwordOp(
        `${SYS}\\Enum\\${id}\\Device Parameters\\Interrupt Management\\MessageSignaledInterruptProperties`,
        "MSISupported",
        1,
      ),
    );
}

async function generateCached(kind: string): Promise<RegOp[]> {
  const hit = dynCache.get(kind);
  if (hit && Date.now() - hit.at < 15000) return hit.ops;
  const ops = await generate(kind);
  dynCache.set(kind, { at: Date.now(), ops });
  return ops;
}

/** Операция твика с известным местом в `tweak.ops` (нужно командам для отката). */
type Concrete = (RegOp | (CmdOp & { i: number })) & { skip?: boolean };

async function expand(tweak: Tweak): Promise<Concrete[]> {
  const out: Concrete[] = [];
  for (let i = 0; i < tweak.ops.length; i++) {
    const op = tweak.ops[i];
    if (op.t === "dyn") out.push(...(await generateCached(op.gen)));
    else if (op.t === "reg") out.push({ ...op });
    else out.push({ ...op, i });
  }
  return out;
}

// ───────────────────────────────── команды ─────────────────────────────────

interface CmdEval {
  on: boolean;
  na: boolean;
  cap?: string;
}

async function runCheck(check: string[], timeout = 30000): Promise<string> {
  const r =
    check[0] === "ps"
      ? await runPs(check[1], timeout)
      : await exec(check[0], check.slice(1), timeout);
  return r.stdout;
}

/** `powercfg -query` → "ac:<n> dc:<n>" (две последние строки «: 0x…» — AC и DC). */
function normalizePwr(text: string): string {
  const vals = [...text.matchAll(/:\s*(0x[0-9a-f]+)\s*$/gim)].map((m) => parseInt(m[1], 16));
  if (vals.length < 2) return "";
  return `ac:${vals[vals.length - 2]} dc:${vals[vals.length - 1]}`;
}

async function evalCmd(op: CmdOp): Promise<CmdEval> {
  let text = await runCheck(op.check);
  if (op.pwr) text = normalizePwr(text);
  const na = !!op.na && new RegExp(op.na, "im").test(text);
  if (op.pwr && !text) return { on: false, na: true };
  const on = new RegExp(op.on, "im").test(text);
  let cap: string | undefined;
  if (op.cap) cap = new RegExp(op.cap, "im").exec(text)?.[1];
  return { on, na, cap };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      res[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return res;
}

// ───────────────────────────────── состояние ─────────────────────────────────

export interface IfeoRule {
  exe: string;
  priority: string;
  prev: PrevOp;
}

export interface BenchRun {
  id: string;
  at: number;
  label: string;
  data: Record<string, number>;
}

export interface State {
  applied: Record<string, { at: number; prev: PrevOp[] }>;
  checklist: Record<string, boolean>;
  bench: BenchRun[];
  history: HistoryEntry[];
  ifeo: IfeoRule[];
}

const TUNING_DIR = path.join(config.DIRS.storage, "tuning");
const STATE_FILE = path.join(TUNING_DIR, "state.json");
const BACKUP_DIR = path.join(TUNING_DIR, "backups");

function ensureDirs(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

export function readState(): State {
  const empty: State = { applied: {}, checklist: {}, bench: [], history: [], ifeo: [] };
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<State>;
    return { ...empty, ...j };
  } catch {
    return empty;
  }
}

export function writeState(s: State): void {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

export function pushHistory(s: State, kind: string, ok: boolean, detail: string): void {
  s.history.unshift({ at: Date.now(), kind, ok, detail });
  s.history.length = Math.min(s.history.length, 100);
  logger.log(ok ? "action" : "warn", `tuning.${kind}`, { detail });
}

// ───────────────────────────────── статус ─────────────────────────────────

type OpVerdict = "match" | "diff" | "na";

export async function statusAll(): Promise<TweakStatus[]> {
  const expanded = await Promise.all(TWEAKS.map((t) => expand(t)));
  const regOps = expanded.flat().filter((o): o is RegOp => o.t === "reg");
  const reads = await readRegs(regOps);
  const cmdOps = expanded
    .flat()
    .filter((o): o is CmdOp & { i: number } => o.t === "cmd" && !o.noState);
  const cmdRes = new Map<CmdOp, CmdEval>();
  await mapLimit(cmdOps, 4, async (op) => {
    cmdRes.set(op, await evalCmd(op));
  });
  const state = readState();
  return TWEAKS.map((t, idx) => {
    const verdicts: OpVerdict[] = expanded[idx].map((op) => {
      if (op.t === "reg") {
        const r = reads.get(regId(op.key, op.name));
        if (op.opt && !r?.k) return "na";
        return regMatches(op, r) ? "match" : "diff";
      }
      if (op.noState) return "na";
      const r = cmdRes.get(op);
      if (!r || r.na) return "na";
      return r.on ? "match" : "diff";
    });
    const real = verdicts.filter((v) => v !== "na");
    let s: TweakState = "na";
    if (!real.length && expanded[idx].some((o) => o.t === "cmd" && o.noState))
      s = state.applied[t.id] ? "applied" : "default";
    else if (real.length) {
      const m = real.filter((v) => v === "match").length;
      s = m === real.length ? "applied" : m === 0 ? "default" : "partial";
    }
    return { id: t.id, state: s, byApp: !!state.applied[t.id] };
  });
}

// ───────────────────────────── снимки и шаги ─────────────────────────────

export interface Step {
  exe: string;
  args: string[];
  admin: boolean;
  ignoreFail?: boolean;
  label: string;
}

const isHklm = (key: string): boolean => /^HK(LM|U)\\/i.test(key);

export function regAddStep(op: {
  key: string;
  name: string;
  type: string;
  value: string | number;
}): Step {
  return {
    exe: "reg.exe",
    args: ["add", op.key, "/v", op.name, "/t", op.type, "/d", String(op.value), "/f"],
    admin: isHklm(op.key),
    label: `${op.key}\\${op.name}`,
  };
}

export function regDelStep(key: string, name: string): Step {
  return {
    exe: "reg.exe",
    args: ["delete", key, "/v", name, "/f"],
    admin: isHklm(key),
    ignoreFail: true,
    label: `${key}\\${name} (delete)`,
  };
}

function cmdSteps(
  cmds: string[][],
  prev?: string,
  def?: string,
  admin = true,
  tolerant = false,
): Step[] {
  return cmds.map((c) => {
    const sub = (s: string): string => s.replace(/\{prev\}/g, prev ?? def ?? "");
    const parts = c.map(sub);
    return parts[0] === "ps"
      ? { exe: "ps", args: [parts[1]], admin, ignoreFail: tolerant, label: parts[1].slice(0, 60) }
      : {
          exe: parts[0],
          args: parts.slice(1),
          admin,
          ignoreFail: tolerant,
          label: parts.join(" ").slice(0, 80),
        };
  });
}

/** Снимок прежнего состояния для набора операций. */
async function capture(
  expanded: Concrete[],
  reads: Map<string, RegRead>,
): Promise<{ prev: PrevOp[]; cmds: Map<number, CmdEval> }> {
  const prev: PrevOp[] = [];
  const cmds = new Map<number, CmdEval>();
  for (const op of expanded) {
    if (op.t === "reg") {
      const r = reads.get(regId(op.key, op.name));
      prev.push({
        t: "reg",
        key: op.key,
        name: op.name,
        exists: !!r?.e,
        type: r?.e ? KIND[r.t || ""] : undefined,
        value:
          r?.e && r.v !== null
            ? KIND[r.t || ""] === "REG_DWORD"
              ? Number(r.v) >>> 0
              : r.v
            : undefined,
      });
    } else if (op.noState) {
      prev.push({ t: "cmd", i: op.i, was: false });
    } else {
      const e = await evalCmd(op);
      cmds.set(op.i, e);
      prev.push({ t: "cmd", i: op.i, was: e.on, cap: e.cap, na: e.na || undefined });
    }
  }
  return { prev, cmds };
}

async function applySteps(tweak: Tweak): Promise<{ steps: Step[]; prev: PrevOp[] }> {
  const expanded = await expand(tweak);
  const reads = await readRegs(expanded.filter((o): o is RegOp => o.t === "reg"));
  const { prev } = await capture(expanded, reads);
  const steps: Step[] = [];
  for (const op of expanded) {
    if (op.t === "reg") {
      if (op.opt && !reads.get(regId(op.key, op.name))?.k) continue;
      steps.push(regAddStep(op));
    } else steps.push(...cmdSteps(op.apply, undefined, undefined, op.admin !== false));
  }
  return { steps, prev };
}

function restorePrevSteps(tweak: Tweak, prev: PrevOp[]): Step[] {
  const steps: Step[] = [];
  for (const p of prev) {
    if (p.t === "reg") {
      if (p.exists && p.type && p.value !== undefined)
        steps.push(regAddStep({ key: p.key, name: p.name, type: p.type, value: p.value }));
      else steps.push(regDelStep(p.key, p.name));
    } else {
      const op = tweak.ops[p.i];
      if (op?.t !== "cmd" || p.na) continue;
      const cmds = p.was ? op.apply : op.revert;
      steps.push(...cmdSteps(cmds, p.cap, op.def, op.admin !== false, true));
    }
  }
  return steps;
}

async function defaultSteps(tweak: Tweak): Promise<Step[]> {
  const expanded = await expand(tweak);
  const reads = await readRegs(expanded.filter((o): o is RegOp => o.t === "reg"));
  const steps: Step[] = [];
  for (const op of expanded) {
    if (op.t === "reg") {
      if (op.opt && !reads.get(regId(op.key, op.name))?.k) continue;
      if (op.def !== undefined) steps.push(regAddStep({ ...op, value: op.def }));
      else steps.push(regDelStep(op.key, op.name));
    } else steps.push(...cmdSteps(op.revert, undefined, op.def, op.admin !== false, true));
  }
  return steps;
}

// ───────────────────────────── выполнение шагов ─────────────────────────────

async function runDirect(steps: Step[]): Promise<string[]> {
  const failed: string[] = [];
  for (const s of steps) {
    let r: ExecOut;
    if (s.exe === "ps") r = await runPs(s.args[0], 120000);
    else r = await exec(s.exe, s.args, 60000);
    if (r.code !== 0 && !s.ignoreFail)
      failed.push(`${s.label}: ${(r.stderr || r.stdout).trim().slice(0, 160)}`);
  }
  return failed;
}

async function runElevatedBatch(steps: Step[]): Promise<StepResult> {
  const logFile = path.join(config.DIRS.tmp, `tuning-${Date.now()}.log`);
  const files: string[] = [];
  const lines: string[] = [
    "$ErrorActionPreference = 'Continue'",
    "$fail = 0",
    `$log = ${psQuote(logFile)}`,
  ];
  for (const s of steps) {
    let exe = s.exe;
    let args = s.args;
    if (exe === "ps") {
      const f = writeTmpPs(s.args[0]);
      files.push(f);
      exe = "powershell.exe";
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f];
    }
    lines.push(`& ${psQuote(exe)} ${args.map(psQuote).join(" ")} *> $null`);
    if (!s.ignoreFail)
      lines.push(
        `if ($LASTEXITCODE -ne 0) { $fail++; Add-Content -LiteralPath $log -Value ${psQuote(s.label)} }`,
      );
  }
  lines.push("exit $fail");
  const batch = writeTmpPs(lines.join("\n"));
  try {
    const r = await runElevated(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", batch],
      { timeoutMs: 300000 },
    );
    let failed: string[] = [];
    try {
      failed = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      /* лога нет — ошибок не было */
    }
    if (!r.ok && r.error === "uac_cancelled")
      return { ok: false, failed: [], needsReboot: false, error: "uac_cancelled" };
    return {
      ok: failed.length === 0 && (r.ok || r.exitCode === 0),
      failed,
      needsReboot: false,
      error: r.ok || failed.length ? undefined : r.error || undefined,
    };
  } finally {
    for (const f of [batch, logFile, ...files]) fs.rm(f, { force: true }, () => undefined);
  }
}

export async function runSteps(steps: Step[]): Promise<StepResult> {
  if (!steps.length) return { ok: true, failed: [], needsReboot: false };
  const admin = await isAdmin();
  const direct = steps.filter((s) => !s.admin || admin);
  const elevated = steps.filter((s) => s.admin && !admin);
  const failed: string[] = [];
  if (direct.length) failed.push(...(await runDirect(direct)));
  if (elevated.length) {
    const r = await runElevatedBatch(elevated);
    if (r.error === "uac_cancelled")
      return { ok: false, failed, needsReboot: false, error: "uac_cancelled" };
    failed.push(...r.failed);
    if (r.error) return { ok: false, failed, needsReboot: false, error: r.error };
  }
  dynCache.clear();
  return { ok: failed.length === 0, failed, needsReboot: false };
}

// ───────────────────────────────── резервные копии ─────────────────────────────

interface BackupFile {
  meta: BackupMeta;
  prevs: Record<string, PrevOp[]>;
  applied: string[];
}

/** Снимок текущих значений всех твиков. */
async function captureAll(tweaks: Tweak[]): Promise<Record<string, PrevOp[]>> {
  const expanded = await Promise.all(tweaks.map((t) => expand(t)));
  const reads = await readRegs(expanded.flat().filter((o): o is RegOp => o.t === "reg"));
  const prevs: Record<string, PrevOp[]> = {};
  for (let i = 0; i < tweaks.length; i++)
    prevs[tweaks[i].id] = (await capture(expanded[i], reads)).prev;
  return prevs;
}

export async function createBackup(label: string, auto = false): Promise<BackupMeta> {
  ensureDirs();
  const prevs = await captureAll(TWEAKS);
  const state = readState();
  const meta: BackupMeta = {
    id: `b${Date.now()}`,
    at: Date.now(),
    label: label.slice(0, 80) || "Backup",
    auto,
    tweaks: Object.keys(prevs).length,
  };
  const file: BackupFile = { meta, prevs, applied: Object.keys(state.applied) };
  fs.writeFileSync(path.join(BACKUP_DIR, `${meta.id}.json`), JSON.stringify(file), "utf8");
  // автокопий храним не больше 15
  const autos = listBackups().filter((b) => b.auto);
  for (const old of autos.slice(15)) deleteBackup(old.id);
  pushHistory(state, "backup", true, meta.label);
  writeState(state);
  return meta;
}

export function listBackups(): BackupMeta[] {
  ensureDirs();
  const out: BackupMeta[] = [];
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!/^b\d+\.json$/.test(f)) continue;
    try {
      out.push((JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), "utf8")) as BackupFile).meta);
    } catch {
      /* битый файл пропускаем */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export function deleteBackup(id: string): boolean {
  if (!/^b\d+$/.test(id)) return false;
  try {
    fs.rmSync(path.join(BACKUP_DIR, `${id}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Синхронизировать список «применено нами» с реальным состоянием. */
async function syncApplied(): Promise<void> {
  const st = await statusAll();
  const state = readState();
  for (const s of st) if (state.applied[s.id] && s.state !== "applied") delete state.applied[s.id];
  writeState(state);
}

export async function restoreBackup(id: string): Promise<StepResult> {
  if (!/^b\d+$/.test(id)) return { ok: false, failed: [], needsReboot: false, error: "bad_id" };
  let file: BackupFile;
  try {
    file = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, `${id}.json`), "utf8")) as BackupFile;
  } catch {
    return { ok: false, failed: [], needsReboot: false, error: "not_found" };
  }
  const steps: Step[] = [];
  let reboot = false;
  for (const [tid, prev] of Object.entries(file.prevs)) {
    const tweak = TWEAK_BY_ID.get(tid);
    if (!tweak) continue;
    steps.push(...restorePrevSteps(tweak, prev));
    reboot ||= !!tweak.reboot;
  }
  const r = await runSteps(steps);
  const state = readState();
  pushHistory(
    state,
    "restore",
    r.ok,
    file.meta.label + (r.failed.length ? ` (${r.failed.length} err)` : ""),
  );
  writeState(state);
  await syncApplied();
  return { ...r, needsReboot: reboot };
}

// ───────────────────────────── применение и откат ─────────────────────────────

export interface BatchResult extends StepResult {
  statuses: TweakStatus[];
  backupId?: string;
}

export async function applyBatch(ids: string[], mode: "apply" | "revert"): Promise<BatchResult> {
  const tweaks = [...new Set(ids)].map((id) => TWEAK_BY_ID.get(id)).filter((t): t is Tweak => !!t);
  if (!tweaks.length)
    return { ok: true, failed: [], needsReboot: false, statuses: await statusAll() };
  let backupId: string | undefined;
  if (mode === "apply")
    backupId = (
      await createBackup(`auto: ${tweaks.map((t) => t.id).join(", ")}`.slice(0, 80), true)
    ).id;
  const state = readState();
  const steps: Step[] = [];
  const newPrev: Record<string, PrevOp[]> = {};
  let reboot = false;
  for (const t of tweaks) {
    if (mode === "apply") {
      const a = await applySteps(t);
      steps.push(...a.steps);
      newPrev[t.id] = a.prev;
    } else {
      const saved = state.applied[t.id]?.prev;
      steps.push(...(saved ? restorePrevSteps(t, saved) : await defaultSteps(t)));
    }
    reboot ||= !!t.reboot;
  }
  const r = await runSteps(steps);
  const fresh = readState();
  if (r.ok || !r.error) {
    for (const t of tweaks) {
      if (mode === "apply" && !fresh.applied[t.id])
        fresh.applied[t.id] = { at: Date.now(), prev: newPrev[t.id] };
      if (mode === "revert") delete fresh.applied[t.id];
    }
  }
  pushHistory(
    fresh,
    mode,
    r.ok,
    tweaks
      .map((t) => t.id)
      .join(", ")
      .slice(0, 200),
  );
  writeState(fresh);
  return { ...r, needsReboot: reboot && !r.error, statuses: await statusAll(), backupId };
}

/** Откатить всё, что применило приложение. */
export async function rollbackAll(): Promise<BatchResult> {
  return applyBatch(Object.keys(readState().applied), "revert");
}

// ───────────────────────────── экспорт .reg ─────────────────────────────

const regHive = (key: string): string =>
  key.replace(/^HKLM\\/i, "HKEY_LOCAL_MACHINE\\").replace(/^HKCU\\/i, "HKEY_CURRENT_USER\\");

const regStr = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

function regLine(name: string, type: string, value: string | number | undefined): string {
  if (value === undefined) return `${regStr(name)}=-`;
  if (type === "REG_DWORD")
    return `${regStr(name)}=dword:${(Number(value) >>> 0).toString(16).padStart(8, "0")}`;
  return `${regStr(name)}=${regStr(String(value))}`;
}

/** Текст .reg для выбранных твиков (apply — значения твика, revert — значения по умолчанию). */
export async function exportReg(ids: string[], mode: "apply" | "revert"): Promise<string> {
  const lines = ["Windows Registry Editor Version 5.00", ""];
  for (const id of ids) {
    const t = TWEAK_BY_ID.get(id);
    if (!t) continue;
    lines.push(`; ${id}`);
    const byKey = new Map<string, string[]>();
    for (const op of await expand(t)) {
      if (op.t !== "reg") {
        lines.push(
          `; (command) ${(mode === "apply" ? op.apply : op.revert).map((c) => c.join(" ")).join(" && ")}`.slice(
            0,
            300,
          ),
        );
        continue;
      }
      const v = mode === "apply" ? op.value : op.def;
      const arr = byKey.get(op.key) || [];
      arr.push(regLine(op.name, op.type, v));
      byKey.set(op.key, arr);
    }
    for (const [key, vals] of byKey) lines.push(`[${regHive(key)}]`, ...vals, "");
  }
  return lines.join("\r\n");
}

// ───────────────────────────── точка восстановления ─────────────────────────────

export async function createRestorePoint(): Promise<StepResult> {
  const script = [
    "$p = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore'",
    "$old = (Get-ItemProperty -Path $p -Name SystemRestorePointCreationFrequency -EA SilentlyContinue).SystemRestorePointCreationFrequency",
    "Set-ItemProperty -Path $p -Name SystemRestorePointCreationFrequency -Value 0 -Type DWord",
    "try { Enable-ComputerRestore -Drive \"$env:SystemDrive\\\" -EA SilentlyContinue; Checkpoint-Computer -Description 'MoonApp tuning' -RestorePointType MODIFY_SETTINGS -EA Stop } catch { $e = 1 }",
    "if ($null -eq $old) { Remove-ItemProperty -Path $p -Name SystemRestorePointCreationFrequency -EA SilentlyContinue } else { Set-ItemProperty -Path $p -Name SystemRestorePointCreationFrequency -Value $old }",
    "if ($e) { exit 1 }",
  ].join("\n");
  const r = await runSteps([{ exe: "ps", args: [script], admin: true, label: "restore point" }]);
  const state = readState();
  pushHistory(state, "restorePoint", r.ok, r.error || r.failed.join("; ").slice(0, 160));
  writeState(state);
  return r;
}

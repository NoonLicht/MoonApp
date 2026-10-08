/**
 * Твики из ChrisTitusTech/winutil (лицензия MIT), перенесённые на движок «Тюнинга ПК».
 *
 * Значения реестра, списки служб и PowerShell-скрипты взяты из конфигов winutil как есть
 * (server/ts/winutilData.ts — автогенерация). Эта обёртка лишь превращает их в `Tweak`:
 *  - реестр → RegOp (прежнее значение winutil = `def`, `<RemoveEntry>` = значения нет);
 *  - службы → одна CmdOp на твик (проверка: все существующие службы в нужном режиме);
 *  - InvokeScript/UndoScript → CmdOp без проверяемого состояния (`noState`).
 */
import type { CmdOp, Op, RegOp, Risk, Tweak } from "./tuningTypes";
import { WU_APPX, WU_TWEAKS } from "./winutilData";
import type { WuSvc, WuTweak } from "./winutilData";

/** Функции winutil, которые вызывают его скрипты, — в виде заглушек и упрощённых аналогов. */
export const WU_PRELUDE = `
function Write-WinUtilLog { param($Component, $Message, $Level) }
function Step-WinUtilJob { param($Status, $State, $Percent) }
function Show-WinUtilMessage { param($Message, $Title, $Button, $Icon) Write-Host $Message }
function Invoke-WinUtilExplorerUpdate {
  param([string]$action = "refresh")
  if ($action -eq "restart") { taskkill.exe /F /IM "explorer.exe" | Out-Null; Start-Process "explorer.exe" }
}
`;

const NO_UNDO = "# winutil: отката нет";

const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Скрипт winutil, выполняемый вместе с заглушками. */
export const wuScript = (body: string): string[] => ["ps", `${WU_PRELUDE}\n${body}`];

function svcOp(list: WuSvc[]): CmdOp {
  const table = (pick: (s: WuSvc) => string): string =>
    "@(" + list.map((s) => `@(${psq(s.name)}, ${psq(pick(s))})`).join(",") + ")";
  const setter = (pick: (s: WuSvc) => string): string =>
    `foreach ($x in ${table(pick)}) { ` +
    `if (-not (Get-Service -Name $x[0] -EA SilentlyContinue)) { continue }; ` +
    `if ($x[1] -eq 'AutomaticDelayedStart') { sc.exe config $x[0] start= delayed-auto | Out-Null } ` +
    `else { Set-Service -Name $x[0] -StartupType $x[1] -EA SilentlyContinue } }`;
  const check =
    `$seen = 0; $diff = 0; foreach ($x in ${table((s) => s.start)}) { ` +
    `$s = Get-Service -Name $x[0] -EA SilentlyContinue; if (-not $s) { continue }; $seen++; ` +
    `$cur = [string]$s.StartType; ` +
    `if ($cur -ne $x[1] -and -not ($x[1] -eq 'AutomaticDelayedStart' -and $cur -eq 'Automatic')) { $diff++ } }; ` +
    `if (-not $seen) { 'missing' } elseif ($diff) { 'diff' } else { 'match' }`;
  return {
    t: "cmd",
    check: ["ps", check],
    on: "^match$",
    na: "^missing$",
    apply: [["ps", setter((s) => s.start)]],
    revert: [["ps", setter((s) => s.orig)]],
    admin: true,
  };
}

const scriptOp = (apply: string | undefined, revert: string | undefined): CmdOp => ({
  t: "cmd",
  check: ["ps", "$null"],
  on: "^$",
  apply: [wuScript(apply ?? "# нет действия")],
  revert: [wuScript(revert ?? NO_UNDO)],
  admin: true,
  noState: true,
});

/** Твики, меняющие поведение системы необратимо или опасно. */
const HIGH_RISK = new Set([
  "wu-remove-edge",
  "wu-remove-one-drive",
  "wu-disable-bit-locker",
  "wu-windows-ai",
  "wu-reserved-storage",
  "wu-disable-notifications",
  "wu-wpbt",
  "wu-delete-temp-files",
  "wu-disk-cleanup",
]);
const REBOOT = new Set([
  "wu-ipv46",
  "wu-teredo",
  "wu-disable-ipv6",
  "wu-wpbt",
  "wu-disable-bit-locker",
  "wu-hiber",
  "wu-s3-sleep",
  "wu-services",
]);

function build(w: WuTweak): Tweak {
  const ops: Op[] = w.reg.map((r): RegOp => ({
    t: "reg",
    key: r.key,
    name: r.name,
    type: r.type,
    value: r.value,
    def: r.def,
  }));
  if (w.svc.length) ops.push(svcOp(w.svc));
  if (w.inv || w.undo) ops.push(scriptOp(w.inv, w.undo));
  const risk: Risk = HIGH_RISK.has(w.id)
    ? 2
    : w.tab === "wu-prefs"
      ? 0
      : w.svc.length || w.inv || w.tab === "wu-advanced"
        ? 1
        : 0;
  return { id: w.id, tab: w.tab, risk, reboot: REBOOT.has(w.id) || undefined, ops };
}

/** Multiplane Overlay: в winutil — выпадающий список; здесь — два независимых режима. */
const DWM = "HKLM\\SOFTWARE\\Microsoft\\Windows\\Dwm";
const GFX = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers";

export function winutilTweaks(): Tweak[] {
  const list = WU_TWEAKS.map(build);
  list.push(
    {
      id: "wu-mpo-compat",
      tab: "wu-prefs",
      risk: 0,
      ops: [{ t: "reg", key: DWM, name: "OverlayTestMode", type: "REG_DWORD", value: 5 }],
    },
    {
      id: "wu-mpo-full",
      tab: "wu-prefs",
      risk: 0,
      ops: [
        { t: "reg", key: DWM, name: "OverlayTestMode", type: "REG_DWORD", value: 5 },
        { t: "reg", key: GFX, name: "DisableOverlays", type: "REG_DWORD", value: 1 },
      ],
    },
  );
  return list;
}

/** AppX-пакеты из appx.json winutil (кроме уже имеющихся в каталоге Debloat). */
export const WU_APPX_LIST: [string, string][] = WU_APPX.map((a) => [a.id, a.pkg]);

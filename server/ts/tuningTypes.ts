/**
 * Типы страницы «Тюнинг ПК» (идеи — valleyofdoom/PC-Tuning).
 *
 * Твик — это набор атомарных операций (`Op`), которые умеют три вещи:
 *  - проверить текущее состояние (применён ли твик),
 *  - применить значение,
 *  - вернуть прежнее (по снимку, сделанному перед применением, либо к значению
 *    по умолчанию Windows, если снимка нет).
 */

export type RegType = "REG_DWORD" | "REG_SZ" | "REG_QWORD" | "REG_EXPAND_SZ";

/** Значение реестра. `def` — значение Windows по умолчанию (undefined → значения нет). */
export interface RegOp {
  t: "reg";
  key: string;
  name: string;
  type: RegType;
  value: string | number;
  def?: string | number;
  /** Не создавать ключ, если его нет (службы/драйверы, которых нет в системе). */
  opt?: boolean;
}

/** Команда с проверкой результата её вывода. */
export interface CmdOp {
  t: "cmd";
  /** Команда проверки; ["ps", скрипт] — PowerShell-скрипт. */
  check: string[];
  /** Вывод проверки трактуется как `ac:<число> dc:<число>` (powercfg -query). */
  pwr?: boolean;
  /** Регулярка (флаги im): вывод проверки означает «применено». */
  on: string;
  /** Регулярка: вывод означает «недоступно в этой системе». */
  na?: string;
  /** Регулярка с группой 1: прежнее значение для отката (`{prev}` в revert). */
  cap?: string;
  apply: string[][];
  revert: string[][];
  /** Значение для `{prev}`, если снимка нет. */
  def?: string;
  admin?: boolean;
  /** Операция без проверяемого состояния (скрипт-побочный эффект): не влияет на статус твика. */
  noState?: boolean;
}

/** Операции, список целей которых определяется на лету. */
export interface DynOp {
  t: "dyn";
  gen: "usbpm" | "nagle" | "msi-gpu" | "msi-nic";
}

export type Op = RegOp | CmdOp | DynOp;

export type TweakTab =
  | "windows"
  | "scheduler"
  | "usb"
  | "network"
  | "drivers"
  | "debloat"
  | "wu-essential"
  | "wu-advanced"
  | "wu-prefs";

/** 0 — безопасно, 1 — осторожно, 2 — снижает безопасность/стабильность. */
export type Risk = 0 | 1 | 2;

export interface Tweak {
  id: string;
  tab: TweakTab;
  risk: Risk;
  reboot?: boolean;
  ops: Op[];
}

export type TweakState = "applied" | "default" | "partial" | "na";

export interface TweakStatus {
  id: string;
  state: TweakState;
  /** Твик применён самим приложением (есть снимок для отката). */
  byApp: boolean;
}

/** Снимок одной операции перед применением. */
export type PrevOp =
  | { t: "reg"; key: string; name: string; exists: boolean; type?: string; value?: string | number }
  | { t: "cmd"; i: number; was: boolean; cap?: string; na?: boolean };

export interface StepResult {
  ok: boolean;
  failed: string[];
  needsReboot: boolean;
  error?: string;
}

export interface BackupMeta {
  id: string;
  at: number;
  label: string;
  auto: boolean;
  tweaks: number;
}

export interface HistoryEntry {
  at: number;
  kind: string;
  ok: boolean;
  detail: string;
}

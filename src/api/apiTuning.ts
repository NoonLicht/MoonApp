/**
 * API страницы «Тюнинг ПК» (server/ts/routes/tuning.ts).
 */
import { req } from "@/api/apiHttp";

export type TuningTabId =
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
export type TuningRisk = 0 | 1 | 2;
export type TweakState = "applied" | "default" | "partial" | "na";

export interface TweakMeta {
  id: string;
  tab: TuningTabId;
  risk: TuningRisk;
  reboot: boolean;
}

export interface TweakStatus {
  id: string;
  state: TweakState;
  byApp: boolean;
}

export interface TuningHistoryEntry {
  at: number;
  kind: string;
  ok: boolean;
  detail: string;
}

export interface TuningOverview {
  admin: boolean;
  tweaks: TweakMeta[];
  statuses: TweakStatus[];
  checklist: Record<string, boolean>;
  history: TuningHistoryEntry[];
  applied: number;
  backups: number;
  ifeo: { exe: string; priority: string }[];
}

export interface TuningResult {
  ok: boolean;
  failed: string[];
  needsReboot: boolean;
  error?: string;
}

export interface TuningBatchResult extends TuningResult {
  statuses: TweakStatus[];
  backupId?: string;
}

export interface TuningBackup {
  id: string;
  at: number;
  label: string;
  auto: boolean;
  tweaks: number;
}

export interface UsbController {
  name: string;
  id: string;
  devices: { name: string; id: string; status: string }[];
}

export interface DriverRow {
  name: string;
  cls: string;
  version: string;
  provider: string;
  date: string;
  id: string;
  msi: boolean | null;
}

export interface ProcRow {
  pid: number;
  name: string;
  priority: string;
  affinity: number;
  mem: number;
}

export interface StartupEntry {
  id: string;
  kind: string;
  scope: "user" | "machine";
  loc: string;
  name: string;
  title: string;
  cmd: string;
  enabled: boolean;
  running: boolean;
  delayed: boolean;
  std: boolean;
  acct: string;
  trig: string;
  path: string;
  exists: boolean;
  company: string;
  desc: string;
  sig: string;
  signer: string;
  vkind: string;
  hidden: boolean;
  ms: boolean;
  flags: string[];
  can: string[];
}

export interface StartupTrashItem {
  id: string;
  at: number;
  kind: string;
  loc: string;
  name: string;
  cmd: string;
  scope: "user" | "machine";
}

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

export interface BenchRun {
  id: string;
  at: number;
  label: string;
  data: Record<string, number>;
}

export interface WuMeta {
  dns: string[];
  dnsCurrent: string;
  actions: string[];
  panels: string[];
  winget: boolean;
}
export interface WuFeatureRow {
  id: string;
  enabled: boolean | null;
  canDisable: boolean;
}
export interface WuApp {
  id: string;
  name: string;
  cat: string;
  winget: string;
}

export const tuningApi = {
  wuMeta: () => req<WuMeta>("GET", "/tuning/wu/meta"),
  wuAction: (id: string) => req<TuningResult>("POST", "/tuning/wu/action", { id }),
  wuDns: (provider: string) => req<TuningResult>("POST", "/tuning/wu/dns", { provider }),
  wuFeatures: () => req<WuFeatureRow[]>("GET", "/tuning/wu/features"),
  wuFeature: (id: string, enable: boolean) =>
    req<TuningResult>("POST", "/tuning/wu/feature", { id, enable }),
  wuPanel: (id: string) => req<TuningResult>("POST", "/tuning/wu/panel", { id }),
  wuApps: () => req<WuApp[]>("GET", "/tuning/wu/apps"),
  wuAppsInstalled: () => req<string[]>("GET", "/tuning/wu/apps/installed"),
  wuAppsRun: (ids: string[], mode: "install" | "uninstall" | "upgrade") =>
    req<TuningResult>("POST", "/tuning/wu/apps", { ids, mode }),
  tuningOverview: () => req<TuningOverview>("GET", "/tuning/overview"),
  tuningApply: (ids: string[]) => req<TuningBatchResult>("POST", "/tuning/apply", { ids }),
  tuningRevert: (ids: string[]) => req<TuningBatchResult>("POST", "/tuning/revert", { ids }),
  tuningRollbackAll: () => req<TuningBatchResult>("POST", "/tuning/rollback-all"),
  tuningReg: (ids: string[], mode: "apply" | "revert") =>
    req<{ text: string }>("POST", "/tuning/reg", { ids, mode }),
  tuningBackups: () => req<TuningBackup[]>("GET", "/tuning/backups"),
  tuningBackupCreate: (label: string) => req<TuningBackup>("POST", "/tuning/backups", { label }),
  tuningBackupRestore: (id: string) => req<TuningResult>("POST", `/tuning/backups/${id}/restore`),
  tuningBackupDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/tuning/backups/${id}`),
  tuningRestorePoint: () => req<TuningResult>("POST", "/tuning/restore-point"),
  tuningUsb: () => req<UsbController[]>("GET", "/tuning/usb"),
  tuningDrivers: () => req<DriverRow[]>("GET", "/tuning/drivers"),
  tuningProcesses: () => req<{ cpus: number; items: ProcRow[] }>("GET", "/tuning/processes"),
  tuningProcessSet: (body: { pid: number; priority?: string; affinity?: number }) =>
    req<TuningResult>("POST", "/tuning/process", body),
  tuningIfeoAdd: (exe: string, priority: string) =>
    req<TuningResult>("POST", "/tuning/ifeo", { exe, priority }),
  tuningIfeoRemove: (exe: string) =>
    req<TuningResult>("DELETE", `/tuning/ifeo?exe=${encodeURIComponent(exe)}`),
  tuningStartup: () => req<StartupEntry[]>("GET", "/tuning/startup"),
  tuningStartupAction: (id: string, action: string) =>
    req<TuningResult>("POST", "/tuning/startup/action", { id, action }),
  tuningStartupTrash: () => req<StartupTrashItem[]>("GET", "/tuning/startup/trash"),
  tuningStartupRestore: (id: string) =>
    req<TuningResult>("POST", "/tuning/startup/restore", { id }),
  tuningStartupDrop: (id: string) =>
    req<{ ok: boolean }>("DELETE", `/tuning/startup/trash/${encodeURIComponent(id)}`),
  tuningBios: () => req<BiosFacts | null>("GET", "/tuning/bios"),
  tuningChecklist: (id: string, checked: boolean) =>
    req<{ ok: boolean }>("POST", "/tuning/checklist", { id, checked }),
  tuningOpen: (what: string) => req<TuningResult>("POST", "/tuning/open", { what }),
  tuningFixes: () => req<string[]>("GET", "/tuning/fixes"),
  tuningFix: (id: string) => req<TuningResult>("POST", "/tuning/fix", { id }),
  tuningBenchList: () => req<BenchRun[]>("GET", "/tuning/bench"),
  tuningBenchRun: (label: string) =>
    req<{ ok: boolean; run?: BenchRun; error?: string }>("POST", "/tuning/bench", { label }),
  tuningBenchDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/tuning/bench/${id}`),
};

/**
 * Инструменты winutil (ChrisTitusTech/winutil, MIT), не сводящиеся к переключателю:
 * DNS, компоненты Windows, режимы обновлений, схема питания, ремонт, старые панели
 * управления и установка программ через winget. Скрипты взяты из winutil как есть
 * (server/ts/winutilData.ts), обёртка — запуск через общий движок с UAC-пакетом.
 */
import { exec, pushHistory, readState, runPs, runSteps, writeState } from "./tuningEngine";
import type { Step } from "./tuningEngine";
import type { StepResult } from "./tuningTypes";
import { WU_APPS, WU_DNS, WU_FEATURES, WU_PANELS, WU_SCRIPTS } from "./winutilData";
import type { WuDns } from "./winutilData";
import { WU_PRELUDE } from "./winutilCatalog";

const fail = (error: string): StepResult => ({ ok: false, failed: [], needsReboot: false, error });

async function run(steps: Step[], kind: string, what: string): Promise<StepResult> {
  const r = await runSteps(steps);
  const st = readState();
  pushHistory(st, kind, r.ok, what);
  writeState(st);
  return r;
}

const psStep = (script: string, admin: boolean, label: string): Step => ({
  exe: "ps",
  args: [`${WU_PRELUDE}\n${script}`],
  admin,
  label,
});

// ───────────────────────────── разовые действия ─────────────────────────────

interface Action {
  script: string;
  admin: boolean;
  reboot?: boolean;
}

const S = WU_SCRIPTS;
const ACTIONS: Record<string, Action> = {
  "updates-default": {
    script: `${S.updatesDefault}\nInvoke-WPFUpdatesdefault`,
    admin: true,
    reboot: true,
  },
  "updates-security": {
    script: `${S.updatesSecurity}\nInvoke-WPFUpdatessecurity`,
    admin: true,
    reboot: true,
  },
  "updates-disable": {
    script: `${S.updatesDisable}\nInvoke-WPFUpdatesdisable -Confirmed`,
    admin: true,
    reboot: true,
  },
  "wu-repair": {
    script: `${S.systemRepair}\n${S.fixesUpdate}\nInvoke-WPFFixesUpdate`,
    admin: true,
    reboot: true,
  },
  "wu-repair-aggressive": {
    script: `${S.systemRepair}\n${S.fixesUpdate}\nInvoke-WPFFixesUpdate -Aggressive $true`,
    admin: true,
    reboot: true,
  },
  "sys-repair": { script: `${S.systemRepair}\nInvoke-WPFSystemRepair`, admin: true },
  "ntp-pool": { script: `${S.ntpPool}\nInvoke-WPFFixesNTPPool`, admin: true },
  "ultperf-add": { script: `${S.ultPerf}\nInvoke-WPFUltimatePerformance -Enable`, admin: true },
  "ultperf-remove": { script: `${S.ultPerf}\nInvoke-WPFUltimatePerformance`, admin: true },
  "ssh-server": { script: `${S.ssh}\nInvoke-WinUtilSSHServer`, admin: true },
  autologon: {
    script:
      "$p = Join-Path $env:TEMP 'Autologon.exe'; " +
      "Invoke-WebRequest -Uri https://live.sysinternals.com/Autologon.exe -OutFile $p; " +
      "Start-Process -FilePath $p -ArgumentList /accepteula",
    admin: false,
  },
  oosu: {
    script:
      "$p = Join-Path $env:TEMP 'ooshutup10.exe'; " +
      "Invoke-WebRequest -Uri https://dl5.oo-software.com/files/ooshutup10/OOSU10.exe -OutFile $p; " +
      "Start-Process -FilePath $p",
    admin: false,
  },
};

export const WU_ACTION_IDS = Object.keys(ACTIONS);

export async function runAction(id: string): Promise<StepResult> {
  const a = ACTIONS[id];
  if (!a) return fail("unknown_action");
  const r = await run([psStep(a.script, a.admin, id)], "wu-action", id);
  return a.reboot ? { ...r, needsReboot: true } : r;
}

// ───────────────────────────────── DNS ─────────────────────────────────

const DNS_NAMES = new Set(["DHCP", ...WU_DNS.map((d) => d.name)]);
export const dnsProviders = (): string[] => ["DHCP", ...WU_DNS.map((d) => d.name)];

/** Порт Set-WinUtilDNS: адреса IPv4/IPv6 и DNS-over-HTTPS для адаптеров в состоянии Up. */
const DNS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$dns = '__JSON__' | ConvertFrom-Json
$Adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
$dohSupported = [bool](Get-Command Add-DnsClientDohServerAddress -ErrorAction SilentlyContinue)
$base = 'HKLM:\\System\\CurrentControlSet\\Services\\Dnscache\\InterfaceSpecificParameters'
if ($dns.DohOnly -and -not $dohSupported) { throw 'DNS over HTTPS is not supported on this system.' }
foreach ($Adapter in $Adapters) {
  $ifp = "$base\\$($Adapter.InterfaceGuid)"
  if ($dns.Reset) {
    Set-DnsClientServerAddress -InterfaceIndex $Adapter.ifIndex -ResetServerAddresses
    netsh interface ip set dnsservers name="$($Adapter.Name)" source=dhcp
    netsh interface ipv6 set dnsservers name="$($Adapter.Name)" source=dhcp
    $doh = "$ifp\\DohInterfaceSettings"
    if (Test-Path $doh) {
      if ($dohSupported) {
        $addrs = @(Get-ChildItem "$doh\\Doh" -EA SilentlyContinue; Get-ChildItem "$doh\\Doh6" -EA SilentlyContinue) | Select-Object -ExpandProperty PSChildName -Unique
        foreach ($ip in $addrs) { if (Get-DnsClientDohServerAddress -ServerAddress $ip -EA SilentlyContinue) { Remove-DnsClientDohServerAddress -ServerAddress $ip -Confirm:$false } }
      }
      Remove-Item -Path $doh -Recurse -Force -EA SilentlyContinue
    }
    continue
  }
  $v4 = @(@($dns.Primary, $dns.Secondary) | Where-Object { $_ })
  $v6 = @(@($dns.Primary6, $dns.Secondary6) | Where-Object { $_ })
  if ($dohSupported -and $dns.DohTemplate) {
    try {
      foreach ($ip in @($dns.Primary, $dns.Secondary, $dns.Primary6, $dns.Secondary6) | Where-Object { $_ }) {
        $tpl = if ($dns.SecondaryDohTemplate -and @($dns.Secondary, $dns.Secondary6) -contains $ip) { $dns.SecondaryDohTemplate } else { $dns.DohTemplate }
        if (Get-DnsClientDohServerAddress -ServerAddress $ip -EA SilentlyContinue) {
          Set-DnsClientDohServerAddress -ServerAddress $ip -DohTemplate $tpl -AllowFallbackToUdp $false -AutoUpgrade $true
        } else {
          Add-DnsClientDohServerAddress -ServerAddress $ip -DohTemplate $tpl -AllowFallbackToUdp $false -AutoUpgrade $true
        }
        $leaf = if ($ip.Contains(':')) { 'Doh6' } else { 'Doh' }
        $rp = "$ifp\\DohInterfaceSettings\\$leaf\\$ip"
        if (-not (Test-Path $rp)) { New-Item -Path $rp -Force | Out-Null }
        New-ItemProperty -Path $rp -Name DohFlags -Value 1 -PropertyType QWord -Force | Out-Null
      }
    } catch { if ($dns.DohOnly) { throw } }
  }
  Set-DnsClientServerAddress -InterfaceIndex $Adapter.ifIndex -ServerAddresses $v4
  Set-DnsClientServerAddress -InterfaceIndex $Adapter.ifIndex -ServerAddresses $v6
}
Clear-DnsClientCache
`;

function dnsPayload(provider: string): Record<string, unknown> {
  if (provider === "DHCP") return { Reset: true };
  const d = WU_DNS.find((x: WuDns) => x.name === provider) as WuDns;
  return {
    Primary: d.primary,
    Secondary: d.secondary,
    Primary6: d.primary6,
    Secondary6: d.secondary6,
    DohTemplate: d.doh,
    SecondaryDohTemplate: d.secondaryDoh,
    DohOnly: d.dohOnly,
  };
}

export async function dnsCurrent(): Promise<string> {
  const r = await runPs(
    "(Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object { (Get-DnsClientServerAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4).ServerAddresses }) -join ', '",
  );
  return r.stdout.trim();
}

export async function dnsSet(provider: string): Promise<StepResult> {
  if (!DNS_NAMES.has(provider)) return fail("unknown_dns");
  const json = JSON.stringify(dnsPayload(provider)).replace(/'/g, "''");
  const script = DNS_SCRIPT.replace("__JSON__", json);
  return run([psStep(script, true, `dns ${provider}`)], "wu-dns", provider);
}

// ──────────────────────── компоненты Windows (feature.json) ────────────────────

export interface FeatureRow {
  id: string;
  /** null — состояние неизвестно (скриптовый пункт без компонента). */
  enabled: boolean | null;
  canDisable: boolean;
}

export async function featuresStatus(): Promise<FeatureRow[]> {
  const r = await runPs(
    "Get-WindowsOptionalFeature -Online | ForEach-Object { $_.FeatureName + '=' + $_.State }",
    120000,
  );
  const map = new Map<string, boolean>();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(.+)=(\w+)$/.exec(line.trim());
    if (m) map.set(m[1].toLowerCase(), /^enabled/i.test(m[2]));
  }
  return WU_FEATURES.map((f) => ({
    id: f.id,
    enabled: f.feature.length
      ? map.size
        ? f.feature.every((n) => map.get(n.toLowerCase()) === true)
        : null
      : null,
    canDisable: f.feature.length > 0,
  }));
}

export async function featureSet(id: string, enable: boolean): Promise<StepResult> {
  const f = WU_FEATURES.find((x) => x.id === id);
  if (!f) return fail("unknown_feature");
  if (!enable && !f.feature.length) return fail("cannot_disable");
  const lines: string[] = ["$ErrorActionPreference = 'Stop'"];
  for (const n of f.feature)
    lines.push(
      enable
        ? `Enable-WindowsOptionalFeature -Online -FeatureName '${n}' -All -NoRestart | Out-Null`
        : `Disable-WindowsOptionalFeature -Online -FeatureName '${n}' -NoRestart | Out-Null`,
    );
  if (enable && f.inv) lines.push(f.inv);
  const r = await run([psStep(lines.join("\n"), true, `${id} ${enable}`)], "wu-feature", id);
  return { ...r, needsReboot: true };
}

// ─────────────────────── старые панели управления ───────────────────────

export const panelIds = (): string[] => WU_PANELS.map((p) => p.id);

export async function openPanel(id: string): Promise<StepResult> {
  const p = WU_PANELS.find((x) => x.id === id);
  if (!p) return fail("unknown_panel");
  const step: Step = p.cmd.startsWith("Start-Process")
    ? psStep(p.cmd, false, id)
    : { exe: "cmd.exe", args: ["/c", "start", '""', p.cmd], admin: false, label: id };
  return run([step], "wu-panel", id);
}

// ─────────────────────────── программы (winget) ───────────────────────────

export interface AppRow {
  id: string;
  name: string;
  cat: string;
  winget: string;
}

export const appsCatalog = (): AppRow[] =>
  WU_APPS.filter((a) => a.winget && a.winget !== "na").map((a) => ({
    id: a.id,
    name: a.name,
    cat: a.cat,
    winget: a.winget as string,
  }));

const APP_BY_ID = new Map(appsCatalog().map((a) => [a.id, a]));

export async function wingetAvailable(): Promise<boolean> {
  const r = await exec("winget", ["--version"], 15000);
  return r.code === 0;
}

/** Установленные программы: winget list, сопоставление по Id пакета. */
export async function appsInstalled(): Promise<string[]> {
  const r = await exec("winget", ["list", "--accept-source-agreements"], 90000);
  if (r.code !== 0) return [];
  const text = r.stdout.toLowerCase();
  return appsCatalog()
    .filter((a) => text.includes(a.winget.toLowerCase()))
    .map((a) => a.id);
}

export type AppMode = "install" | "uninstall" | "upgrade";

export async function appsRun(ids: string[], mode: AppMode): Promise<StepResult> {
  const apps = ids.map((i) => APP_BY_ID.get(i)).filter((a): a is AppRow => !!a);
  if (!apps.length) return fail("no_apps");
  const common = ["--silent", "--accept-source-agreements"];
  const steps: Step[] = apps.map((a) => ({
    exe: "winget",
    args:
      mode === "install"
        ? ["install", "--id", a.winget, "-e", ...common, "--accept-package-agreements"]
        : mode === "upgrade"
          ? ["upgrade", "--id", a.winget, "-e", ...common, "--accept-package-agreements"]
          : ["uninstall", "--id", a.winget, "-e", ...common],
    admin: true,
    label: `${mode} ${a.winget}`,
  }));
  return run(steps, "wu-apps", `${mode}: ${apps.map((a) => a.id).join(", ")}`);
}

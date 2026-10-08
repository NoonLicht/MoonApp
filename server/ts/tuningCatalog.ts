/**
 * Каталог твиков страницы «Тюнинг ПК» и перечень пунктов чек-листов.
 *
 * Тексты (название/описание) лежат в i18n: tuning.tw.<id>.t / .d и tuning.cl.<id>.
 * Каждое значение реестра имеет `def` — значение Windows по умолчанию; оно
 * используется для отката, когда снимка «до» нет (твик применили не мы).
 */
import type { CmdOp, Op, RegOp, RegType, Risk, Tweak, TweakTab } from "./tuningTypes";
import { WU_APPX_LIST, winutilTweaks } from "./winutilCatalog";
import { extraTweaks } from "./tuningExtra";

const SYS = "HKLM\\SYSTEM\\CurrentControlSet";
const SOFT = "HKLM\\SOFTWARE";

function reg(
  key: string,
  name: string,
  type: RegType,
  value: string | number,
  def?: string | number,
  opt?: boolean,
): RegOp {
  return { t: "reg", key, name, type, value, def, opt };
}

const dw = (key: string, name: string, value: number, def?: number): RegOp =>
  reg(key, name, "REG_DWORD", value, def);

/** Отключение службы (Start=4). Службы нет в системе → операция пропускается. */
const svc = (name: string, def: number): RegOp =>
  reg(`${SYS}\\Services\\${name}`, "Start", "REG_DWORD", 4, def, true);

/** Параметр схемы электропитания (AC и DC) через powercfg. */
function pwr(sub: string, setting: string, value: number, def: number): CmdOp {
  const set = (cmd: string, v: string): string[] => [
    "powercfg",
    cmd,
    "SCHEME_CURRENT",
    sub,
    setting,
    v,
  ];
  const seq = (v: string): string[][] => [
    set("-setacvalueindex", v),
    set("-setdcvalueindex", v),
    ["powercfg", "-setactive", "SCHEME_CURRENT"],
  ];
  return {
    t: "cmd",
    check: ["powercfg", "-query", "SCHEME_CURRENT", sub, setting],
    pwr: true,
    on: `^ac:${value}\\b`,
    cap: "^ac:(\\d+)",
    apply: seq(String(value)),
    revert: seq("{prev}"),
    def: String(def),
  };
}

const ps = (script: string): string[] => ["ps", script];

/** Твик-переключатель на команде без {prev}: apply/revert — абсолютные действия в обе стороны. */
function cmdToggle(
  check: string[],
  on: string,
  apply: string[][],
  revert: string[][],
  admin = true,
): CmdOp {
  return { t: "cmd", check, on, apply, revert, admin };
}

/**
 * Удаление встроенного приложения (AppX) — для текущих и будущих пользователей.
 * Откат переустанавливает пакет из пути, снятого перед удалением (InstallLocation);
 * без снимка (твик применили не мы) откат невозможен — это best-effort, как и
 * у прочих командных твиков без надёжного состояния по умолчанию.
 */
function appxTweak(id: string, pkg: string): Tweak {
  const check = [
    "ps",
    `$p = Get-AppxPackage -AllUsers -Name '${pkg}' -EA SilentlyContinue | Select-Object -First 1; if ($p) { "present " + $p.InstallLocation }`,
  ];
  const apply = [
    ps(
      `Get-AppxPackage -AllUsers -Name '${pkg}' | Remove-AppxPackage -AllUsers -EA SilentlyContinue; ` +
        `Get-AppxProvisionedPackage -Online | Where-Object { $_.PackageName -like '${pkg}*' } | Remove-AppxProvisionedPackage -Online -EA SilentlyContinue`,
    ),
  ];
  const revert = [
    ps(
      `$path = '{prev}'; if ($path) { $m = Join-Path $path 'AppxManifest.xml'; if (Test-Path $m) { Add-AppxPackage -DisableDevelopmentMode -Register $m -EA SilentlyContinue } }`,
    ),
  ];
  return {
    id,
    tab: "debloat",
    risk: 1,
    // def — заведомо несуществующий путь: безопасная подстановка вместо {prev},
    // когда снимка «до» нет (ревёрт-скрипт сам проверяет Test-Path и тихо выходит).
    ops: [
      {
        t: "cmd",
        check,
        on: "^present\\b",
        cap: "^present (.+)$",
        apply,
        revert,
        admin: true,
        def: "-",
      },
    ],
  };
}

export const TWEAKS: Tweak[] = [];

function add(id: string, tab: TweakTab, risk: Risk, ops: Op[], reboot = false): void {
  TWEAKS.push({ id, tab, risk, reboot: reboot || undefined, ops });
}

// ───────────────────────────── Windows ─────────────────────────────
add(
  "timer-res",
  "windows",
  0,
  [dw(`${SYS}\\Control\\Session Manager\\kernel`, "GlobalTimerResolutionRequests", 1)],
  true,
);
add("fs-8dot3", "windows", 0, [
  dw(`${SYS}\\Control\\FileSystem`, "NtfsDisable8dot3NameCreation", 1, 2),
]);
add("fs-lastaccess", "windows", 0, [
  dw(`${SYS}\\Control\\FileSystem`, "NtfsDisableLastAccessUpdate", 2147483649, 2147483650),
]);
add(
  "fast-startup",
  "windows",
  0,
  [dw(`${SYS}\\Control\\Session Manager\\Power`, "HiberbootEnabled", 0, 1)],
  true,
);
add("gamedvr", "windows", 0, [
  dw("HKCU\\System\\GameConfigStore", "GameDVR_Enabled", 0, 1),
  dw("HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR", "AppCaptureEnabled", 0, 1),
  dw(`${SOFT}\\Policies\\Microsoft\\Windows\\GameDVR`, "AllowGameDVR", 0),
]);
add("fso", "windows", 0, [
  dw("HKCU\\System\\GameConfigStore", "GameDVR_FSEBehaviorMode", 2, 0),
  dw("HKCU\\System\\GameConfigStore", "GameDVR_HonorUserFSEBehaviorMode", 1, 0),
  dw("HKCU\\System\\GameConfigStore", "GameDVR_FSEBehavior", 2, 0),
  dw("HKCU\\System\\GameConfigStore", "GameDVR_DXGIHonorFSEWindowsCompatible", 1, 0),
]);
add("mouse-accel", "windows", 0, [
  reg("HKCU\\Control Panel\\Mouse", "MouseSpeed", "REG_SZ", "0", "1"),
  reg("HKCU\\Control Panel\\Mouse", "MouseThreshold1", "REG_SZ", "0", "6"),
  reg("HKCU\\Control Panel\\Mouse", "MouseThreshold2", "REG_SZ", "0", "10"),
]);
add(
  "power-throttling",
  "windows",
  0,
  [dw(`${SYS}\\Control\\Power\\PowerThrottling`, "PowerThrottlingOff", 1)],
  true,
);
add("transparency", "windows", 0, [
  dw(
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
    "EnableTransparency",
    0,
    1,
  ),
]);
add("bg-apps", "windows", 0, [
  dw(
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications",
    "GlobalUserDisabled",
    1,
  ),
]);
add("uac-always", "windows", 0, [
  dw(
    `${SOFT}\\Microsoft\\Windows\\CurrentVersion\\Policies\\System`,
    "ConsentPromptBehaviorAdmin",
    2,
    5,
  ),
  dw(
    `${SOFT}\\Microsoft\\Windows\\CurrentVersion\\Policies\\System`,
    "PromptOnSecureDesktop",
    1,
    1,
  ),
]);
add("telemetry", "windows", 1, [
  svc("DiagTrack", 2),
  svc("dmwappushservice", 3),
  dw(`${SOFT}\\Policies\\Microsoft\\Windows\\DataCollection`, "AllowTelemetry", 0),
]);
add("sysmain", "windows", 1, [svc("SysMain", 2)]);
add("winupdate", "windows", 2, [
  svc("wuauserv", 3),
  dw(`${SOFT}\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU`, "NoAutoUpdate", 1),
]);
add(
  "mitigations",
  "windows",
  2,
  [
    dw(`${SYS}\\Control\\Session Manager\\Memory Management`, "FeatureSettingsOverride", 3),
    dw(`${SYS}\\Control\\Session Manager\\Memory Management`, "FeatureSettingsOverrideMask", 3),
  ],
  true,
);

// ─────────────────────────── Планировщик ───────────────────────────
const PROFILE = `${SOFT}\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile`;
const PROC = "54533251-82be-4824-96c1-47b60b740d00";

add("prio-sep", "scheduler", 0, [
  dw(`${SYS}\\Control\\PriorityControl`, "Win32PrioritySeparation", 38, 2),
]);
add("mmcss", "scheduler", 0, [
  dw(PROFILE, "SystemResponsiveness", 0, 20),
  dw(`${PROFILE}\\Tasks\\Games`, "GPU Priority", 8, 8),
  dw(`${PROFILE}\\Tasks\\Games`, "Priority", 6, 2),
  reg(`${PROFILE}\\Tasks\\Games`, "Scheduling Category", "REG_SZ", "High", "Medium"),
  reg(`${PROFILE}\\Tasks\\Games`, "SFIO Priority", "REG_SZ", "High", "Normal"),
]);
add("power-plan", "scheduler", 0, [
  {
    t: "cmd",
    check: ["powercfg", "-getactivescheme"],
    on: "MoonApp Ultimate|8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c|e9a42b02-d5df-448d-aa00-03f14749eb61",
    cap: "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})",
    apply: [
      ps(
        "$o = powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61; " +
          "$g = [regex]::Match(($o | Out-String), '[0-9a-fA-F-]{36}').Value; " +
          "if ($g) { powercfg -changename $g 'MoonApp Ultimate Performance'; powercfg -setactive $g } " +
          "else { powercfg -setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c }; " +
          "if ($LASTEXITCODE -ne 0) { exit 1 }",
      ),
    ],
    revert: [["powercfg", "-setactive", "{prev}"]],
    def: "381b4222-f694-41f0-9685-ff5bb260df2e",
  },
]);
add("core-unpark", "scheduler", 0, [pwr(PROC, "0cc5b647-c1df-4637-891a-dec35c318583", 100, 10)]);
add("cpu-min", "scheduler", 1, [pwr(PROC, "893dee8e-2bef-41e0-89c6-b55d0929964c", 100, 5)]);
add("c-states", "scheduler", 1, [pwr(PROC, "5d76a2ca-e8c0-402f-a133-2158492d58ad", 1, 0)]);
add(
  "platform-tick",
  "scheduler",
  1,
  [
    {
      t: "cmd",
      check: ["bcdedit", "/enum", "{current}"],
      on: "useplatformtick[\\s\\S]*disabledynamictick|disabledynamictick[\\s\\S]*useplatformtick",
      apply: [
        ["bcdedit", "/set", "useplatformtick", "yes"],
        ["bcdedit", "/set", "disabledynamictick", "yes"],
      ],
      revert: [
        ["bcdedit", "/deletevalue", "useplatformtick"],
        ["bcdedit", "/deletevalue", "disabledynamictick"],
      ],
    },
  ],
  true,
);

// ─────────────────────────────── USB ───────────────────────────────
add("usb-suspend", "usb", 0, [
  pwr("2a737441-1930-4402-8d77-b2bebba308a3", "48e6b7a6-50f5-4738-9c8a-8d86b5fd0b3f", 0, 1),
]);
add("usb-device-pm", "usb", 0, [{ t: "dyn", gen: "usbpm" }], true);

// ────────────────────────────── Сеть ───────────────────────────────
add("nagle", "network", 0, [{ t: "dyn", gen: "nagle" }], true);
add("net-throttling", "network", 0, [dw(PROFILE, "NetworkThrottlingIndex", 4294967295, 10)]);
add("qos-reserve", "network", 0, [
  dw(`${SOFT}\\Policies\\Microsoft\\Windows\\Psched`, "NonBestEffortLimit", 0),
]);
add("dns-fast", "network", 0, [
  {
    t: "cmd",
    check: [
      "ps",
      "(Get-DnsClientServerAddress -AddressFamily IPv4 -EA SilentlyContinue | ForEach-Object { $_.ServerAddresses }) -join ','",
    ],
    on: "^1\\.1\\.1\\.1",
    apply: [
      ps(
        "Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object { " +
          "Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses ('1.1.1.1','1.0.0.1') }",
      ),
    ],
    revert: [
      ps(
        "Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object { " +
          "Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses }",
      ),
    ],
  },
]);
add("nic-power", "network", 0, [
  {
    t: "cmd",
    check: [
      "ps",
      "$v = @(); foreach ($k in '*EEE','GreenEthernet','PowerSavingMode','AdvancedEEE','ULPMode') { " +
        "$v += @(Get-NetAdapterAdvancedProperty -RegistryKeyword $k -EA SilentlyContinue | ForEach-Object { $_.RegistryValue }) }; " +
        "if ($v.Count -eq 0) { 'NA' } elseif (($v | Where-Object { $_ -ne '0' }).Count -eq 0) { 'OFF' } else { 'ON' }",
    ],
    on: "^OFF$",
    na: "^NA$",
    apply: [
      ps(
        "foreach ($k in '*EEE','GreenEthernet','PowerSavingMode','AdvancedEEE','ULPMode') { " +
          "Set-NetAdapterAdvancedProperty -Name * -RegistryKeyword $k -RegistryValue 0 -EA SilentlyContinue }",
      ),
    ],
    revert: [
      ps(
        "foreach ($k in '*EEE','GreenEthernet','PowerSavingMode','AdvancedEEE','ULPMode') { " +
          "Reset-NetAdapterAdvancedProperty -Name * -RegistryKeyword $k -EA SilentlyContinue }",
      ),
    ],
  },
]);
add(
  "ipv6-off",
  "network",
  1,
  [dw(`${SYS}\\Services\\Tcpip6\\Parameters`, "DisabledComponents", 255, 0)],
  true,
);

// ───────────────────────────── Драйверы ─────────────────────────────
add("msi-gpu", "drivers", 1, [{ t: "dyn", gen: "msi-gpu" }], true);
add("msi-nic", "drivers", 1, [{ t: "dyn", gen: "msi-nic" }], true);
add("wu-drivers", "drivers", 0, [
  dw(`${SOFT}\\Policies\\Microsoft\\Windows\\WindowsUpdate`, "ExcludeWUDriversInQualityUpdate", 1),
  dw(`${SOFT}\\Microsoft\\Windows\\CurrentVersion\\DriverSearching`, "SearchOrderConfig", 0, 1),
]);
add("nv-telemetry", "drivers", 0, [svc("NvTelemetryContainer", 2)]);

// ──────────────────────────── Debloat (интерфейс) ────────────────────────────
const ADV = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";
const CDM = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager";

add("explorer-extensions", "debloat", 0, [dw(ADV, "HideFileExt", 0, 1)]);
add("explorer-hidden", "debloat", 0, [dw(ADV, "Hidden", 1, 2)]);
add("explorer-fullpath", "debloat", 0, [
  dw(
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\CabinetState",
    "FullPath",
    1,
    0,
  ),
]);
add("taskbar-widgets", "debloat", 0, [dw(ADV, "TaskbarDa", 0, 1)]);
add("taskbar-chat", "debloat", 0, [dw(ADV, "TaskbarMn", 0, 1)]);
add("taskbar-search", "debloat", 0, [
  dw("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search", "SearchboxTaskbarMode", 0, 1),
]);
add("taskbar-taskview", "debloat", 0, [dw(ADV, "ShowTaskViewButton", 0, 1)]);
add("start-ads", "debloat", 0, [
  dw(CDM, "SystemPaneSuggestionsEnabled", 0, 1),
  dw(CDM, "SilentInstalledAppsEnabled", 0, 1),
  dw(CDM, "SubscribedContent-338387Enabled", 0, 1),
]);
add("lock-tips", "debloat", 0, [
  dw(CDM, "RotatingLockScreenEnabled", 0, 1),
  dw(CDM, "SubscribedContent-310093Enabled", 0, 1),
]);
add("storage-sense-off", "debloat", 0, [
  dw(
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy",
    "01",
    0,
    1,
  ),
]);
add("onedrive-startup", "debloat", 0, [
  reg(
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "OneDrive",
    "REG_SZ",
    "",
    undefined,
  ),
]);
add("cortana-off", "debloat", 1, [
  dw("HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search", "AllowCortana", 0),
]);
add(
  "context-menu-classic",
  "debloat",
  1,
  [
    cmdToggle(
      [
        "reg.exe",
        "query",
        "HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32",
      ],
      "InprocServer32",
      [
        [
          "reg.exe",
          "add",
          "HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32",
          "/ve",
          "/t",
          "REG_SZ",
          "/d",
          "",
          "/f",
        ],
      ],
      [
        [
          "reg.exe",
          "delete",
          "HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32",
          "/f",
        ],
      ],
      false,
    ),
  ],
  true,
);

// ───────────────────────── Debloat (встроенные приложения) ─────────────────
const APPX: [string, string][] = [
  ["appx-3dviewer", "Microsoft.Microsoft3DViewer"],
  ["appx-mixedreality", "Microsoft.MixedReality.Portal"],
  ["appx-bingnews", "Microsoft.BingNews"],
  ["appx-bingweather", "Microsoft.BingWeather"],
  ["appx-gethelp", "Microsoft.GetHelp"],
  ["appx-getstarted", "Microsoft.Getstarted"],
  ["appx-messaging", "Microsoft.Messaging"],
  ["appx-officehub", "Microsoft.MicrosoftOfficeHub"],
  ["appx-solitaire", "Microsoft.MicrosoftSolitaireCollection"],
  ["appx-onenote", "Microsoft.Office.OneNote"],
  ["appx-people", "Microsoft.People"],
  ["appx-skype", "Microsoft.SkypeApp"],
  ["appx-feedbackhub", "Microsoft.WindowsFeedbackHub"],
  ["appx-maps", "Microsoft.WindowsMaps"],
  ["appx-yourphone", "Microsoft.YourPhone"],
  ["appx-zunemusic", "Microsoft.ZuneMusic"],
  ["appx-zunevideo", "Microsoft.ZuneVideo"],
  ["appx-xboxapp", "Microsoft.XboxApp"],
];
for (const [id, pkg] of APPX) TWEAKS.push(appxTweak(id, pkg));
// Ещё приложения из appx.json winutil и все его твики (Essential/Advanced/Preferences).
for (const [id, pkg] of WU_APPX_LIST) TWEAKS.push(appxTweak(id, pkg));
TWEAKS.push(...winutilTweaks());
// Дополнительные твики приватности, телеметрии и доступа приложений.
TWEAKS.push(...extraTweaks());

export const TWEAK_BY_ID = new Map(TWEAKS.map((t) => [t.id, t]));

/** Пункты чек-листов (раздел → id). Состояние «отмечено» хранится на сервере. */
export const CHECKLIST: Record<string, string[]> = {
  bios: [
    "bios-backup",
    "bios-update",
    "bios-defaults",
    "bios-xmp",
    "bios-rebar",
    "bios-smt",
    "bios-virt",
    "bios-igpu",
    "bios-devices",
    "bios-csm",
    "bios-cstates",
    "bios-pcie",
    "bios-usb",
    "bios-fans",
  ],
  physical: ["ph-ssd", "ph-ram", "ph-wired", "ph-irq", "ph-cables", "ph-usb-layout"],
  cooling: ["co-paste", "co-airflow", "co-vrm", "co-curve", "co-dust"],
  peripherals: ["pe-clean", "pe-profile", "pe-rgb", "pe-dpi", "pe-monitor", "pe-overdrive"],
  stability: ["st-memtest", "st-prime", "st-temps", "st-timings", "st-clock"],
  install: ["in-gpt", "in-nic", "in-minimal", "in-bloat", "in-restore"],
  maintenance: ["ma-events", "ma-wpr", "ma-cleanup", "ma-backup"],
};

export const CHECKLIST_IDS = new Set(Object.values(CHECKLIST).flat());

/** Приоритеты для процессов (RealTime исключён намеренно: может подвесить систему). */
export const PRIORITIES = ["Idle", "BelowNormal", "Normal", "AboveNormal", "High"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Значения CpuPriorityClass для Image File Execution Options. */
export const IFEO_PRIORITY: Record<Priority, number> = {
  Idle: 1,
  Normal: 2,
  High: 3,
  BelowNormal: 5,
  AboveNormal: 6,
};

/**
 * Дополнительные твики «Тюнинга ПК»: приватность, телеметрия, доступ приложений, лишние
 * компоненты Windows и сторонняя телеметрия.
 *
 * Идеи списка подсмотрены у flick9000/winscript (GPL-3.0), но код не заимствован: каждый твик
 * описан здесь заново — это документированные политики Windows и значения реестра, поэтому
 * лицензия проекта (MIT) не затрагивается. Значения по умолчанию (`def`) нужны для отката,
 * когда снимка «до» нет.
 */
import type { CmdOp, Op, RegOp, RegType, Risk, Tweak, TweakTab } from "./tuningTypes";

const SYS = "HKLM\\SYSTEM\\CurrentControlSet";
const SOFT = "HKLM\\SOFTWARE";
const POL = `${SOFT}\\Policies\\Microsoft\\Windows`;
const CU = "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion";

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
const dw = (key: string, name: string, value: number, def?: number, opt?: boolean): RegOp =>
  reg(key, name, "REG_DWORD", value, def, opt);

/** Служба: Start=4 (отключена); службы нет в системе → операция пропускается. */
const svcOff = (name: string, def: number): RegOp =>
  dw(`${SYS}\\Services\\${name}`, "Start", 4, def, true);

const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Задачи планировщика (путь + имя): отключить / включить обратно. */
function tasksOff(tasks: [string, string][]): CmdOp {
  const table = "@(" + tasks.map(([p, n]) => `@(${psq(p)}, ${psq(n)})`).join(",") + ")";
  const loop = (verb: string): string =>
    `foreach ($x in ${table}) { $t = Get-ScheduledTask -TaskPath $x[0] -TaskName $x[1] -EA SilentlyContinue; ` +
    `if ($t) { ${verb}-ScheduledTask -InputObject $t -EA SilentlyContinue | Out-Null } }`;
  const check =
    `$seen = 0; $on = 0; foreach ($x in ${table}) { ` +
    `$t = Get-ScheduledTask -TaskPath $x[0] -TaskName $x[1] -EA SilentlyContinue; if (-not $t) { continue }; ` +
    `$seen++; if ($t.State -eq 'Disabled') { $on++ } }; ` +
    `if (-not $seen) { 'missing' } elseif ($on -eq $seen) { 'match' } else { 'diff' }`;
  return {
    t: "cmd",
    check: ["ps", check],
    on: "^match$",
    na: "^missing$",
    apply: [["ps", loop("Disable")]],
    revert: [["ps", loop("Enable")]],
    admin: true,
  };
}

/** Необязательный компонент Windows: отключить / включить обратно. */
function featureOff(name: string): CmdOp {
  const q = psq(name);
  return {
    t: "cmd",
    check: [
      "ps",
      `$f = Get-WindowsOptionalFeature -Online -FeatureName ${q} -EA SilentlyContinue; ` +
        `if (-not $f) { 'missing' } elseif ($f.State -eq 'Disabled') { 'match' } else { 'diff' }`,
    ],
    on: "^match$",
    na: "^missing$",
    apply: [
      [
        "ps",
        `Disable-WindowsOptionalFeature -Online -FeatureName ${q} -NoRestart -EA SilentlyContinue | Out-Null`,
      ],
    ],
    revert: [
      [
        "ps",
        `Enable-WindowsOptionalFeature -Online -FeatureName ${q} -All -NoRestart -EA SilentlyContinue | Out-Null`,
      ],
    ],
    admin: true,
  };
}

/** Запрет доступа приложений к возможности (ConsentStore): значение Value = Deny. */
const consent = (cap: string): RegOp =>
  reg(
    `${SOFT}\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\${cap}`,
    "Value",
    "REG_SZ",
    "Deny",
    "Allow",
    true,
  );

// ───────────── Блокировка телеметрических доменов через hosts ─────────────
const HOSTS_MARK = "MoonApp telemetry block";
/** Домены сбора телеметрии и диагностики; серверов обновлений в списке нет. */
const HOSTS_DOMAINS = [
  "vortex.data.microsoft.com",
  "vortex-win.data.microsoft.com",
  "telecommand.telemetry.microsoft.com",
  "oca.telemetry.microsoft.com",
  "sqm.telemetry.microsoft.com",
  "watson.telemetry.microsoft.com",
  "watson.ppe.telemetry.microsoft.com",
  "df.telemetry.microsoft.com",
  "reports.wes.df.telemetry.microsoft.com",
  "wes.df.telemetry.microsoft.com",
  "services.wes.df.telemetry.microsoft.com",
  "sqm.df.telemetry.microsoft.com",
  "telemetry.microsoft.com",
  "telemetry.appex.bing.net",
  "telemetry.urs.microsoft.com",
  "settings-sandbox.data.microsoft.com",
  "vortex-sandbox.data.microsoft.com",
  "survey.watson.microsoft.com",
  "watson.live.com",
  "watson.microsoft.com",
  "statsfe2.ws.microsoft.com",
  "corpext.msitadfs.glbdns2.microsoft.com",
  "compatexchange.cloudapp.net",
  "diagnostics.support.microsoft.com",
  "feedback.windows.com",
  "feedback.microsoft-hohm.com",
  "feedback.search.microsoft.com",
  "choice.microsoft.com",
  "redir.metaservices.microsoft.com",
];

function hostsBlock(): CmdOp {
  const file = "$env:windir\\System32\\drivers\\etc\\hosts";
  const mark = psq(HOSTS_MARK);
  const list = "@(" + HOSTS_DOMAINS.map(psq).join(",") + ")";
  const apply =
    `$h = "${file}"; $t = Get-Content $h -Raw -EA SilentlyContinue; if ($null -eq $t) { $t = '' }; ` +
    `if ($t -notmatch ${mark}) { $b = "\`r\`n# >>> " + ${mark} + "\`r\`n" + ` +
    `((${list} | ForEach-Object { "0.0.0.0 $_" }) -join "\`r\`n") + "\`r\`n# <<< " + ${mark} + "\`r\`n"; ` +
    `Add-Content -Path $h -Value $b -Encoding ASCII }`;
  const revert =
    `$h = "${file}"; $t = Get-Content $h -Raw -EA SilentlyContinue; if ($t) { ` +
    `$t = [regex]::Replace($t, '(?s)\\r?\\n# >>> ' + [regex]::Escape(${mark}) + '.*?# <<< ' + [regex]::Escape(${mark}) + '\\r?\\n', ''); ` +
    `Set-Content -Path $h -Value $t -Encoding ASCII -NoNewline }`;
  return {
    t: "cmd",
    check: [
      "ps",
      `$t = Get-Content "${file}" -Raw -EA SilentlyContinue; if ($t -match ${mark}) { 'match' } else { 'diff' }`,
    ],
    on: "^match$",
    apply: [["ps", apply]],
    revert: [["ps", revert]],
    admin: true,
  };
}

export function extraTweaks(): Tweak[] {
  const out: Tweak[] = [];
  const add = (id: string, tab: TweakTab, risk: Risk, ops: Op[], reboot = false): void => {
    out.push({ id, tab, risk, reboot: reboot || undefined, ops });
  };

  // ───────────────────────────── Windows ─────────────────────────────
  add("xs-start-recent", "windows", 0, [dw(`${CU}\\Start`, "ShowRecentList", 0, 1)]);
  add("xs-snap-flyout", "windows", 0, [
    dw(`${CU}\\Explorer\\Advanced`, "EnableSnapAssistFlyout", 0, 1),
  ]);
  add("xs-lock-camera", "windows", 0, [dw(`${POL}\\Personalization`, "NoLockScreenCamera", 1)]);
  add("xs-wu-pause", "windows", 0, [
    dw(`${SOFT}\\Microsoft\\WindowsUpdate\\UX\\Settings`, "FlightSettingsMaxPauseDays", 7300),
  ]);
  add("xs-wu-metered", "windows", 0, [
    dw(
      `${SOFT}\\Microsoft\\WindowsUpdate\\UX\\Settings`,
      "AllowAutoWindowsUpdateDownloadOverMeteredNetwork",
      0,
    ),
  ]);
  add("xs-maps-offline", "windows", 0, [
    dw(`${POL}\\Maps`, "AutoDownloadAndUpdateMapData", 0),
    dw(`${POL}\\Maps`, "AllowUntriggeredNetworkTrafficOnSettingsPage", 0),
  ]);
  add("xs-defender-cpu", "windows", 1, [
    dw(`${SOFT}\\Policies\\Microsoft\\Windows Defender\\Scan`, "AvgCPULoadFactor", 25),
    dw(`${SOFT}\\Policies\\Microsoft\\Windows Defender\\Scan`, "ScanAvgCPULoadFactor", 25),
  ]);
  add("xs-notif-center", "windows", 1, [
    dw("HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\Explorer", "DisableNotificationCenter", 1),
  ]);
  add("xs-windowed-opt", "windows", 0, [
    reg(
      "HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences",
      "DirectXUserGlobalSettings",
      "REG_SZ",
      "SwapEffectUpgradeEnable=1;",
    ),
  ]);
  add("xs-menu-delay", "windows", 0, [
    reg("HKCU\\Control Panel\\Desktop", "MenuShowDelay", "REG_SZ", "0", "400"),
    reg("HKCU\\Control Panel\\Mouse", "MouseHoverTime", "REG_SZ", "0", "400"),
  ]);
  add("xs-voice-activation", "windows", 0, [
    dw(
      "HKCU\\SOFTWARE\\Microsoft\\Speech_OneCore\\Settings\\VoiceActivation\\UserPreferenceForAllApps",
      "AgentActivationEnabled",
      0,
      1,
    ),
  ]);
  add("xs-wsearch", "windows", 1, [svcOff("WSearch", 2)], true);
  add(
    "xs-xbox-svc",
    "windows",
    1,
    [
      svcOff("XblAuthManager", 3),
      svcOff("XblGameSave", 3),
      svcOff("XboxGipSvc", 3),
      svcOff("XboxNetApiSvc", 3),
    ],
    true,
  );
  add("xs-gamebar", "windows", 0, [
    dw("HKCU\\SOFTWARE\\Microsoft\\GameBar", "UseNexusForGameBarEnabled", 0, 1),
    dw("HKCU\\SOFTWARE\\Microsoft\\GameBar", "ShowStartupPanel", 0, 1),
  ]);
  add("xs-ps-telemetry", "windows", 0, [
    reg(
      `${SYS}\\Control\\Session Manager\\Environment`,
      "POWERSHELL_TELEMETRY_OPTOUT",
      "REG_SZ",
      "1",
    ),
  ]);
  add("xs-wmdrm", "windows", 0, [dw(`${SOFT}\\Policies\\Microsoft\\WMDRM`, "DisableOnline", 1)]);

  // ─────────────────── ИИ-функции Windows (Copilot, Recall) ───────────────────
  add("xs-copilot", "windows", 0, [
    dw(`${POL}\\WindowsCopilot`, "TurnOffWindowsCopilot", 1),
    dw("HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsCopilot", "TurnOffWindowsCopilot", 1),
    dw(`${CU}\\Explorer\\Advanced`, "ShowCopilotButton", 0, 1),
    dw(`${CU}\\Notifications\\Settings`, "AutoOpenCopilotLargeScreens", 0),
  ]);
  add(
    "xs-recall",
    "windows",
    0,
    [dw(`${POL}\\WindowsAI`, "DisableAIDataAnalysis", 1), featureOff("Recall")],
    true,
  );

  // ───────────────────── Телеметрия и приватность ─────────────────────
  add(
    "xs-telemetry-deep",
    "windows",
    1,
    [
      dw(`${POL}\\DataCollection`, "AllowDesktopAnalyticsProcessing", 0),
      dw(`${POL}\\DataCollection`, "AllowDeviceNameInTelemetry", 0),
      dw(`${POL}\\DataCollection`, "MicrosoftEdgeDataOptIn", 0),
      dw(`${POL}\\DataCollection`, "AllowWUfBCloudProcessing", 0),
      dw(`${POL}\\DataCollection`, "AllowUpdateComplianceProcessing", 0),
      dw(`${POL}\\DataCollection`, "AllowCommercialDataPipeline", 0),
      dw(`${POL}\\DataCollection`, "DisableOneSettingsDownloads", 1),
      dw(`${SOFT}\\Policies\\Microsoft\\SQMClient\\Windows`, "CEIPEnable", 0),
      dw(`${POL}\\Windows Error Reporting`, "Disabled", 1),
      dw(`${SOFT}\\Microsoft\\Windows\\Windows Error Reporting`, "Disabled", 1),
      dw(`${SOFT}\\Microsoft\\Windows\\Windows Error Reporting`, "DontSendAdditionalData", 1),
      dw(`${SOFT}\\Microsoft\\Windows\\Windows Error Reporting`, "LoggingDisabled", 1),
      dw(`${SOFT}\\Microsoft\\Windows\\Windows Error Reporting\\Consent`, "DefaultConsent", 0),
      dw(
        `${SOFT}\\Microsoft\\Windows\\Windows Error Reporting\\Consent`,
        "DefaultOverrideBehavior",
        1,
      ),
    ],
    true,
  );
  add("xs-telemetry-tasks", "windows", 1, [
    tasksOff([
      ["\\Microsoft\\Windows\\Customer Experience Improvement Program\\", "Consolidator"],
      ["\\Microsoft\\Windows\\Customer Experience Improvement Program\\", "KernelCeipTask"],
      ["\\Microsoft\\Windows\\Customer Experience Improvement Program\\", "UsbCeip"],
      ["\\Microsoft\\Windows\\Autochk\\", "Proxy"],
      ["\\Microsoft\\Windows\\DiskDiagnostic\\", "Microsoft-Windows-DiskDiagnosticDataCollector"],
      ["\\Microsoft\\Windows\\Feedback\\Siuf\\", "DmClient"],
      ["\\Microsoft\\Windows\\Feedback\\Siuf\\", "DmClientOnScenarioDownload"],
      ["\\Microsoft\\Windows\\Windows Error Reporting\\", "QueueReporting"],
      ["\\Microsoft\\Windows\\Maps\\", "MapsUpdateTask"],
      ["\\Microsoft\\Windows\\Application Experience\\", "Microsoft Compatibility Appraiser"],
      ["\\Microsoft\\Windows\\Application Experience\\", "ProgramDataUpdater"],
      ["\\Microsoft\\Windows\\Application Experience\\", "StartupAppTask"],
      ["\\Microsoft\\Windows\\Application Experience\\", "PcaPatchDbTask"],
    ]),
  ]);
  add("xs-hosts-block", "windows", 1, [hostsBlock()]);
  add("xs-search-privacy", "windows", 0, [
    dw(`${POL}\\Windows Search`, "ConnectedSearchPrivacy", 3),
    dw(`${POL}\\Windows Search`, "AllowSearchToUseLocation", 0),
    dw(`${POL}\\Windows Search`, "EnableDynamicContentInWSB", 0),
    dw(`${POL}\\Windows Search`, "ConnectedSearchUseWeb", 0),
    dw(`${POL}\\Windows Search`, "ConnectedSearchUseWebOverMeteredConnections", 0),
    dw(`${POL}\\Windows Search`, "DisableWebSearch", 1),
    dw(`${POL}\\Windows Search`, "AllowCloudSearch", 0),
    dw(`${POL}\\Explorer`, "DisableSearchBoxSuggestions", 1),
    dw(`${CU}\\SearchSettings`, "IsDynamicSearchBoxEnabled", 0),
    dw(`${CU}\\SearchSettings`, "IsMSACloudSearchEnabled", 0),
    dw(`${CU}\\SearchSettings`, "IsAADCloudSearchEnabled", 0),
    dw(`${CU}\\SearchSettings`, "IsDeviceSearchHistoryEnabled", 0),
    dw(`${CU}\\Search`, "BingSearchEnabled", 0, 1),
  ]);
  add("xs-feedback", "windows", 0, [
    dw("HKCU\\SOFTWARE\\Microsoft\\Siuf\\Rules", "NumberOfSIUFInPeriod", 0),
    dw(`${POL}\\DataCollection`, "DoNotShowFeedbackNotifications", 1),
  ]);
  add("xs-handwriting", "windows", 0, [
    dw(`${SOFT}\\Policies\\Microsoft\\InputPersonalization`, "RestrictImplicitInkCollection", 1),
    dw(`${SOFT}\\Policies\\Microsoft\\InputPersonalization`, "RestrictImplicitTextCollection", 1),
    dw(`${SOFT}\\Policies\\Microsoft\\InputPersonalization`, "AllowInputPersonalization", 0),
    dw(`${POL}\\HandwritingErrorReports`, "PreventHandwritingErrorReports", 1),
    dw(`${POL}\\TabletPC`, "PreventHandwritingDataSharing", 1),
    dw(
      "HKCU\\SOFTWARE\\Microsoft\\InputPersonalization\\TrainedDataStore",
      "HarvestContacts",
      0,
      1,
    ),
  ]);
  add("xs-ads", "windows", 0, [
    dw(`${CU}\\AdvertisingInfo`, "Enabled", 0, 1),
    dw(`${POL}\\AdvertisingInfo`, "DisabledByGroupPolicy", 1),
    dw("HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\AdvertisingInfo", "DisabledByGroupPolicy", 1),
    dw(`${POL}\\CloudContent`, "DisableTailoredExperiencesWithDiagnosticData", 1),
    dw(`${POL}\\CloudContent`, "DisableWindowsSpotlightFeatures", 1),
    dw(`${POL}\\CloudContent`, "DisableSoftLanding", 1),
    dw("HKCU\\Control Panel\\International\\User Profile", "HttpAcceptLanguageOptOut", 1),
  ]);
  add(
    "xs-content-delivery",
    "windows",
    0,
    [
      "ContentDeliveryAllowed",
      "OemPreInstalledAppsEnabled",
      "PreInstalledAppsEnabled",
      "PreInstalledAppsEverEnabled",
      "SilentInstalledAppsEnabled",
      "SystemPaneSuggestionsEnabled",
      "FeatureManagementEnabled",
      "SubscribedContentEnabled",
      "SubscribedContent-338387Enabled",
      "SubscribedContent-338388Enabled",
      "SubscribedContent-338389Enabled",
      "SubscribedContent-338393Enabled",
      "SubscribedContent-353694Enabled",
      "SubscribedContent-353696Enabled",
      "SubscribedContent-353698Enabled",
    ].map((n) => dw(`${CU}\\ContentDeliveryManager`, n, 0, 1)),
  );
  add("xs-cloud-sync", "windows", 1, [
    dw(`${POL}\\SettingSync`, "DisableSettingSync", 2),
    dw(`${POL}\\SettingSync`, "DisableSettingSyncUserOverride", 1),
    dw(`${POL}\\SettingSync`, "DisableSyncOnPaidNetwork", 1),
    dw(`${POL}\\SettingSync`, "DisableApplicationSettingSync", 2),
    dw(`${POL}\\SettingSync`, "DisableApplicationSettingSyncUserOverride", 1),
    dw(`${POL}\\SettingSync`, "DisableCredentialsSettingSync", 2),
    dw(`${POL}\\SettingSync`, "DisableCredentialsSettingSyncUserOverride", 1),
    dw(`${POL}\\SettingSync`, "DisableDesktopThemeSettingSync", 2),
    dw(`${POL}\\SettingSync`, "DisablePersonalizationSettingSync", 2),
    dw(`${POL}\\SettingSync`, "DisableStartLayoutSettingSync", 2),
    dw(`${POL}\\SettingSync`, "DisableWebBrowserSettingSync", 2),
    dw(`${POL}\\SettingSync`, "DisableWindowsSettingSync", 2),
  ]);

  // ──────────────── Доступ приложений к данным и устройствам ────────────────
  add("xs-access-location", "windows", 1, [consent("location")]);
  add("xs-access-camera-mic", "windows", 1, [consent("webcam"), consent("microphone")]);
  add("xs-access-personal", "windows", 0, [
    consent("contacts"),
    consent("appointments"),
    consent("email"),
    consent("userDataTasks"),
    consent("chat"),
    consent("phoneCallHistory"),
  ]);
  add("xs-access-account", "windows", 0, [consent("userAccountInformation")]);
  add("xs-access-files", "windows", 1, [
    consent("documentsLibrary"),
    consent("picturesLibrary"),
    consent("videosLibrary"),
    consent("broadFileSystemAccess"),
  ]);
  add("xs-access-diag", "windows", 0, [
    consent("appDiagnostics"),
    consent("userNotificationListener"),
    consent("activity"),
    consent("radios"),
  ]);
  add("xs-access-capture", "windows", 1, [
    consent("graphicsCaptureWithoutBorder"),
    consent("graphicsCaptureProgrammatic"),
  ]);
  add("xs-access-ai", "windows", 0, [consent("systemAIModels")]);
  add("xs-access-phone", "windows", 0, [dw(`${POL}\\AppPrivacy`, "LetAppsAccessPhone", 2)]);

  // ─────────────────────── Лишние компоненты и сторонний софт ───────────────────────
  add("xs-feature-ie", "debloat", 0, [featureOff("Internet-Explorer-Optional-amd64")], true);
  add("xs-feature-fax", "debloat", 0, [featureOff("FaxServicesClientPackage")], true);
  add("xs-feature-wmp", "debloat", 0, [featureOff("WindowsMediaPlayer")], true);
  add("xs-office-telemetry", "debloat", 0, [
    ...["15.0", "16.0"].flatMap((v) => [
      dw(`HKCU\\SOFTWARE\\Microsoft\\Office\\${v}\\Common`, "QMEnable", 0, undefined, true),
      dw(
        `HKCU\\SOFTWARE\\Microsoft\\Office\\${v}\\Common\\Feedback`,
        "Enabled",
        0,
        undefined,
        true,
      ),
      dw(
        `HKCU\\SOFTWARE\\Microsoft\\Office\\${v}\\Outlook\\Options\\Mail`,
        "EnableLogging",
        0,
        undefined,
        true,
      ),
      dw(
        `HKCU\\SOFTWARE\\Policies\\Microsoft\\Office\\${v}\\OSM`,
        "EnableLogging",
        0,
        undefined,
        true,
      ),
      dw(
        `HKCU\\SOFTWARE\\Policies\\Microsoft\\Office\\${v}\\OSM`,
        "EnableUpload",
        0,
        undefined,
        true,
      ),
    ]),
    dw(
      "HKCU\\SOFTWARE\\Microsoft\\Office\\Common\\ClientTelemetry",
      "DisableTelemetry",
      1,
      undefined,
      true,
    ),
    dw(
      "HKCU\\SOFTWARE\\Microsoft\\Office\\16.0\\Common\\ClientTelemetry",
      "DisableTelemetry",
      1,
      undefined,
      true,
    ),
    tasksOff([
      ["\\Microsoft\\Office\\", "OfficeTelemetryAgentFallBack"],
      ["\\Microsoft\\Office\\", "OfficeTelemetryAgentLogOn"],
      ["\\Microsoft\\Office\\", "OfficeTelemetryAgentFallBack2016"],
      ["\\Microsoft\\Office\\", "OfficeTelemetryAgentLogOn2016"],
    ]),
  ]);
  add("xs-vs-telemetry", "debloat", 0, [
    dw("HKCU\\SOFTWARE\\Microsoft\\VisualStudio\\Telemetry", "TurnOffSwitch", 1, undefined, true),
    dw(`${SOFT}\\Policies\\Microsoft\\VisualStudio\\SQM`, "OptIn", 0, undefined, true),
    dw(
      `${SOFT}\\Policies\\Microsoft\\VisualStudio\\Feedback`,
      "DisableFeedbackDialog",
      1,
      undefined,
      true,
    ),
    dw(
      `${SOFT}\\Policies\\Microsoft\\VisualStudio\\Feedback`,
      "DisableEmailInput",
      1,
      undefined,
      true,
    ),
    dw(
      `${SOFT}\\Policies\\Microsoft\\VisualStudio\\Feedback`,
      "DisableScreenshotCapture",
      1,
      undefined,
      true,
    ),
    dw(
      `${SOFT}\\Policies\\Microsoft\\VisualStudio\\IntelliCode`,
      "DisableRemoteAnalysis",
      1,
      undefined,
      true,
    ),
  ]);
  add("xs-media-telemetry", "debloat", 0, [
    dw("HKCU\\SOFTWARE\\Microsoft\\MediaPlayer\\Preferences", "UsageTracking", 0, undefined, true),
    dw(
      "HKCU\\SOFTWARE\\Policies\\Microsoft\\WindowsMediaPlayer",
      "PreventCDDVDMetadataRetrieval",
      1,
      undefined,
      true,
    ),
    dw(
      "HKCU\\SOFTWARE\\Policies\\Microsoft\\WindowsMediaPlayer",
      "PreventMusicFileMetadataRetrieval",
      1,
      undefined,
      true,
    ),
    dw(
      "HKCU\\SOFTWARE\\Policies\\Microsoft\\WindowsMediaPlayer",
      "PreventRadioPresetsRetrieval",
      1,
      undefined,
      true,
    ),
  ]);
  add("xs-ccleaner", "debloat", 0, [
    ...[
      "Monitoring",
      "HelpImproveCCleaner",
      "SystemMonitoring",
      "UpdateAuto",
      "UpdateCheck",
      "CheckTrialOffer",
    ].map((n) => dw("HKCU\\SOFTWARE\\Piriform\\CCleaner", n, 0, undefined, true)),
    ...[
      "(Cfg)HealthCheck",
      "(Cfg)QuickClean",
      "(Cfg)QuickCleanIpm",
      "(Cfg)GetIpmForTrial",
      "(Cfg)SoftwareUpdater",
      "(Cfg)SoftwareUpdaterIpm",
    ].map((n) => dw(`${SOFT}\\Piriform\\CCleaner`, n, 0, undefined, true)),
  ]);
  add("xs-google-update", "debloat", 1, [svcOff("gupdate", 2), svcOff("gupdatem", 3)]);
  add("xs-adobe-update", "debloat", 1, [
    svcOff("AdobeARMservice", 2),
    svcOff("adobeupdateservice", 2),
    tasksOff([["\\", "Adobe Acrobat Update Task"]]),
  ]);

  return out;
}

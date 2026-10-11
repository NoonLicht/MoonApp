/* eslint-disable */
// Автогенерация из ChrisTitusTech/winutil (лицензия MIT, © Chris Titus Tech).
// Компоненты Windows, DNS-провайдеры, предустановленные AppX-пакеты.
import type { WuFeature, WuDns, WuAppx } from "./types";
export const WU_FEATURES: WuFeature[] = [
  {
    id: "wuf-dotnet",
    feature: ["NetFx4-AdvSrvs", "NetFx3"],
  },
  {
    id: "wuf-hyperv",
    feature: ["Microsoft-Hyper-V-All"],
  },
  {
    id: "wuf-legacymedia",
    feature: ["WindowsMediaPlayer", "MediaPlayback", "DirectPlay", "LegacyComponents"],
  },
  {
    id: "wuf-wsl",
    feature: ["VirtualMachinePlatform", "Microsoft-Windows-Subsystem-Linux"],
  },
  {
    id: "wuf-nfs",
    feature: ["ServicesForNFS-ClientOnly", "ClientForNFS-Infrastructure", "NFS-Administration"],
    inv: "nfsadmin client stop\nSet-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\ClientForNFS\\CurrentVersion\\Default' -Name 'AnonymousUID' -Type DWord -Value 0\nSet-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\ClientForNFS\\CurrentVersion\\Default' -Name 'AnonymousGID' -Type DWord -Value 0\nnfsadmin client start\nnfsadmin client localhost config fileaccess=755 SecFlavors=+sys -krb5 -krb5i",
  },
  {
    id: "wuf-reg-backup",
    feature: [],
    inv: "New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Configuration Manager' -Name 'EnablePeriodicBackup' -Type DWord -Value 1 -Force\n      New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Configuration Manager' -Name 'BackupCount' -Type DWord -Value 2 -Force\n      $action = New-ScheduledTaskAction -Execute 'schtasks' -Argument '/run /i /tn \"\\Microsoft\\Windows\\Registry\\RegIdleBackup\"'\n      $trigger = New-ScheduledTaskTrigger -Daily -At 00:30\n      Register-ScheduledTask -Action $action -Trigger $trigger -TaskName 'AutoRegBackup' -Description 'Create System Registry Backups' -User 'System'",
  },
  {
    id: "wuf-enable-legacy-recovery",
    feature: [],
    inv: "bcdedit /set bootmenupolicy legacy",
  },
  {
    id: "wuf-disable-legacy-recovery",
    feature: [],
    inv: "bcdedit /set bootmenupolicy standard",
  },
  {
    id: "wuf-sandbox",
    feature: ["Containers-DisposableClientVM"],
  },
];
export const WU_DNS: WuDns[] = [
  {
    name: "Google",
    primary: "8.8.8.8",
    secondary: "8.8.4.4",
    primary6: "2001:4860:4860::8888",
    secondary6: "2001:4860:4860::8844",
    doh: "https://dns.google/dns-query",
  },
  {
    name: "Cloudflare",
    primary: "1.1.1.1",
    secondary: "1.0.0.1",
    primary6: "2606:4700:4700::1111",
    secondary6: "2606:4700:4700::1001",
    doh: "https://cloudflare-dns.com/dns-query",
  },
  {
    name: "Cloudflare_Malware",
    primary: "1.1.1.2",
    secondary: "1.0.0.2",
    primary6: "2606:4700:4700::1112",
    secondary6: "2606:4700:4700::1002",
    doh: "https://security.cloudflare-dns.com/dns-query",
  },
  {
    name: "Cloudflare_Malware_Adult",
    primary: "1.1.1.3",
    secondary: "1.0.0.3",
    primary6: "2606:4700:4700::1113",
    secondary6: "2606:4700:4700::1003",
    doh: "https://family.cloudflare-dns.com/dns-query",
  },
  {
    name: "Open_DNS",
    primary: "208.67.222.222",
    secondary: "208.67.220.220",
    primary6: "2620:119:35::35",
    secondary6: "2620:119:53::53",
    doh: "https://doh.opendns.com/dns-query",
  },
  {
    name: "Quad9",
    primary: "9.9.9.9",
    secondary: "149.112.112.112",
    primary6: "2620:fe::fe",
    secondary6: "2620:fe::9",
    doh: "https://dns.quad9.net/dns-query",
  },
  {
    name: "AdGuard_Ads_Trackers",
    primary: "94.140.14.14",
    secondary: "94.140.15.15",
    primary6: "2a10:50c0::ad1:ff",
    secondary6: "2a10:50c0::ad2:ff",
    doh: "https://dns.adguard-dns.com/dns-query",
  },
  {
    name: "AdGuard_Ads_Trackers_Malware_Adult",
    primary: "94.140.14.15",
    secondary: "94.140.15.16",
    primary6: "2a10:50c0::bad1:ff",
    secondary6: "2a10:50c0::bad2:ff",
    doh: "https://family.adguard-dns.com/dns-query",
  },
];
export const WU_APPX: WuAppx[] = [
  {
    id: "wua-microsoft-outlook-for-windows",
    pkg: "Microsoft.OutlookForWindows",
    store: "9NRX63209R7B",
    cat: "Microsoft Apps",
  },
  {
    id: "wua-msteams",
    pkg: "MSTeams",
    store: "XP8BT8DW290MPQ",
    cat: "Microsoft Apps",
  },
  {
    id: "wua-clipchamp-clipchamp",
    pkg: "Clipchamp.Clipchamp",
    store: "9P1J8S7CCWWT",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-bing-search",
    pkg: "Microsoft.BingSearch",
    store: "9NZBF4GT040C",
    cat: "Bing & Web Services",
  },
  {
    id: "wua-microsoft-corporation-ii-quick-assist",
    pkg: "MicrosoftCorporationII.QuickAssist",
    store: "9P7BP5VNWKX5",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-windows-dev-home",
    pkg: "Microsoft.Windows.DevHome",
    store: "9N8MHTPHNGVV",
    cat: "Developer Tools",
  },
  {
    id: "wua-microsoft-windows-cross-device",
    pkg: "MicrosoftWindows.CrossDevice",
    store: "9NTXGKQ8P7N0",
    cat: "Microsoft Ecosystem",
  },
  {
    id: "wua-microsoft-todos",
    pkg: "Microsoft.Todos",
    store: "9NBLGGH5R558",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-power-automate-desktop",
    pkg: "Microsoft.PowerAutomateDesktop",
    store: "9NFTCH6J7FHV",
    cat: "Developer Tools",
  },
  {
    id: "wua-microsoft-microsoft-sticky-notes",
    pkg: "Microsoft.MicrosoftStickyNotes",
    store: "9NBLGGH4QGHW",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-windows-sound-recorder",
    pkg: "Microsoft.WindowsSoundRecorder",
    store: "9WZDNCRFHWKN",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-windows-alarms",
    pkg: "Microsoft.WindowsAlarms",
    store: "9WZDNCRFJ3PR",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-paint",
    pkg: "Microsoft.Paint",
    store: "9PCFS5B6T72H",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-windows-notepad",
    pkg: "Microsoft.WindowsNotepad",
    store: "9MSMLRH6LZF3",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-screen-sketch",
    pkg: "Microsoft.ScreenSketch",
    store: "9MZ95KL8MR0L",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-copilot",
    pkg: "Microsoft.Copilot",
    store: "9NHT9RB2F4HD",
    cat: "Bing & Web Services",
  },
  {
    id: "wua-microsoft-windows-calculator",
    pkg: "Microsoft.WindowsCalculator",
    store: "9WZDNCRFHVN5",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-windows-camera",
    pkg: "Microsoft.WindowsCamera",
    store: "9WZDNCRFJBBG",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-windows-photos",
    pkg: "Microsoft.Windows.Photos",
    store: "9WZDNCRFJBH4",
    cat: "Utilities & Productivity",
  },
  {
    id: "wua-microsoft-gaming-app",
    pkg: "Microsoft.GamingApp",
    store: "9MV0B5HZVK9Z",
    cat: "Xbox & Gaming",
  },
  {
    id: "wua-microsoft-xbox-gaming-overlay",
    pkg: "Microsoft.XboxGamingOverlay",
    store: "9NZKPSTSNW4P",
    cat: "Xbox & Gaming",
  },
  {
    id: "wua-microsoft-xbox-identity-provider",
    pkg: "Microsoft.XboxIdentityProvider",
    store: "9WZDNCRD1HKW",
    cat: "Xbox & Gaming",
  },
  {
    id: "wua-microsoft-xbox-speech-to-text-overlay",
    pkg: "Microsoft.XboxSpeechToTextOverlay",
    cat: "Xbox & Gaming",
  },
  {
    id: "wua-microsoft-xbox-tcui",
    pkg: "Microsoft.Xbox.TCUI",
    cat: "Xbox & Gaming",
  },
  {
    id: "wua-microsoft-start-experiences-app",
    pkg: "Microsoft.StartExperiencesApp",
    store: "9PC1H9VN18CM",
    cat: "Bing & Web Services",
  },
];

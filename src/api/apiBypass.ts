/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { req } from "@/api/apiHttp";
import type {
  TgwsStatus,
  TgwsSettingsPatch,
  ZapretEngine,
  ZapretStrategy,
  ZapretBatFile,
  ZapretUpdate,
  ZapretInstallState,
  ZapretPayload,
  ZapretStatus,
  ZapretDiagnostics,
  ZapretAutoTuneResult,
  ZapretList,
  ZapretProfile,
  ZapretDomain,
  ZapretCheckState,
} from "@/api/apiTypesBypass";
import type {
  ProxyCoreStatus,
  ProxyInstallStatus,
  ProxyLatency,
  ProxySubscription,
  ProxyNode,
  ProxyPingStatus,
  ProxyPageRule,
  KillSwitchStatus,
} from "@/api/types";

export const bypassApi = {
  // TG WS Proxy (страница Bypass): локальный MTProto-прокси для Telegram.
  // Статус несёт всё состояние блока — движок найден? запущен? порт/секрет/лог.
  tgwsStatus: () => req<TgwsStatus>("GET", "/tgws/status"),
  // force — перекачать бинарь, даже если файл уже есть (кнопка «Обновить»).
  tgwsInstall: (force = false) => req<TgwsStatus>("POST", "/tgws/install", { force }),
  // Патч настроек и запуск одной операцией: поля формы и кнопка рядом.
  tgwsStart: (patch: TgwsSettingsPatch = {}) => req<TgwsStatus>("POST", "/tgws/start", patch),
  tgwsStop: () => req<TgwsStatus>("POST", "/tgws/stop"),
  tgwsSaveSettings: (patch: TgwsSettingsPatch) => req<TgwsStatus>("POST", "/tgws/settings", patch),
  tgwsRotateSecret: () => req<TgwsStatus>("POST", "/tgws/secret"),

  // Zapret / DPI Bypass
  zapretEngine: () => req<ZapretEngine>("GET", "/zapret/engine"),
  zapretStrategies: () => req<ZapretStrategy[]>("GET", "/zapret/strategies"),
  zapretBatFiles: () => req<ZapretBatFile[]>("GET", "/zapret/bat-files"),
  zapretUpdate: () => req<ZapretUpdate>("GET", "/zapret/update"),
  zapretInstall: (body?: { tag?: string }) =>
    req<ZapretInstallState>("POST", "/zapret/install", body || {}),
  zapretInstallStatus: () => req<ZapretInstallState>("GET", "/zapret/install-status"),
  zapretPayloads: () => req<ZapretPayload[]>("GET", "/zapret/payloads"),
  zapretStatus: () => req<ZapretStatus>("GET", "/zapret/status"),
  zapretStart: (body: { strategyId?: string; customArgs?: string; mode?: string }) =>
    req<ZapretStatus>("POST", "/zapret/start", body),
  zapretStop: () => req<ZapretStatus>("POST", "/zapret/stop"),
  zapretService: (action: "install" | "remove" | "status", strategyId?: string) =>
    req<{ ok: boolean; installed?: boolean; running?: boolean }>("POST", "/zapret/service", {
      action,
      strategyId,
    }),
  zapretDiagnostics: () => req<ZapretDiagnostics>("POST", "/zapret/diagnostics"),
  zapretDiagnosticsTargets: () =>
    req<{ targets: { id: string; name: string; kind: string; url?: string }[] }>(
      "GET",
      "/zapret/diagnostics",
    ),
  zapretAutoTune: (apply?: boolean) =>
    req<ZapretAutoTuneResult>("POST", "/zapret/auto-tune", { apply }),
  zapretLists: () => req<ZapretList[]>("GET", "/zapret/lists"),
  zapretSaveList: (name: string, content: string) =>
    req<{ ok: boolean }>("PUT", `/zapret/lists/${encodeURIComponent(name)}`, { content }),
  zapretProfiles: () => req<ZapretProfile[]>("GET", "/zapret/profiles"),
  zapretSaveProfile: (body: {
    name: string;
    customArgs?: string;
    isService?: boolean;
    batchFilePath?: string;
  }) => req<ZapretProfile>("POST", "/zapret/profiles", body),
  zapretDeleteProfile: (id: number) => req<{ ok: boolean }>("DELETE", `/zapret/profiles/${id}`),
  zapretActivateProfile: (id: number) =>
    req<ZapretStatus>("POST", `/zapret/profiles/${id}/activate`),
  zapretDomains: () => req<ZapretDomain[]>("GET", "/zapret/domains"),
  zapretAddDomain: (domain: string, type: "include" | "exclude") =>
    req<ZapretDomain[]>("POST", "/zapret/domains", { domain, type }),
  zapretToggleDomain: (id: number, isEnabled: boolean) =>
    req<ZapretDomain[]>("PATCH", `/zapret/domains/${id}`, { isEnabled }),
  zapretDeleteDomain: (id: number) => req<ZapretDomain[]>("DELETE", `/zapret/domains/${id}`),
  zapretCleanup: (body: { discord?: boolean; dns?: boolean }) =>
    req<{ discord?: { freedKb: number }; dns?: { ok: boolean; error?: string } }>(
      "POST",
      "/zapret/cleanup",
      body,
    ),
  zapretGameFilter: (tcp: boolean, udp: boolean) =>
    req<Record<string, unknown>>("POST", "/zapret/gamefilter", { tcp, udp }),
  zapretSaveSettings: (body: {
    dir?: string;
    mode?: string;
    customTargets?: string;
    autoApplyBest?: boolean;
  }) => req<Record<string, unknown>>("POST", "/zapret/settings", body),
  // Проверка конфигов через service.bat (vendor utils/test zapret.ps1) + консоль
  zapretCheckStatus: () => req<ZapretCheckState>("GET", "/zapret/check"),
  zapretCheckStart: (fast?: boolean, strategyId?: string) =>
    req<ZapretCheckState>("POST", "/zapret/check", { fast: fast !== false, strategyId }),
  zapretCheckStop: () => req<ZapretCheckState>("POST", "/zapret/check/stop"),
  zapretServiceDiagnostics: () => req<ZapretCheckState>("POST", "/zapret/service-diagnostics"),
  zapretFixUserLists: () => req<ZapretCheckState>("POST", "/zapret/user-lists"),
  pingProxy: () =>
    req<{ pingMs: number | null; country: string | null; error?: string }>("POST", "/proxy/ping"),

  // Proxy core (встроенный sing-box): узлы, подписки, правила страниц
  proxyCoreStatus: () => req<ProxyCoreStatus>("GET", "/proxycore/status"),
  proxyCoreStart: (p: { id?: number; uri?: string }) =>
    req<ProxyCoreStatus>("POST", "/proxycore/start", p),
  proxyCoreStop: () => req<ProxyCoreStatus>("POST", "/proxycore/stop"),
  proxyCoreInstallStatus: () => req<ProxyInstallStatus>("GET", "/proxycore/install"),
  proxyCoreInstall: () => req<ProxyInstallStatus>("POST", "/proxycore/install/start"),
  proxyCoreLatency: (timeout?: number) =>
    req<ProxyLatency>("GET", `/proxycore/latency${timeout ? `?timeout=${timeout}` : ""}`),
  proxyCoreSubscriptions: () => req<ProxySubscription[]>("GET", "/proxycore/subscriptions"),
  proxyCoreAddSubscription: (name: string, url: string) =>
    req<{ id: number; refresh: { added?: number; error?: string } }>(
      "POST",
      "/proxycore/subscriptions",
      { name, url },
    ),
  proxyCoreRefreshSubscription: (id: number) =>
    req<{ added: number }>("POST", `/proxycore/subscriptions/${id}/refresh`),
  proxyCoreDeleteSubscription: (id: number) =>
    req<{ changes: number }>("DELETE", `/proxycore/subscriptions/${id}`),
  proxyCoreNodes: () => req<ProxyNode[]>("GET", "/proxycore/nodes"),
  proxyCoreSelectNode: (id: number) =>
    req<{ ok: boolean }>("POST", "/proxycore/nodes/select", { id }),
  /** Убрать узел из списка (он останется скрытым и при обновлении подписки). */
  proxyCoreHideNode: (id: number) =>
    req<{ ok: boolean; hidden: boolean }>("DELETE", `/proxycore/nodes/${id}`),
  /** Вернуть ранее скрытый узел. */
  proxyCoreRestoreNode: (id: number) =>
    req<{ ok: boolean; hidden: boolean }>("POST", `/proxycore/nodes/${id}/restore`),
  /** Вернуть все скрытые узлы (или одной подписки). */
  proxyCoreRestoreHidden: (subId?: number) =>
    req<{ ok: boolean; restored: number }>(
      "DELETE",
      `/proxycore/nodes/hidden${subId != null ? `?sub=${subId}` : ""}`,
    ),
  /** Пропинговать все конфиги (реальный TTFB через временное ядро). */
  proxyCorePingNodes: (p: { subId?: number; ids?: number[]; onlyMissing?: boolean } = {}) =>
    req<ProxyPingStatus>("POST", "/proxycore/nodes/ping", p),
  proxyCorePingStatus: () => req<ProxyPingStatus>("GET", "/proxycore/nodes/ping"),
  proxyCorePingCancel: () => req<ProxyPingStatus>("POST", "/proxycore/nodes/ping/cancel"),
  proxyCorePages: () => req<ProxyPageRule[]>("GET", "/proxycore/pages"),
  proxyCoreSetPage: (route: string, isProxied: boolean) =>
    req<{ ok: boolean }>("POST", "/proxycore/pages", { route, isProxied }),
  killSwitchStatus: () => req<KillSwitchStatus>("GET", "/killswitch/status"),
  killSwitchArm: () => req<{ ok: boolean }>("POST", "/killswitch/arm"),
  killSwitchDisarm: () => req<{ ok: boolean; error?: string }>("POST", "/killswitch/disarm"),
};

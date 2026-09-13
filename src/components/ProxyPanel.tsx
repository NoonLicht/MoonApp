import React, { useState, useEffect } from "react";
import { Shield, Power, PowerOff, RefreshCw, X, Download, Clipboard, Activity, Plus, Trash2, Server, Undo2 } from "lucide-react";
import { Btn, Field, ProgressBar } from "../components/ui";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { ProxyCoreStatus, ProxyNode, ProxySubscription, ProxyPageRule, ProxyLatency, ProxyPingStatus } from "../api/types";

// Страницы приложения (id из App.tsx PAGES). Ярлык берём из nav.<id>.
const PAGE_IDS = [
  "store", "convert", "compress", "video", "music", "books", "monitor",
  "aichat", "voice", "archive", "lecture", "bypass", "myspace", "settings",
];

// Протокол → тон бейджа (цвета из theme.css).
const PROTO_TONE: Record<string, string> = {
  vless: "amber", vmess: "violet", trojan: "coral",
  hysteria2: "teal", tuic: "violet", shadowsocks: "neutral", ssh: "neutral",
};

interface ProxyPanelProps {
  onClose: () => void;
}

export default function ProxyPanel({ onClose }: ProxyPanelProps) {
  const { t } = useI18n();
  const [core, setCore] = useState<ProxyCoreStatus | null>(null);
  const [subs, setSubs] = useState<ProxySubscription[]>([]);
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
  const [rules, setRules] = useState<ProxyPageRule[]>([]);
  const [lat, setLat] = useState<ProxyLatency | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const [subName, setSubName] = useState("");
  const [subUrl, setSubUrl] = useState("");
  // Показывать ли узлы, которые пользователь убрал из списка (можно вернуть).
  const [showHidden, setShowHidden] = useState(false);
  // Прогресс «пропинговать все» (приходит с бэкенда, пинг идёт в фоне).
  const [ping, setPing] = useState<ProxyPingStatus | null>(null);

  const isOk = !!(core?.enabled && core?.running);
  // Показываем «движок не найден» ТОЛЬКО когда бэкенд это подтвердил: пока статус
  // не загружен (или в ответе нет блока install), утверждать нечего.
  const engineKnown = !!core?.install;
  const installed = !!(core?.install?.installed);

  const loadAll = async () => {
    try { setCore(await api.proxyCoreStatus()); } catch { /* бэкенд ещё поднимается */ }
    try { setSubs(await api.proxyCoreSubscriptions()); } catch { /* */ }
    try { setNodes(await api.proxyCoreNodes()); } catch { /* */ }
    try { setRules(await api.proxyCorePages()); } catch { /* */ }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Пока идёт «пропинговать все» — опрашиваем прогресс; в конце перечитываем
  // узлы, чтобы в списке появились свежие ping_ms/страны.
  useEffect(() => {
    if (!ping?.running) return;
    const timer = setInterval(async () => {
      try {
        const st = await api.proxyCorePingStatus();
        setPing(st);
        if (!st.running) await loadAll();
      } catch { /* временная ошибка — попробуем на следующем тике */ }
    }, 700);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ping?.running]);

  // Глобальный прокси Chromium (картинки, внешние ресурсы). Локалхост Electron
  // всегда пропускает мимо (proxyBypassRules "<local>" в main-процессе).
  const applySession = (url: string | null) => {
    try { (window as any).appBridge?.applyProxySession?.(url ? { proxyRules: url } : null); } catch { /* dev/браузер */ }
  };

  /** Коды ошибок бэкенда → человеческий текст (неизвестное показываем как есть). */
  const errorText = (raw: string): string => {
    if (!raw) return "";
    if (raw === "sing-box not found") return t("proxy.engineMissing");
    if (raw === "core_start_timeout") return t("proxy.errStartTimeout");
    if (raw.startsWith("port_busy:")) return t("proxy.errPortBusy", { port: raw.slice("port_busy:".length) });
    return raw;
  };

  const toggleCore = async () => {
    setBusy("toggle"); setError("");
    try {
      if (isOk) {
        const s = await api.proxyCoreStop();
        // Слияние, а не замена: частичный ответ не должен «терять» install и
        // включать ложное «движок не найден».
        setCore((prev) => ({ ...(prev || ({} as ProxyCoreStatus)), ...s } as ProxyCoreStatus));
        applySession(null);
      } else {
        const sel = nodes.find((n) => n.isSelected);
        const payload = sel ? { id: sel.id } : (link.trim() ? { uri: link.trim() } : null);
        if (!payload) { setError(t("proxy.noNodes")); setBusy(""); return; }
        const s = await api.proxyCoreStart(payload);
        setCore((prev) => ({ ...(prev || ({} as ProxyCoreStatus)), ...s } as ProxyCoreStatus));
        if (s.enabled && s.running) applySession(`socks5://127.0.0.1:${s.socksPort}`);
        if (s.error) setError(errorText(s.error));
      }
    } catch (e) { setError((e as Error).message); }
    setBusy("");
  };

  const testLatency = async () => {
    setBusy("latency"); setError("");
    try {
      const r = await api.proxyCoreLatency();
      setLat(r);
      if (r.state === "offline" || r.state === "blocked") setError(r.error || t("proxy.pingBlocked"));
    } catch (e) { setError((e as Error).message); }
    setBusy("");
  };

  const selectNode = async (id: number) => {
    setBusy("select");
    try { await api.proxyCoreSelectNode(id); await loadAll(); } catch (e) { setError((e as Error).message); }
    setBusy("");
  };

  const addSub = async () => {
    if (!subUrl.trim()) return;
    setBusy("addsub"); setError("");
    try {
      await api.proxyCoreAddSubscription(subName.trim(), subUrl.trim());
      setSubName(""); setSubUrl("");
      await loadAll();
    } catch (e) { setError((e as Error).message); }
    setBusy("");
  };

  const refreshSub = async (id: number) => {
    setBusy("refresh:" + id); setError("");
    try { await api.proxyCoreRefreshSubscription(id); await loadAll(); } catch (e) { setError((e as Error).message); }
    setBusy("");
  };

  const deleteSub = async (id: number) => {
    setBusy("del:" + id); setError("");
    try { await api.proxyCoreDeleteSubscription(id); await loadAll(); } catch (e) { setError((e as Error).message); }
    setBusy("");
  };

  /** Убрать узел из списка (в подписке он остаётся скрытым, а не удаляется). */
  const hideNode = async (id: number) => {
    setBusy("hide:" + id); setError("");
    try { await api.proxyCoreHideNode(id); await loadAll(); } catch (e) { setError((e as Error).message); }
    setBusy("");
  };

  const restoreNode = async (id: number) => {
    setBusy("hide:" + id); setError("");
    try { await api.proxyCoreRestoreNode(id); await loadAll(); } catch (e) { setError((e as Error).message); }
    setBusy("");
  };

  /** Пропинговать все конфиги подписки (реальный TTFB по каждому узлу). */
  const pingAll = async (subId: number) => {
    setError("");
    try { setPing(await api.proxyCorePingNodes({ subId })); }
    catch (e) { setError((e as Error).message); }
  };

  const stopPing = async () => {
    try { setPing(await api.proxyCorePingCancel()); } catch (e) { setError((e as Error).message); }
  };

  const pasteFromClipboard = async () => {
    try { const txt = await navigator.clipboard.readText(); if (txt) setLink(txt.trim()); }
    catch (e) { setError("Clipboard: " + (e as Error).message); }
  };

  const ruleOf = (route: string) => rules.find((r) => r.route_path === route);
  const isProxied = (route: string) => { const r = ruleOf(route); return r ? r.is_proxied === 1 : true; };

  const togglePage = async (route: string) => {
    setBusy("page:" + route); setError("");
    try { await api.proxyCoreSetPage(route, !isProxied(route)); setRules(await api.proxyCorePages()); }
    catch (e) { setError((e as Error).message); }
    setBusy("");
  };

  const startInstall = async () => {
    setBusy("install");
    try {
      await api.proxyCoreInstall();
      const timer = setInterval(async () => {
        const st = await api.proxyCoreInstallStatus();
        setCore((prev) => (prev ? { ...prev, install: st } : prev));
        if (st.state === "done" || st.state === "error") { clearInterval(timer); setBusy(""); void loadAll(); }
      }, 900);
    } catch (e) { setError((e as Error).message); setBusy(""); }
  };

  /** Строка узла: выбор активного + «убрать из списка» / «вернуть». */
  const renderNode = (n: ProxyNode) => (
    <div key={n.id} className={`proxy-node ${n.isSelected ? "active" : ""}${n.isExcluded ? " excluded" : ""}`}>
      <button
        className="proxy-node-main"
        onClick={() => void selectNode(n.id)}
        title={n.server || ""}
        disabled={n.isExcluded}
      >
        <Server size={13} />
        <span className="proxy-node-name">{n.name || n.server}</span>
        <span className={`proxy-chip-type tone-${PROTO_TONE[n.protocol] || "neutral"}`}>{(n.protocol || "").slice(0, 5).toUpperCase()}</span>
        <span className={`proxy-ping ${pingClass(n)}`}>{n.pingMs != null ? `${n.pingMs}ms` : "—"}</span>
      </button>
      {n.isExcluded ? (
        <button className="proxy-paste" title={t("proxy.restoreNode")} disabled={busy === "hide:" + n.id} onClick={() => void restoreNode(n.id)}>
          <Undo2 size={13} />
        </button>
      ) : (
        <button className="proxy-paste" title={t("proxy.hideNode")} disabled={busy === "hide:" + n.id} onClick={() => void hideNode(n.id)}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );

  // Узлы группируются по подписке: видно, сколько подписок заведено и что каждая
  // принесла. Убранные вручную узлы живут отдельным сворачиваемым списком.
  const nodesOfSub = (subId: number) => nodes.filter((n) => n.subId === subId && !n.isExcluded);
  const hiddenOfSub = (subId: number) => nodes.filter((n) => n.subId === subId && n.isExcluded);
  const hiddenTotal = nodes.filter((n) => n.isExcluded).length;

  const pingClass = (n: ProxyNode) => n.pingMs == null ? "blocked" : (n.pingMs <= 300 ? "online" : "degraded");
  const latClass = lat ? lat.state : "offline";

  return (
    <div className="proxy-panel-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="proxy-panel">
        {/* Шапка */}
        <div className="proxy-panel-header">
          <div className="proxy-panel-title">
            <span className="proxy-shield"><Shield size={18} strokeWidth={2} /></span>
            <div className="proxy-title-text">
              <div className="proxy-eyebrow">{t("proxy.title")}</div>
              <div className="proxy-h1">
                {core?.node ? (core.node.tag || core.node.server) : `${t("proxy.port")} ${core?.socksPort || 10808}`}
              </div>
            </div>
          </div>
          <span className={`proxy-status ${isOk ? "on" : "off"}`}>
            <span className="proxy-status-dot" />
            {isOk ? (core?.node?.country || lat?.country || t("proxy.connected")) : t("proxy.disconnected")}
          </span>
          <button className="proxy-panel-close" onClick={onClose} title={t("common.close")}><X size={15} /></button>
        </div>

        {!!error && <div className="proxy-error">{error}</div>}

        {/* Движок не установлен */}
        {engineKnown && !installed && (
          <div className="proxy-install-section">
            <div className="proxy-error">{t("proxy.engineMissing")}</div>
            <Btn variant="secondary" icon={Download} onClick={startInstall} disabled={busy === "install"}>
              {busy === "install" ? t("common.loading") : t("proxy.installSingBox")}
            </Btn>
            {core?.install?.state === "working" && <ProgressBar value={core.install.progress} />}
            {core?.install?.state === "error" && (
              <div className="proxy-hint">
                {core.install.error === "download_failed" ? t("proxy.installFailed") : core.install.error}
                {core.install.errorDetail ? ` (${core.install.errorDetail})` : ""}
              </div>
            )}
            {/* Где именно искали движок — по этому списку сразу видно, чего не хватает. */}
            {!!core?.install?.candidates?.length && (
              <div className="proxy-hint">
                {t("proxy.enginePaths")}:
                <ul className="proxy-path-list">
                  {core.install.candidates.map((c) => (
                    <li key={c.path} className={c.exists ? "ok" : "miss"}>
                      {c.exists ? "✓" : "✕"} {c.path}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Движок уже в комплекте: показываем только после попытки установки. */}
        {installed && core?.install?.state === "done" && core?.install?.phase === "bundled" && (
          <div className="proxy-hint">{t("proxy.engineBundled")}</div>
        )}

        {/* Быстрое подключение по ссылке (если сервер из подписки не выбран) */}
        <Field label={t("proxy.profile")}>
          <div className="proxy-link-row">
            <input className="proxy-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder={t("proxy.placeholder")} spellCheck={false} />
            <button className="proxy-paste" onClick={pasteFromClipboard} title={t("proxy.paste")}><Clipboard size={14} /></button>
          </div>
        </Field>

        {/* Действия */}
        <div className="proxy-actions">
          <Btn variant="secondary" icon={Activity} onClick={testLatency} disabled={!isOk || busy === "latency"}>
            {busy === "latency" ? t("common.loading") : t("proxy.ping")}
            {lat?.latencyMs != null ? ` · ${lat.latencyMs}ms` : ""}
          </Btn>
          <Btn variant={isOk ? "danger" : "primary"} icon={isOk ? PowerOff : Power} onClick={toggleCore} disabled={busy === "toggle"}>
            {busy === "toggle" ? t("common.loading") : isOk ? t("proxy.disable") : t("proxy.enable")}
          </Btn>
        </div>

        {/* Реальный TTFB-пинг через SOCKS5 + выходной IP */}
        {lat && lat.state !== "offline" && (
          <div className="proxy-lat">
            <span className={`proxy-ping ${latClass}`}>
              {latClass === "online" ? t("proxy.pingOnline") : latClass === "degraded" ? t("proxy.pingDegraded") : t("proxy.pingBlocked")}
            </span>
            <span className="proxy-lat-targets">{lat.targets.map((x) => String(x.status || "—")).join(" / ")}</span>
            {lat.ip && <span className="proxy-lat-ip">{t("proxy.exitIp")}: {lat.ip}{lat.country ? ` · ${lat.country}` : ""}</span>}
          </div>
        )}

        {/* Подписки: каждая со своим списком серверов и своими действиями */}
        <div className="proxy-saved-block">
          <div className="proxy-block-label">{t("proxy.subscriptions")} · {subs.length}</div>
          <div className="proxy-save-bar">
            <input className="proxy-name-input" value={subName} onChange={(e) => setSubName(e.target.value)} placeholder={t("proxy.subName")} />
            <input className="proxy-name-input" value={subUrl} onChange={(e) => setSubUrl(e.target.value)} placeholder={t("proxy.subscriptionUrl")} spellCheck={false} />
            <Btn variant="secondary" icon={Plus} onClick={addSub} disabled={!subUrl.trim() || busy === "addsub"}>
              {t("proxy.addSubscription")}
            </Btn>
          </div>
          {subs.length === 0 && <div className="proxy-hint">{t("proxy.noSubscriptions")}</div>}
          {/* Прогресс «пропинговать все»: пинг идёт в фоне на бэкенде, тут отчёт. */}
          {!!ping && (ping.running || ping.done > 0) && (
            <div className="proxy-ping-progress">
              <div className="proxy-ping-bar">
                <span className="proxy-ping-fill" style={{ width: `${ping.total ? Math.round((100 * ping.done) / ping.total) : 0}%` }} />
              </div>
              <span className="proxy-ping-text">
                {ping.running
                  ? `${t("proxy.pingProgress", { done: ping.done, total: ping.total })}${ping.currentName ? ` · ${ping.currentName}` : ""}`
                  : t("proxy.pingDone", { ok: ping.ok, total: ping.total })}
              </span>
              {ping.running && (
                <button className="proxy-hidden-toggle" onClick={() => void stopPing()}>{t("proxy.pingCancel")}</button>
              )}
            </div>
          )}

          {subs.map((s) => {
            const visible = nodesOfSub(s.id);
            const hidden = hiddenOfSub(s.id);
            return (
              <div key={s.id} className="proxy-sub">
                <div className="proxy-sub-head">
                  <span className="proxy-sub-name">{s.name || s.url}</span>
                  <span className="proxy-sub-meta">
                    {visible.length}{hidden.length > 0 ? ` +${hidden.length}` : ""} · {s.last_updated || ""}
                  </span>
                  <button className="proxy-paste" title={t("proxy.refresh")} disabled={busy === "refresh:" + s.id} onClick={() => void refreshSub(s.id)}>
                    <RefreshCw size={13} className={busy === "refresh:" + s.id ? "spin" : ""} />
                  </button>
                  {/* Пропинговать все конфиги этой подписки (реальный TTFB по каждому) */}
                  <button className="proxy-paste" title={t("proxy.pingAll")} disabled={!!ping?.running || visible.length === 0} onClick={() => void pingAll(s.id)}>
                    <Activity size={13} className={ping?.running && ping.currentId != null ? "spin" : ""} />
                  </button>
                  <button className="proxy-paste" title={t("proxy.delete")} onClick={() => void deleteSub(s.id)}><Trash2 size={13} /></button>
                </div>
                {visible.length === 0 && hidden.length === 0 && <div className="proxy-hint">{t("proxy.noNodes")}</div>}
                <div className="proxy-node-list">{visible.map(renderNode)}</div>
                {hidden.length > 0 && showHidden && (
                  <>
                    <div className="proxy-hidden-label">{t("proxy.hiddenNodes")} · {hidden.length}</div>
                    <div className="proxy-node-list">{hidden.map(renderNode)}</div>
                  </>
                )}
              </div>
            );
          })}
          {hiddenTotal > 0 && (
            <button className="proxy-hidden-toggle" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? t("proxy.collapseHidden") : t("proxy.showHidden", { n: hiddenTotal })}
            </button>
          )}
        </div>

        <div className="proxy-saved-block">
          <div className="proxy-block-label">{t("proxy.perPage")}</div>
          <div className="proxy-page-list">
            {PAGE_IDS.map((route) => {
              const on = isProxied(route);
              return (
                <button
                  key={route}
                  className={`proxy-page ${on ? "on" : "off"}`}
                  disabled={busy === "page:" + route}
                  onClick={() => void togglePage(route)}
                  title={on ? t("proxy.proxied") : t("proxy.direct")}
                >
                  <span className="proxy-page-name">{t(`nav.${route}`)}</span>
                  <span className="proxy-page-flag">{on ? t("proxy.proxied") : t("proxy.direct")}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}


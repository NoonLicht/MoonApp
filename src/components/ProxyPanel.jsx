import React, { useState, useEffect } from "react";
import { Shield, Power, PowerOff, RefreshCw, X, Download, Bookmark, Clipboard } from "lucide-react";
import { Btn, Field, ProgressBar } from "../components/ui";
import { useI18n } from "../i18n";
import { api } from "../api/client";

export default function ProxyPanel({ onClose }) {
  const { t } = useI18n();
  const [status, setStatus] = useState(null);
  const [link, setLink] = useState("");
  const [install, setInstall] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pingLoading, setPingLoading] = useState(false);
  const [pingError, setPingError] = useState(null);
  const [savedVless, setSavedVless] = useState([]);
  const [saveLink, setSaveLink] = useState("");
  const [saveName, setSaveName] = useState("");

  useEffect(() => {
    api.getProxyStatus().then((s) => { setStatus(s); if (s.vlessLink) setLink(s.vlessLink); }).catch(() => {});
    api.getProxyInstall().then((s) => setInstall(s)).catch(() => {});
    loadSaved();
  }, []);

  const loadSaved = async () => { try { setSavedVless(await api.getSavedVless()); } catch {} };

  const toggle = async () => {
    setLoading(true);
    try {
      if (status?.enabled) { const s = await api.stopProxy(); setStatus(s); }
      else { if (!link.trim()) return; const s = await api.startProxy(link.trim()); setStatus(s); }
    } catch (e) { setStatus((prev) => ({ ...prev, error: e.message })); }
    setLoading(false);
  };

  const doPing = async () => {
    setPingLoading(true); setPingError(null);
    try {
      const r = await api.pingProxy();
      setStatus((prev) => ({ ...prev, pingMs: r.pingMs, country: r.country }));
      if (!r.pingMs && r.error) setPingError(r.error);
    } catch (e) { setPingError(e.message); }
    setPingLoading(false);
  };

  const startInstall = async () => {
    try {
      const s = await api.startProxyInstall(); setInstall(s);
      const timer = setInterval(async () => {
        const st = await api.getProxyInstall(); setInstall(st);
        if (st.state === "done" || st.state === "error") { clearInterval(timer); }
      }, 800);
    } catch {}
  };

  const handleSave = async () => {
    const l = link.trim() || saveLink.trim(); if (!l) return;
    const n = saveName.trim() || undefined;
    try { await api.saveVless(l, n); setSaveLink(""); setSaveName(""); await loadSaved(); }
    catch (e) { alert("Save failed: " + e.message); }
  };

  const pasteFromClipboard = async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) setLink(txt.trim());
    } catch (e) { setPingError("Clipboard: " + e.message); }
  };

  const handleDeleteProfile = async (id) => {
    try { await api.deleteVless(id); await loadSaved(); } catch (e) { alert("Delete failed: " + e.message); }
  };

  const isOk = status?.enabled && status?.running;
  const hasError = status?.error && status.error !== "Not running";
  const isInstalled = install?.installed || status?.installed;
return (
    <div className="proxy-panel-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="proxy-panel">
        {/* Шапка */}
        <div className="proxy-panel-header">
          <div className="proxy-panel-title">
            <span className="proxy-shield"><Shield size={18} strokeWidth={2} /></span>
            <div className="proxy-title-text">
              <div className="proxy-eyebrow">{t("proxy.title")}</div>
              <h1 className="proxy-h1">SOCKS5 · 127.0.0.1:{status?.port || 10808}</h1>
            </div>
          </div>
          <span className={"proxy-status " + (isOk ? "on" : "off")}>
            <span className="proxy-status-dot" />
            {isOk ? (status?.country || t("proxy.connected")) : t("proxy.disconnected")}
          </span>
          <button className="proxy-panel-close" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        {hasError && <div className="proxy-error">{status.error}</div>}

        {/* Поле VLESS / JSON */}
        <Field label={t("proxy.profile")}>
          <div className="proxy-link-row">
            <input className="proxy-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="vless://… или JSON-профиль" spellCheck={false} />
            <button className="proxy-paste" onClick={pasteFromClipboard} title={t("proxy.paste")}><Clipboard size={14} /></button>
          </div>
        </Field>

        {/* Сохранённые VLESS */}
        {(savedVless.length > 0 || link) && (
          <div className="proxy-saved-block">
            <div className="proxy-block-label">{t("proxy.savedVless")}</div>
            <div className="proxy-saved-list">
              {savedVless.map((vl) => {
                const isActive = link === vl.link;
                return (
                  <div key={vl.id} className="proxy-chip">
                    <button className={"proxy-chip-main" + (isActive ? " active" : "")} onClick={() => setLink(vl.link)} title={vl.link}>
                      <span className="proxy-chip-name">{vl.name}</span>
                      <span className="proxy-chip-type">vless</span>
                    </button>
                    <button className="proxy-chip-del" onClick={() => handleDeleteProfile(vl.id)} title={t("proxy.delete")}><X size={11} /></button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Сохранение профиля */}
        <div className="proxy-save-bar">
          <input className="proxy-name-input" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={t("proxy.profileName")} />
          <Btn variant="secondary" icon={Bookmark} onClick={handleSave} disabled={!(link.trim() || saveLink.trim())}>{t("proxy.save")}</Btn>
        </div>

        {/* Действия */}
        <div className="proxy-actions">
          <Btn variant="secondary" icon={RefreshCw} onClick={doPing} disabled={!isOk || pingLoading}>
            {pingLoading ? t("common.loading") : t("proxy.ping")}{status?.pingMs != null ? ` · ${status.pingMs}ms` : ""}
          </Btn>
          <Btn variant={isOk ? "danger" : "primary"} icon={isOk ? PowerOff : Power} onClick={toggle} disabled={loading || !link.trim()}>
            {loading ? t("common.loading") : isOk ? t("proxy.disable") : t("proxy.enable")}
          </Btn>
          {pingError && <span className="proxy-error" style={{ flexBasis: "100%" }}>{pingError}</span>}
        </div>

        {/* Установка sing-box */}
        {!isInstalled && (
          <div className="proxy-install-section">
            <Btn variant="secondary" icon={Download} onClick={startInstall} disabled={install?.state === "working"}>
              {install?.state === "working" ? t("common.loading") : t("proxy.installSingBox")}
            </Btn>
            {install?.state === "working" && <ProgressBar value={install.progress} />}
            {install?.error && <div className="proxy-error">{install.error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
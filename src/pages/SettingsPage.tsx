import React, { useState, useEffect, useRef } from "react";
import {
  Settings2, Palette, Gauge, MonitorCog, MessageSquare,
  Package, Repeat, Clapperboard, Mic2, Archive, Activity, Database,
  ShieldCheck, Check, RotateCcw, Video, Music2, BookOpen, User,
  ChevronDown, KeyRound, Save, RefreshCw, Download, FileDown, FolderOpen, ClipboardCopy,
} from "lucide-react";
import { Glass, Btn, Select, SectionHead, Badge, EmptyHint } from "../components/ui";
import { copyToClipboard } from "../components/ContextMenu";
import { snapshotUiSettings } from "../utils/telemetry";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n, LANGS } from "../i18n";
import { api } from "../api/client";

/**
 * РЎРµСЂРІРёСЃРЅС‹Р№ СЃР»РѕРІР°СЂСЊ Р±РµР№РґР¶РµР№ СЂР°Р·РґРµР»РѕРІ: СЃР»РѕРІРѕ РёР· РЅР°СЃС‚СЂРѕРµРє -> РєР»СЋС‡ РїРµСЂРµРІРѕРґР°.
 * РќСѓР¶РµРЅ, С‡С‚РѕР±С‹ Р±РµР№РґР¶Рё ("live", "future", вЂ¦) С‚РѕР¶Рµ Р»РѕРєР°Р»РёР·РѕРІР°Р»РёСЃСЊ.
 */
const BADGE_KEYS: Record<string, string> = {
  "saved auto": "savedAuto",
  "recommended on": "recommended",
  live: "live",
  future: "future",
  active: "active",
  dev: "dev",
};

/**
 * РўРѕС‡РµС‡РЅРѕРµ С‡С‚РµРЅРёРµ РІР»РѕР¶РµРЅРЅРѕРіРѕ Р·РЅР°С‡РµРЅРёСЏ РїРѕ РїСѓС‚Рё "a.b.c".
 * РСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ, С‡С‚РѕР±С‹ РїР°С‚С‡РёС‚СЊ РЅР°СЃС‚СЂРѕР№РєРё (PATCH /settings) СѓР·РєРѕР№ РІРµС‚РєРѕР№.
 */
function getAt(obj: any, path: string): any {
  return path.split(".").reduce((a, k) => (a == null ? a : a[k]), obj);
}

/**
 * РРјРјСѓС‚Р°Р±РµР»СЊРЅРѕ РїРёС€РµС‚ Р·РЅР°С‡РµРЅРёРµ РїРѕ РїСѓС‚Рё "a.b.c" Рё РІРѕР·РІСЂР°С‰Р°РµС‚ РєРѕРїРёСЋ РѕР±СЉРµРєС‚Р°.
 * РўР°Рє РєРѕРјРїРѕРЅРµРЅС‚ РѕСЃС‚Р°С‘С‚СЃСЏ С‡РёСЃС‚С‹Рј: СЃС‚Р°СЂРѕРµ СЃРѕСЃС‚РѕСЏРЅРёРµ РЅРµ РјСѓС‚РёСЂСѓРµС‚СЃСЏ.
 */
function setAt(obj: any, path: string, value: unknown): any {
  const keys = path.split(".");
  const clone = JSON.parse(JSON.stringify(obj));
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return clone;
}

/* ---------- РњРµР»РєРёРµ UI-СЌР»РµРјРµРЅС‚С‹ ---------- */
function Row({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-info">
        <div className="set-label">{label}</div>
        {hint && <div className="muted-sm">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

function BoolRow({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label} hint={hint}>
      <button
        type="button"
        className={`switch ${value ? "is-on" : ""}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={!!value}
      >
        <span className="switch-knob" />
      </button>
    </Row>
  );
}

function NumberInput({ value, onChange, min, max, step, suffix }: { value: number | string; onChange: (v: number | "") => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <div className="num-ctrl">
      <input
        type="number"
        className="num-input"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      />
      {suffix && <span className="muted-sm">{suffix}</span>}
    </div>
  );
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      className="text-input"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/* ---------- Р‘Р»РѕРє СЃРµРєС†РёРё ---------- */
function Section({ title, icon: Icon, badge, children }: { title: string; icon: React.ElementType; badge?: string; children: React.ReactNode }) {
  const { t } = useI18n();
  const badgeText = badge ? t(`badge.${BADGE_KEYS[badge] || badge}`) : null;
  const isFuture = badge === "future";
  return (
    <Glass className="set-section">
      <div className="set-section-head">
        <span className="set-section-icon tone-violet">
          <Icon size={16} strokeWidth={2} />
        </span>
        <span className="set-section-title">{title}</span>
        {badgeText && (
          <Badge tone={isFuture ? "coral" : "violet"} mono>
            {isFuture ? `вљ  ${badgeText}` : badgeText}
          </Badge>
        )}
      </div>
      <div className="set-section-body">{children}</div>
    </Glass>
  );
}

/**
 * РЎРІРѕСЂР°С‡РёРІР°РµРјРѕРµ РїРѕРґРјРµРЅСЋ В«API-РєР»СЋС‡РёВ» РІРЅСѓС‚СЂРё СЂР°Р·РґРµР»Р° AI Chat.
 *
 * РљР°Рє СЌС‚Рѕ СЂР°Р±РѕС‚Р°РµС‚:
 *  - СЃРїРёСЃРѕРє РїСЂРѕРІР°Р№РґРµСЂРѕРІ Р±РµСЂС‘С‚СЃСЏ СЃ GET /settings/providers (РІ РѕС‚РІРµС‚Рµ С‚РѕР»СЊРєРѕ
 *    С„Р»Р°Рі В«РЅР°СЃС‚СЂРѕРµРЅВ», СЃР°РјРё РєР»СЋС‡Рё РЅРёРєРѕРіРґР° РЅРµ РѕС‚РґР°СЋС‚СЃСЏ РєР»РёРµРЅС‚Сѓ);
 *  - РІРІРµРґС‘РЅРЅС‹Р№ РєР»СЋС‡ СѓС…РѕРґРёС‚ РѕРґРёРЅ СЂР°Р· POST-РѕРј РЅР° /settings/providers/:id/key;
 *  - РЅР° СЃРµСЂРІРµСЂРµ РєР»СЋС‡ С€РёС„СЂСѓРµС‚СЃСЏ (safeStorage/DPAPI РІРЅСѓС‚СЂРё Electron, РёРЅР°С‡Рµ
 *    AES-256-GCM СЃ РјР°СЃС‚РµСЂ-РєР»СЋС‡РѕРј) Рё С…СЂР°РЅРёС‚СЃСЏ РІ storage/secrets.json.
 */
function ApiKeysPanel() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<{ id: string; label: string; configured: boolean; stub: boolean }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);

  const refresh = () => {
    api.getProviders().then((list: any) => setProviders(list || [])).catch(() => setProviders([]));
  };
  useEffect(() => { if (open) refresh(); }, [open]);

  const save = async (id: string) => {
    const key = (drafts[id] || "").trim();
    if (!key) return;
    try {
      await api.saveKey(id, key);
      setDrafts((d) => ({ ...d, [id]: "" }));
      setSavedId(id);
      refresh();
      setTimeout(() => setSavedId(null), 1500);
    } catch { /* РѕС€РёР±РєР° СЃРµС‚Рё вЂ” Р±РµР№РґР¶ В«configuredВ» РїСЂРѕСЃС‚Рѕ РЅРµ РѕР±РЅРѕРІРёС‚СЃСЏ */ }
  };

  return (
    <div className="keys-panel">
      <button type="button" className="keys-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <KeyRound size={14} />
        <span>{t("chat.keysSection")}</span>
        <ChevronDown size={14} className={`chev ${open ? "is-open" : ""}`} />
      </button>
      {open && (
        <div className="keys-body">
          <div className="muted-sm">{t("chat.keysHint")}</div>
          {providers.length === 0 && <div className="muted-sm">{t("chat.keysEmpty")}</div>}
          {providers.map((p) => (
            <div className="keys-row" key={p.id}>
              <div className="keys-name">
                <span>{p.label}</span>
                <Badge tone={p.configured ? "teal" : "neutral"} mono>{p.configured ? t("chat.keyConfigured") : t("chat.keyMissing")}</Badge>
              </div>
              <div className="keys-actions">
                <input
                  type="password"
                  className="text-input"
                  value={drafts[p.id] || ""}
                  placeholder={t("chat.keyPlaceholder")}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                />
                <Btn
                  icon={savedId === p.id ? Check : Save}
                  onClick={() => save(p.id)}
                  disabled={!(drafts[p.id] || "").trim()}
                  title={t("chat.keySave")}
                >
                  {savedId === p.id ? t("chat.keySaved") : t("chat.keySave")}
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useI18n();
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [dirtyMap, setDirtyMap] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getSettings().then(setS).catch(() => setError(t("settings.loadError") || "РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РЅР°СЃС‚СЂРѕР№РєРё"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Обновления приложения (appBridge; работают только в packaged-сборке).
  const [updEnabled, setUpdEnabled] = useState(true);
  const [updBusy, setUpdBusy] = useState<string | null>(null);
  const [updStatus, setUpdStatus] = useState("");

  async function toggleUpdates() {
    const br = window.appBridge;
    if (!br?.toggleAutoUpdate) { setUpdStatus(t("settings.updatesDevHint")); return; }
    setUpdBusy("toggle"); setUpdStatus("");
    try {
      const r = await br.toggleAutoUpdate();
      if (r.ok) {
        setUpdEnabled(!!r.enabled);
        setS((cur: any) => (cur ? setAt(cur, "general.autoUpdate", !!r.enabled) : cur));
        setUpdStatus(r.enabled ? t("settings.updatesOnMsg") : t("settings.updatesOffMsg"));
      } else {
        setUpdStatus(t("settings.updatesDevHint"));
      }
    } catch (e) {
      setUpdStatus((e as Error).message);
    } finally {
      setUpdBusy(null);
    }
  }

  async function downloadUpdateNow() {
    const br = window.appBridge;
    if (!br?.downloadUpdate) { setUpdStatus(t("settings.updatesDevHint")); return; }
    setUpdBusy("download"); setUpdStatus(t("settings.updatesChecking"));
    try {
      const r = await br.downloadUpdate();
      if (!r.ok) setUpdStatus(t("settings.updatesError", { msg: r.reason || "" }));
      else if (!r.available) setUpdStatus(t("settings.updatesNone"));
      else setUpdStatus(t("settings.updatesDownloading", { v: r.version || "" }));
    } catch (e) {
      setUpdStatus((e as Error).message);
    } finally {
      setUpdBusy(null);
    }
  }

  // --- Логи и диагностика ---
  // Кнопка собирает ОДИН файл со всеми событиями приложения (клики, навигация,
  // загрузки, предупреждения, ошибки) и кладёт его в storage рядом с программой,
  // чтобы пользователь мог переслать его разработчику.
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagFile, setDiagFile] = useState("");
  const [diagStatus, setDiagStatus] = useState("");
  const [diagCopied, setDiagCopied] = useState(false);

  async function collectLogs() {
    setDiagBusy(true); setDiagCopied(false); setDiagStatus(t("settings.diagCollecting"));
    try {
      // Сначала отправляем снимок локальных настроек интерфейса (localStorage),
      // чтобы он попал в отчёт вместе с настройками страниц из settings.json.
      await snapshotUiSettings();
      const r = await api.collectLogs();
      setDiagFile(r.file);
      setDiagStatus(t("settings.diagReady", {
        events: r.events,
        kb: Math.max(1, Math.round(r.size / 1024)),
      }));
    } catch (e) {
      setDiagStatus(t("settings.diagError", { msg: (e as Error).message }));
    } finally {
      setDiagBusy(false);
    }
  }

  async function revealLogs() {
    const br = (window as any).appBridge;
    if (br?.revealPath && diagFile) await br.revealPath(diagFile);
    else copyToClipboard(diagFile);
  }

  async function copyLogsPath() {
    copyToClipboard(diagFile);
    setDiagCopied(true);
    setTimeout(() => setDiagCopied(false), 1500);
  }

  // Синхронизируем состояние кнопки обновлений с settings.json после загрузки.
  useEffect(() => {
    if (s) setUpdEnabled(s?.general?.autoUpdate !== false);
  }, [s]);

  usePageToolbar(
    <Badge tone="teal" mono>
      {dirtyMap.size ? t("settings.unsaved", { n: dirtyMap.size }) : t("settings.saved")}
    </Badge>,
    [dirtyMap.size, t]
  );

  async function persist(next: any, path: string) {
    setS(next);
    // РЎРѕС…СЂР°РЅСЏРµС‚СЃСЏ С‚РѕР»СЊРєРѕ РёР·РјРµРЅС‘РЅРЅР°СЏ РІРµС‚РєР° (РІР»РѕР¶РµРЅРЅС‹Р№ patch), deep-merge РЅР° СЃРµСЂРІРµСЂРµ.
    const keys = path.split(".");
    let patch: any = {};
    let cur: any = patch;
    for (let i = 0; i < keys.length - 1; i++) {
      cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = getAt(next, path);
    try {
      await api.updateSettings(patch);
      setSaved(true);
      window.dispatchEvent(new CustomEvent("app:setting", { detail: { path, value: getAt(next, path) } }));
      setDirtyMap((d) => { const n = new Set(d); n.delete(path); return n; });
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
      setDirtyMap((d) => new Set(d).add(path));
    }
  }

  function change(path: string, value: unknown) {
    // РЎРїРµС†-РѕР±СЂР°Р±РѕС‚РєР° С‚РµРјС‹: СЃРёРЅС…СЂРѕРЅРёР·РёСЂСѓРµРј РѕСЃРЅРѕРІРЅРѕР№ App.
    if (path === "appearance.theme") {
      window.dispatchEvent(new CustomEvent("app:theme", { detail: value }));
    }
    const next = setAt(s, path, value);
    setDirtyMap((d) => new Set(d).add(path));
    persist(next, path);
  }

  async function resetSection() {
    try {
      const fresh = await api.getSettings();
      setS(fresh);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!s) {
    return (
      <div className="page">
        <EmptyHint icon={Settings2} text={t("settings.loading")} />
      </div>
    );
  }

  const g = s.general, ap = s.appearance, pf = s.performance, win = s.window;
  const chat = s.chat, store = s.store, conv = s.converter;
  // РќРѕРІС‹Рµ СЃРµРєС†РёРё РјРѕРіСѓС‚ РѕС‚СЃСѓС‚СЃС‚РІРѕРІР°С‚СЊ РІ СЃС‚Р°СЂС‹С… settings.json вЂ” РґР°С‘Рј С„РѕР»Р±СЌРєРё.
  const video = s.video || {}, musicS = s.music || {}, books = s.books || {}, mysp = s.myspace || {};
  const media = s.media, voice = s.voice || {}, arch = s.archiver || {}, mon = s.monitor;
  const comp = s.compressor || {}, sb = s.sitebak || {};
  const backup = s.backup, adv = s.advanced;

  return (
    <div className="page page-settings">
      <SectionHead
        eyebrow={t("settings.eyebrow")}
        title={t("settings.title")}
        action={
          <Btn icon={RotateCcw} onClick={resetSection} title={t("settings.reloadTitle")}>
            {t("settings.reload")}
          </Btn>
        }
      />

      {error && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)", color: "var(--text-secondary)" }}>
          <span>{error}</span>
        </Glass>
      )}

      <Glass className="settings-scroll-wrap">
        {/* ---- Store / Р·Р°РіСЂСѓР·РєРё (РґРѕРє: store) ---- */}
        {/* ---- Общее (док: settings) ---- */}
        <Section title={t("settings.general")} icon={Settings2} badge="saved auto">
          <Row label={t("settings.language")} hint={t("settings.languageHint")}>
            <Select
              value={g.language}
              onChange={(e) => change("general.language", e.target.value)}
              options={LANGS.map((l) => ({ value: l.code, label: l.native }))}
            />
          </Row>
          <Row label={t("settings.startPage")} hint={t("settings.startPageHint")}>
            <Select
              value={g.startPage}
              onChange={(e) => change("general.startPage", e.target.value)}
              options={["store", "convert", "compress", "video", "music", "books", "monitor", "myspace", "aichat", "voice", "archive", "settings"]}
            />
          </Row>
          <BoolRow label={t("settings.autoLaunch")} hint={t("settings.autoLaunchHint")} value={g.autoLaunch} onChange={(v) => change("general.autoLaunch", v)} />
          <BoolRow label={t("settings.minimizeToTray")} hint={t("settings.minimizeToTrayHint")} value={g.minimizeToTray} onChange={(v) => change("general.minimizeToTray", v)} />
          <BoolRow label={t("settings.closeToTray")} hint={t("settings.closeToTrayHint")} value={!!g.closeToTray} onChange={(v) => change("general.closeToTray", v)} />
        </Section>

        {/* ---- Обновления приложения (док: general.autoUpdate) ---- */}
        <Section title={t("settings.updatesTitle")} icon={RefreshCw} badge="active">
          <Row label={t("settings.updatesAutoLabel")} hint={t("settings.updatesAutoHint")}>
            <Btn icon={updBusy === "toggle" ? RefreshCw : Check} onClick={toggleUpdates} disabled={updBusy !== null}>
              {updEnabled ? t("settings.updatesDisable") : t("settings.updatesEnable")}
            </Btn>
          </Row>
          <Row label={t("settings.updatesDownloadLabel")} hint={t("settings.updatesDownloadHint")}>
            <Btn
              variant="primary"
              icon={updBusy === "download" ? RefreshCw : Download}
              onClick={downloadUpdateNow}
              disabled={updBusy !== null}
            >
              {t("settings.updatesDownload")}
            </Btn>
          </Row>
          {updStatus && <div className="muted-sm" style={{ marginTop: -6 }}>{updStatus}</div>}
        </Section>

        {/* ---- Логи и диагностика: один файл со всеми событиями ---- */}
        <Section title={t("settings.diagTitle")} icon={FileDown} badge="active">
          <Row label={t("settings.diagLabel")} hint={t("settings.diagHint")}>
            <Btn variant="primary" icon={diagBusy ? RefreshCw : FileDown} onClick={collectLogs} disabled={diagBusy}>
              {diagBusy ? t("settings.diagCollecting") : t("settings.diagCollect")}
            </Btn>
          </Row>
          {diagFile && (
            <Row label={t("settings.diagFile")} hint={diagFile}>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn icon={FolderOpen} onClick={revealLogs} title={t("settings.diagRevealTitle")}>
                  {t("settings.diagReveal")}
                </Btn>
                <Btn icon={ClipboardCopy} onClick={copyLogsPath} title={t("settings.diagCopyTitle")}>
                  {diagCopied ? t("settings.diagCopied") : t("settings.diagCopy")}
                </Btn>
              </div>
            </Row>
          )}
          {diagStatus && <div className="muted-sm" style={{ marginTop: -6 }}>{diagStatus}</div>}
        </Section>

        {/* ---- Внешний вид ---- */}
        <Section title={t("settings.appearance")} icon={Palette} badge="live">
          <Row label={t("settings.theme")} hint={t("settings.themeHint")}>
            <Select value={ap.theme} onChange={(e) => change("appearance.theme", e.target.value)} options={["dark", "light"]} />
          </Row>
          <Row label={t("settings.accent")} hint={t("settings.accentHint")}>
            <Select value={ap.accent} onChange={(e) => change("appearance.accent", e.target.value)} options={["amber", "violet", "teal", "coral"]} />
          </Row>
          <BoolRow label={t("settings.reduceMotion")} hint={t("settings.reduceMotionHint")} value={ap.reduceMotion} onChange={(v) => change("appearance.reduceMotion", v)} />
          <Row label={t("settings.fontSize")} hint={t("settings.fontSizeHint")}>
            <NumberInput value={ap.fontSize} onChange={(v) => change("appearance.fontSize", v)} min={11} max={20} suffix="px" />
          </Row>
          <Row label={t("settings.density")} hint={t("settings.densityHint")}>
            <Select value={ap.density} onChange={(e) => change("appearance.density", e.target.value)} options={["comfortable", "compact"]} />
          </Row>
        </Section>

        {/* ---- Производительность ---- */}
        <Section title={t("settings.performance")} icon={Gauge} badge="recommended on">
          <BoolRow
            label={t("settings.hwAccel")}
            hint={t("settings.hwAccelHint")}
            value={pf.hardwareAcceleration}
            onChange={(v) => change("performance.hardwareAcceleration", v)}
          />
          <BoolRow
            label={t("settings.bgBlur")}
            hint={t("settings.bgBlurHint")}
            value={pf.backgroundBlur}
            onChange={(v) => change("performance.backgroundBlur", v)}
          />
          {/* Keep-alive: страницы не пересоздаются при переключении вкладок
              (прогресс задач и позиция скролла сохраняются). Память ограничивают
              лимит по количеству и выгрузка простаивающих. */}
          <BoolRow
            label={t("settings.keepAlive")}
            hint={t("settings.keepAliveHint")}
            value={pf.keepPagesAlive !== false}
            onChange={(v) => change("performance.keepPagesAlive", v)}
          />
          <Row label={t("settings.keepAliveLimit")} hint={t("settings.keepAliveLimitHint")}>
            <Select
              value={String(pf.keepPagesLimit ?? 6)}
              onChange={(e) => change("performance.keepPagesLimit", Number(e.target.value))}
              options={["3", "6", "9", "12"]}
            />
          </Row>
          <Row label={t("settings.unloadIdle")} hint={t("settings.unloadIdleHint")}>
            <NumberInput
              value={Number(pf.unloadIdleMinutes ?? 5)}
              onChange={(v) => change("performance.unloadIdleMinutes", v)}
              min={0} max={120} suffix=" min"
            />
          </Row>
        </Section>

        {/* ---- Окно ---- */}
        <Section title={t("settings.window")} icon={MonitorCog} badge="active">
          <Row label={t("settings.width")} hint={t("settings.widthHint")}>
            <NumberInput value={win.width} onChange={(v) => change("window.width", v)} min={640} max={4000} />
          </Row>
          <Row label={t("settings.height")} hint={t("settings.heightHint")}>
            <NumberInput value={win.height} onChange={(v) => change("window.height", v)} min={520} max={3000} />
          </Row>
          <BoolRow label={t("settings.rememberSize")} hint={t("settings.rememberSizeHint")} value={win.rememberSize} onChange={(v) => change("window.rememberSize", v)} />
        </Section>

        <Section title={t("settings.storeSection")} icon={Package} badge="active">
          <Row label={t("storeSection.storeDir")} hint={t("storeSection.storeDirHint")}>
            <TextInput value={store.downloadDir} onChange={(v) => change("store.downloadDir", v)} placeholder="C:\\Users\\You\\Downloads" />
          </Row>
          <BoolRow label={t("storeSection.storeAutoIndex")} hint={t("storeSection.storeAutoIndexHint")} value={store.wingetAutoIndex} onChange={(v) => change("store.wingetAutoIndex", v)} />
          <Row label={t("storeSection.storePageSize")} hint={t("storeSection.storePageSizeHint")}>
            <Select value={String(store.pageSize)} onChange={(e) => change("store.pageSize", Number(e.target.value))} options={["20", "40", "80"]} />
          </Row>
        </Section>

        {/* ---- РљРѕРЅРІРµСЂС‚РµСЂ (РґРѕРє: convert) ---- */}
        <Section title={t("settings.converter")} icon={Repeat} badge="active">
          <Row label={t("convSection.convFfmpeg")} hint={t("convSection.convFfmpegHint")}>
            <TextInput value={conv.ffmpegPath} onChange={(v) => change("converter.ffmpegPath", v)} placeholder="ffmpeg" />
          </Row>
          <BoolRow label={t("convSection.convAudio")} hint={t("convSection.convAudioHint")} value={conv.preserveAudio} onChange={(v) => change("converter.preserveAudio", v)} />
        </Section>

        {/* ---- Сжатие видео (док: compressor) — дефолты матрицы энкодеров ---- */}
        <Section title={t("settings.compressor")} icon={Gauge} badge="active">
          <Row label={t("cmpSettings.cmpEngine")} hint={t("cmpSettings.cmpEngineHint")}>
            <Select value={String(comp.engine ?? "auto")} onChange={(e) => change("compressor.engine", e.target.value)} options={["auto", "svtav1", "x265", "x264", "aom", "rav1e", "av1an", "nvenc", "qsv", "amf", "nvencc", "qsvencc", "vceencc"]} />
          </Row>
          <Row label={t("cmpSettings.cmpCodec")} hint={t("cmpSettings.cmpCodecHint")}>
            <Select value={String(comp.codec ?? "av1")} onChange={(e) => change("compressor.codec", e.target.value)} options={["av1", "hevc", "h264"]} />
          </Row>
          <Row label={t("cmpSettings.cmpMode")} hint={t("cmpSettings.cmpModeHint")}>
            <Select value={String(comp.qualityMode ?? "crf")} onChange={(e) => change("compressor.qualityMode", e.target.value)} options={["crf", "bitrate", "constrained"]} />
          </Row>
          <Row label={t("cmpSettings.cmpCrf", { v: comp.crf ?? 23 })} hint={t("cmpSettings.cmpCrfHint")}>
            <input type="range" min="0" max="51" step="1" value={Number(comp.crf ?? 23)} onChange={(e) => change("compressor.crf", parseInt(e.target.value))} style={{ width: 180 }} />
          </Row>
          <BoolRow label={t("cmpSettings.cmpTenBit")} hint={t("cmpSettings.cmpTenBitHint")} value={comp.tenBit === true} onChange={(v) => change("compressor.tenBit", v)} />
          <BoolRow label={t("cmpSettings.cmpCleanup")} hint={t("cmpSettings.cmpCleanupHint")} value={comp.cleanupTemp !== false} onChange={(v) => change("compressor.cleanupTemp", v)} />
        </Section>

        {/* ---- Р’РёРґРµРѕ (РґРѕРє: video) вЂ” РґРµС„РѕР»С‚С‹ РґР»СЏ РЅРѕРІС‹С… Р·Р°РіСЂСѓР·РѕРє yt-dlp ---- */}
        <Section title={t("settings.video")} icon={Video} badge="active">
          <Row label={t("videoSection.videoQuality")} hint={t("videoSection.videoQualityHint")}>
            <Select
              value={String(video.defaultHeight ?? "best")}
              onChange={(e) => change("video.defaultHeight", e.target.value)}
              options={[
                { value: "best", label: t("videoSection.qualityBest") },
                { value: "2160", label: "2160p" }, { value: "1440", label: "1440p" },
                { value: "1080", label: "1080p" }, { value: "720", label: "720p" },
                { value: "480", label: "480p" },
              ]}
            />
          </Row>
          <BoolRow label={t("videoSection.videoEmbedThumb")} hint={t("videoSection.videoEmbedThumbHint")} value={video.embedThumbnail !== false} onChange={(v) => change("video.embedThumbnail", v)} />
          <BoolRow label={t("videoSection.videoSubs")} hint={t("videoSection.videoSubsHint")} value={!!video.downloadSubs} onChange={(v) => change("video.downloadSubs", v)} />
          <Row label={t("media.mediaYtdlp")} hint={t("media.mediaYtdlpHint")}>
            <TextInput value={media.ytdlpPath} onChange={(v) => change("media.ytdlpPath", v)} placeholder="yt-dlp" />
          </Row>
        </Section>

        {/* ---- РњСѓР·С‹РєР° (РґРѕРє: music) вЂ” РєР°С‡РµСЃС‚РІРѕ Р°СѓРґРёРѕ РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ ---- */}
        <Section title={t("settings.musicSection")} icon={Music2} badge="active">
          <Row label={t("musicSection.musicQuality")} hint={t("musicSection.musicQualityHint")}>
            <Select
              value={String(musicS.defaultQuality ?? "320 kbps")}
              onChange={(e) => change("music.defaultQuality", e.target.value)}
              options={["320 kbps", "256 kbps", "192 kbps", "128 kbps", "FLAC", "OPUS", "WAV", "AAC"]}
            />
          </Row>
        </Section>

        {/* ---- Книги (док: books) ---- */}
        <Section title={t("settings.books")} icon={BookOpen} badge="active">
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            {t("booksSection.noSettings")}
          </div>
        </Section>

        {/* ---- РњРѕРЅРёС‚РѕСЂРёРЅРі (РґРѕРє: monitor) ---- */}
        <Section title={t("settings.monitor")} icon={Activity} badge="active">
          <BoolRow label={t("monSettings.monAutoStart")} hint={t("monSettings.monAutoStartHint")} value={mon.autoStart} onChange={(v) => change("monitor.autoStart", v)} />
          <Row label={t("monSettings.monRefreshMs")} hint={t("monSettings.monIntervalHint")}>
            <Select value={String(mon.refreshMs ?? 500)} onChange={(e) => change("monitor.refreshMs", Number(e.target.value))} options={[100, 200, 300, 500, 750, 1000].map((ms) => ({ value: String(ms), label: String(ms) }))} />
          </Row>
          <BoolRow label={t("monSettings.monLhmAuto")} hint={t("monSettings.monLhmAutoHint")} value={mon.lhmAutoStart !== false} onChange={(v) => change("monitor.lhmAutoStart", v)} />
        </Section>

        {/* ---- My Space (РґРѕРє: myspace) ---- */}
        <Section title={t("settings.myspace")} icon={User} badge="active">
          <BoolRow label={t("myspaceSection.myAutosave")} hint={t("myspaceSection.myAutosaveHint")} value={mysp.autosave !== false} onChange={(v) => change("myspace.autosave", v)} />
          <BoolRow label={t("myspaceSection.mySpellcheck")} hint={t("myspaceSection.mySpellcheckHint")} value={!!mysp.spellcheck} onChange={(v) => change("myspace.spellcheck", v)} />
        </Section>

        {/* ---- Р§Р°С‚ / РР (РґРѕРє: aichat) вЂ” СЃРѕ СЃРІРѕСЂР°С‡РёРІР°РµРјС‹Рј РїРѕРґРјРµРЅСЋ API-РєР»СЋС‡РµР№ ---- */}
        <Section title={t("settings.chat")} icon={MessageSquare} badge="active">
          <ApiKeysPanel />
          <Row label={t("chat.chatProvider")} hint={t("chat.chatProviderHint")}>
            <Select value={chat.provider} onChange={(e) => change("chat.provider", e.target.value)} options={["openai", "anthropic", "gemini", "mistral", "deepseek", "ollama"]} />
          </Row>
          <Row label={t("chat.chatModel")} hint={t("chat.chatModelHint", { model: chat.model || "вЂ”" })}>
            <TextInput value={chat.model} onChange={(v) => change("chat.model", v)} placeholder="gpt-4o-mini" />
          </Row>
          <Row label={t("chat.chatTemperature")} hint={t("chat.chatTemperatureHint")}>
            <input
              type="range" min="0" max="1.5" step="0.1"
              value={chat.temperature}
              onChange={(e) => change("chat.temperature", parseFloat(e.target.value))}
              style={{ width: 180 }}
            />
            <span className="mono-val">{chat.temperature.toFixed(1)}</span>
          </Row>
          <Row label={t("chat.chatMaxTokens")} hint={t("chat.chatMaxTokensHint")}>
            <NumberInput value={chat.maxTokens} onChange={(v) => change("chat.maxTokens", v)} min={64} max={8192} step={64} />
          </Row>
          <BoolRow label={t("chat.chatStream")} hint={t("chat.chatStreamHint")} value={chat.stream} onChange={(v) => change("chat.stream", v)} />
          <Row label={t("chat.chatContext")} hint={t("chat.chatContextHint")}>
            <NumberInput value={chat.contextMessages} onChange={(v) => change("chat.contextMessages", v)} min={4} max={100} suffix=" msg" />
          </Row>
        </Section>

        {/* ---- Р“РѕР»РѕСЃ (РґРѕРє: voice) ---- */}
        <Section title={t("settings.voice")} icon={Mic2} badge="active">
          <Row label={t("voiceSettings.voiceEngine")} hint={t("voiceSettings.voiceEngineHint")}>
            <Select value={voice.engine} onChange={(e) => change("voice.engine", e.target.value)} options={["local", "cloud"]} />
          </Row>
          <Row label={t("voiceSettings.voiceModel")} hint={t("voiceSettings.voiceModelHint")}>
            <TextInput value={voice.model} onChange={(v) => change("voice.model", v)} placeholder={t("voiceSettings.voiceModelPlaceholder")} />
          </Row>
          <Row label={t("voiceSettings.voiceLang")} hint={t("voiceSettings.voiceLangHint")}>
            <Select value={voice.defaultLanguage} onChange={(e) => change("voice.defaultLanguage", e.target.value)} options={["English", "Russian", "Chinese", "Spanish", "French", "German", "Japanese"]} />
          </Row>
          {/* --- F5-TTS гиперпараметры (дефолты студии) --- */}
          <Row label={t("voiceSettings.voiceExag", { v: Number(voice.exaggeration ?? 1).toFixed(2) })} hint={t("voiceSettings.voiceExagHint")}>
            <input type="range" min="0.5" max="2" step="0.05" value={Number(voice.exaggeration ?? 1)} onChange={(e) => change("voice.exaggeration", parseFloat(e.target.value))} style={{ width: 180 }} />
          </Row>
          <Row label={t("voiceSettings.voiceCfg", { v: Number(voice.cfgWeight ?? 2).toFixed(2) })} hint={t("voiceSettings.voiceCfgHint")}>
            <input type="range" min="1.5" max="4.5" step="0.05" value={Number(voice.cfgWeight ?? 2)} onChange={(e) => change("voice.cfgWeight", parseFloat(e.target.value))} style={{ width: 180 }} />
          </Row>
          <Row label={t("voiceSettings.voiceChunk")} hint={t("voiceSettings.voiceChunkHint")}>
            <NumberInput value={Number(voice.chunkSize ?? 250)} onChange={(v) => change("voice.chunkSize", v)} min={100} max={400} step={10} suffix=" ch" />
          </Row>
          <Row label={t("voiceSettings.voicePrecision")} hint={t("voiceSettings.voicePrecisionHint")}>
            <Select value={String(voice.precision ?? "fp16")} onChange={(e) => change("voice.precision", e.target.value)} options={["fp16", "fp32"]} />
          </Row>
          <Row label={t("voiceSettings.voiceVram")} hint={t("voiceSettings.voiceVramHint")}>
            <NumberInput value={Number(voice.vramGb ?? 4.5)} onChange={(v) => change("voice.vramGb", v)} min={2} max={48} step={0.5} suffix=" GB" />
          </Row>
          <Row label={t("voiceSettings.voiceLoudness")} hint={t("voiceSettings.voiceLoudnessHint")}>
            <NumberInput value={Number(voice.loudnessTarget ?? -16)} onChange={(v) => change("voice.loudnessTarget", v)} min={-30} max={-8} step={1} suffix=" LUFS" />
          </Row>
        </Section>

        {/* ---- РђСЂС…РёРІР°С‚РѕСЂ ---- */}
        <Section title={t("settings.archiver")} icon={Archive} badge="active">
          <BoolRow label={t("archSettings.archInline")} hint={t("archSettings.archInlineHint")} value={arch.defaultOptions.css} onChange={(v) => change("archiver.defaultOptions.css", v)} />
          <BoolRow label={t("archSettings.archImages")} hint={t("archSettings.archImagesHint")} value={arch.defaultOptions.images} onChange={(v) => change("archiver.defaultOptions.images", v)} />
          <BoolRow label={t("archSettings.archFonts")} hint={t("archSettings.archFontsHint")} value={arch.defaultOptions.fonts} onChange={(v) => change("archiver.defaultOptions.fonts", v)} />
          <BoolRow label={t("archSettings.archScripts")} hint={t("archSettings.archScriptsHint")} value={arch.defaultOptions.removeScripts} onChange={(v) => change("archiver.defaultOptions.removeScripts", v)} />
        </Section>

        {/* ---- Web Archive / .sitebak (док: sitebak) — параметры краулера ---- */}
        <Section title={t("settings.sitebak")} icon={Archive} badge="active">
          <Row label={t("sbSettings.sbConcurrent")} hint={t("sbSettings.sbConcurrentHint")}>
            <NumberInput value={Number(sb.maxConcurrent ?? 3)} onChange={(v) => change("sitebak.maxConcurrent", v)} min={1} max={8} />
          </Row>
          <Row label={t("sbSettings.sbDelay", { v: sb.crawlDelayMs ?? 500 })} hint={t("sbSettings.sbDelayHint")}>
            <input type="range" min="0" max="3000" step="100" value={Number(sb.crawlDelayMs ?? 500)} onChange={(e) => change("sitebak.crawlDelayMs", parseInt(e.target.value))} style={{ width: 180 }} />
          </Row>
          <Row label={t("sbSettings.sbUa")} hint={t("sbSettings.sbUaHint")}>
            <TextInput value={sb.userAgent} onChange={(v) => change("sitebak.userAgent", v)} placeholder="Mozilla/5.0 …" />
          </Row>
          <Row label={t("sbSettings.sbDict")} hint={t("sbSettings.sbDictHint")}>
            <NumberInput value={Number(sb.zstdDictKb ?? 1024)} onChange={(v) => change("sitebak.zstdDictKb", v)} min={0} max={8192} step={256} suffix=" KB" />
          </Row>
          <Row label={t("sbSettings.sbMedia")} hint={t("sbSettings.sbMediaHint")}>
            <Select value={String(sb.mediaFormat ?? "webp")} onChange={(e) => change("sitebak.mediaFormat", e.target.value)} options={["original", "lossless", "webp", "avif"]} />
          </Row>
          <Row label={t("sbSettings.sbMaxPages")} hint={t("sbSettings.sbMaxPagesHint")}>
            <NumberInput value={Number(sb.maxPages ?? 500)} onChange={(v) => change("sitebak.maxPages", v)} min={10} max={5000} step={10} />
          </Row>
        </Section>

        {/* ---- РђРІС‚РѕР±СЌРєР°Рї ---- */}
        <Section title={t("settings.backup")} icon={Database} badge="active">
          <BoolRow label={t("backupSettings.backupEnable")} hint={t("backupSettings.backupEnableHint")} value={backup.auto} onChange={(v) => change("backup.auto", v)} />
          <Row label={t("backupSettings.backupInterval")} hint={t("backupSettings.backupIntervalHint")}>
            <NumberInput value={backup.intervalHours} onChange={(v) => change("backup.intervalHours", v)} min={1} max={720} suffix=" h" />
          </Row>
        </Section>

        {/* ---- РџСЂРѕРґРІРёРЅСѓС‚РѕРµ ---- */}
        <Section title={t("settings.advanced")} icon={ShieldCheck} badge="dev">
          <BoolRow label={t("advanced.advancedTelemetry")} hint={t("advanced.advancedTelemetryHint")} value={adv.telemetry} onChange={(v) => change("advanced.telemetry", v)} />
          <Row label={t("advanced.advancedLogLevel")} hint={t("advanced.advancedLogLevelHint")}>
            <Select value={adv.logLevel} onChange={(e) => change("advanced.logLevel", e.target.value)} options={["debug", "info", "warn", "error"]} />
          </Row>
          <Row label={t("advanced.advancedMasterKey")} hint={t("advanced.advancedMasterKeyHint")}>
            <TextInput value={adv.masterKey} onChange={(v) => change("advanced.masterKey", v)} placeholder={t("advanced.advancedMasterKeyPlaceholder")} />
          </Row>
        </Section>

        {saved && (
          <Glass className="source-placeholder" style={{ borderColor: "var(--teal)", color: "var(--text-secondary)" }}>
            <Check size={15} style={{ color: "var(--success)" }} />
            <span>{t("settings.savedMsg")}</span>
          </Glass>
        )}
      </Glass>
    </div>
  );
}
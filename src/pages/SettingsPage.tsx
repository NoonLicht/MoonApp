import React, { useState, useEffect } from "react";
import {
  Settings2, Palette, Gauge, MonitorCog, MessageSquare, ListChecks,
  Package, Repeat, Clapperboard, Mic2, Archive, Activity, Database,
  ShieldCheck, Check, RotateCcw,
} from "lucide-react";
import { Glass, Btn, Select, SectionHead, Badge, EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n, LANGS } from "../i18n";
import { api } from "../api/client";

/* Сервисный словарь бейджей разделов: слово -> ключ перевода */
const BADGE_KEYS: Record<string, string> = {
  "saved auto": "savedAuto",
  "recommended on": "recommended",
  live: "live",
  future: "future",
  active: "active",
  dev: "dev",
};

/* ---------- Утилиты для точечного чтения/записи вложенных путей ---------- */
function getAt(obj: any, path: string): any {
  return path.split(".").reduce((a, k) => (a == null ? a : a[k]), obj);
}
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

/* ---------- Мелкие UI-элементы ---------- */
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

/* ---------- Блок секции ---------- */
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
            {isFuture ? `⚠ ${badgeText}` : badgeText}
          </Badge>
        )}
      </div>
      <div className="set-section-body">{children}</div>
    </Glass>
  );
}

export default function SettingsPage() {
  const { t } = useI18n();
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [dirtyMap, setDirtyMap] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getSettings().then(setS).catch(() => setError(t("settings.loadError") || "Не удалось загрузить настройки"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePageToolbar(
    <Badge tone="teal" mono>
      {dirtyMap.size ? t("settings.unsaved", { n: dirtyMap.size }) : t("settings.saved")}
    </Badge>,
    [dirtyMap.size, t]
  );

  async function persist(next: any, path: string) {
    setS(next);
    // Сохраняется только изменённая ветка (вложенный patch), deep-merge на сервере.
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
    // Спец-обработка темы: синхронизируем основной App.
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
  const chat = s.chat, tasks = s.tasks, store = s.store, conv = s.converter;
  const media = s.media, voice = s.voice, arch = s.archiver, mon = s.monitor;
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
        {/* ---- Общие ---- */}
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
              options={["store", "convert", "video", "music", "books", "monitor", "todo", "aichat", "voice", "archive", "settings"]}
            />
          </Row>
          <BoolRow label={t("settings.autoLaunch")} hint={t("settings.autoLaunchHint")} value={g.autoLaunch} onChange={(v) => change("general.autoLaunch", v)} />
          <BoolRow label={t("settings.minimizeToTray")} hint={t("settings.minimizeToTrayHint")} value={g.minimizeToTray} onChange={(v) => change("general.minimizeToTray", v)} />
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
        </Section>

        {/* ---- Окно ---- */}
        <Section title={t("settings.window")} icon={MonitorCog} badge="future">
          <Row label={t("settings.width")} hint={t("settings.widthHint")}>
            <NumberInput value={win.width} onChange={(v) => change("window.width", v)} min={800} max={4000} />
          </Row>
          <Row label={t("settings.height")} hint={t("settings.heightHint")}>
            <NumberInput value={win.height} onChange={(v) => change("window.height", v)} min={600} max={3000} />
          </Row>
          <BoolRow label={t("settings.rememberSize")} hint={t("settings.rememberSizeHint")} value={win.rememberSize} onChange={(v) => change("window.rememberSize", v)} />
        </Section>

        {/* ---- Чат / ИИ ---- */}
        <Section title={t("settings.chat")} icon={MessageSquare} badge="active">
          <Row label={t("chat.chatProvider")} hint={t("chat.chatProviderHint")}>
            <Select value={chat.provider} onChange={(e) => change("chat.provider", e.target.value)} options={["openai", "anthropic", "gemini", "mistral", "deepseek", "ollama"]} />
          </Row>
          <Row label={t("chat.chatModel")} hint={t("chat.chatModelHint", { model: chat.model || "—" })}>
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

        {/* ---- Задачи ---- */}
        <Section title={t("settings.tasks")} icon={ListChecks} badge="active">
          <BoolRow label={t("tasks.tasksSmart")} hint={t("tasks.tasksSmartHint")} value={tasks.smartParsing} onChange={(v) => change("tasks.smartParsing", v)} />
          <Row label={t("tasks.tasksPriority")} hint={t("tasks.tasksPriorityHint")}>
            <Select value={tasks.defaultPriority} onChange={(e) => change("tasks.defaultPriority", e.target.value)} options={["High", "Med", "Low"]} />
          </Row>
          <Row label={t("tasks.tasksTag")} hint={t("tasks.tasksTagHint")}>
            <TextInput value={tasks.defaultTag} onChange={(v) => change("tasks.defaultTag", v)} placeholder="General" />
          </Row>
        </Section>

        {/* ---- Store / загрузки ---- */}
        <Section title={t("settings.storeSection")} icon={Package} badge="active">
          <Row label={t("storeSection.storeDir")} hint={t("storeSection.storeDirHint")}>
            <TextInput value={store.downloadDir} onChange={(v) => change("store.downloadDir", v)} placeholder="C:\\Users\\You\\Downloads" />
          </Row>
          <BoolRow label={t("storeSection.storeAutoIndex")} hint={t("storeSection.storeAutoIndexHint")} value={store.wingetAutoIndex} onChange={(v) => change("store.wingetAutoIndex", v)} />
          <Row label={t("storeSection.storePageSize")} hint={t("storeSection.storePageSizeHint")}>
            <Select value={String(store.pageSize)} onChange={(e) => change("store.pageSize", Number(e.target.value))} options={["20", "40", "80"]} />
          </Row>
        </Section>

        {/* ---- Конвертер ---- */}
        <Section title={t("settings.converter")} icon={Repeat} badge="future">
          <Row label={t("convSection.convFfmpeg")} hint={t("convSection.convFfmpegHint")}>
            <TextInput value={conv.ffmpegPath} onChange={(v) => change("converter.ffmpegPath", v)} placeholder="ffmpeg" />
          </Row>
          <BoolRow label={t("convSection.convAudio")} hint={t("convSection.convAudioHint")} value={conv.preserveAudio} onChange={(v) => change("converter.preserveAudio", v)} />
        </Section>

        {/* ---- Видео / Музыка ---- */}
        <Section title={t("settings.media")} icon={Clapperboard} badge="future">
          <Row label={t("media.mediaYtdlp")} hint={t("media.mediaYtdlpHint")}>
            <TextInput value={media.ytdlpPath} onChange={(v) => change("media.ytdlpPath", v)} placeholder="yt-dlp" />
          </Row>
        </Section>

        {/* ---- Голос ---- */}
        <Section title={t("settings.voice")} icon={Mic2} badge="future">
          <Row label={t("voiceSettings.voiceEngine")} hint={t("voiceSettings.voiceEngineHint")}>
            <Select value={voice.engine} onChange={(e) => change("voice.engine", e.target.value)} options={["local", "cloud"]} />
          </Row>
          <Row label={t("voiceSettings.voiceModel")} hint={t("voiceSettings.voiceModelHint")}>
            <TextInput value={voice.model} onChange={(v) => change("voice.model", v)} placeholder={t("advanced.advancedMasterKeyPlaceholder")} />
          </Row>
          <Row label={t("voiceSettings.voiceLang")} hint={t("voiceSettings.voiceLangHint")}>
            <Select value={voice.defaultLanguage} onChange={(e) => change("voice.defaultLanguage", e.target.value)} options={["English", "Spanish", "French", "German", "Japanese"]} />
          </Row>
        </Section>

        {/* ---- Архиватор ---- */}
        <Section title={t("settings.archiver")} icon={Archive} badge="future">
          <BoolRow label={t("archSettings.archInline")} hint={t("archSettings.archInlineHint")} value={arch.defaultOptions.css} onChange={(v) => change("archiver.defaultOptions.css", v)} />
          <BoolRow label={t("archSettings.archImages")} hint={t("archSettings.archImagesHint")} value={arch.defaultOptions.images} onChange={(v) => change("archiver.defaultOptions.images", v)} />
          <BoolRow label={t("archSettings.archFonts")} hint={t("archSettings.archFontsHint")} value={arch.defaultOptions.fonts} onChange={(v) => change("archiver.defaultOptions.fonts", v)} />
          <BoolRow label={t("archSettings.archScripts")} hint={t("archSettings.archScriptsHint")} value={arch.defaultOptions.removeScripts} onChange={(v) => change("archiver.defaultOptions.removeScripts", v)} />
        </Section>

        {/* ---- Мониторинг ---- */}
        <Section title={t("settings.monitor")} icon={Activity} badge="active">
          <BoolRow label={t("monSettings.monAutoStart")} hint={t("monSettings.monAutoStartHint")} value={mon.autoStart} onChange={(v) => change("monitor.autoStart", v)} />
          <Row label={t("monSettings.monRefreshMs")} hint={t("monSettings.monIntervalHint")}>
            <Select value={String(mon.refreshMs ?? 500)} onChange={(e) => change("monitor.refreshMs", Number(e.target.value))} options={[100, 200, 300, 500, 750, 1000].map((ms) => ({ value: String(ms), label: String(ms) }))} />
          </Row>
          <BoolRow label={t("monSettings.monLhmAuto")} hint={t("monSettings.monLhmAutoHint")} value={mon.lhmAutoStart !== false} onChange={(v) => change("monitor.lhmAutoStart", v)} />
        </Section>

        {/* ---- Автобэкап ---- */}
        <Section title={t("settings.backup")} icon={Database} badge="active">
          <BoolRow label={t("backupSettings.backupEnable")} hint={t("backupSettings.backupEnableHint")} value={backup.auto} onChange={(v) => change("backup.auto", v)} />
          <Row label={t("backupSettings.backupInterval")} hint={t("backupSettings.backupIntervalHint")}>
            <NumberInput value={backup.intervalHours} onChange={(v) => change("backup.intervalHours", v)} min={1} max={720} suffix=" h" />
          </Row>
        </Section>

        {/* ---- Продвинутое ---- */}
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
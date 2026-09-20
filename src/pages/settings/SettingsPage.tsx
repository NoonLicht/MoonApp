import React, { useState, useEffect, useRef } from "react";
import {
  Settings2,
  Palette,
  Gauge,
  MessageSquare,
  Package,
  Clapperboard,
  Mic2,
  Archive,
  Activity,
  Database,
  ShieldCheck,
  Check,
  RotateCcw,
  Video,
  Music2,
  User,
  ChevronDown,
  KeyRound,
  Save,
  RefreshCw,
  Download,
  FileDown,
  FolderOpen,
  ClipboardCopy,
  Upload,
  AudioLines,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import { Glass, Btn, Select, SectionHead, Badge, EmptyHint } from "@/components/ui";
import { copyToClipboard } from "@/components/ContextMenu";
import { snapshotUiSettings } from "@/lib/telemetry";
// Локальные настройки страниц (localStorage) — их нет в settings.json, поэтому
// экспорт/импорт настроек переносит их отдельным блоком (см. ниже).
import { collectUiSettings, applyUiSettings } from "@/lib/uiSettings";
import { useI18n, LANGS } from "@/app/i18n";
import { startPageOptions } from "@/app/navigation";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";

/**
 * Точечное чтение вложенного значения по пути "a.b.c".
 * Используется, чтобы патчить настройки (PATCH /settings) узкой веткой.
 */
function getAt(obj: any, path: string): any {
  return path.split(".").reduce((a, k) => (a == null ? a : a[k]), obj);
}

/**
 * Иммутабельно пишет значение по пути "a.b.c" и возвращает копию объекта.
 * Так компонент остаётся чистым: старое состояние не мутируется.
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

/* ---------- Мелкие UI-элементы ---------- */

/**
 * Применить импортированные настройки, которые приложение меняет НА ЛЕТУ.
 * Список путей — ровно тот, что слушает App.tsx (событие app:setting) плюс тема
 * отдельным событием app:theme; всё остальное (автозапуск, размер окна,
 * аппаратное ускорение) читается только при старте — UI честно об этом пишет.
 */
function applyLiveSettings(settings: unknown) {
  const s = settings as any;
  if (!s || typeof s !== "object") return;
  window.dispatchEvent(
    new CustomEvent("app:theme", { detail: String(s.appearance?.theme || "dark") }),
  );
  const paths = [
    "general.language",
    "performance.backgroundBlur",
    "performance.keepPagesAlive",
    "performance.keepPagesLimit",
    "performance.unloadIdleMinutes",
    "appearance.accent",
    "appearance.reduceMotion",
    "appearance.density",
    "appearance.opaqueBackground",
  ];
  for (const path of paths) {
    const value = path.split(".").reduce<any>((a, k) => (a == null ? a : a[k]), s);
    if (value === undefined) continue;
    window.dispatchEvent(new CustomEvent("app:setting", { detail: { path, value } }));
  }
}

function Row({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
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

function BoolRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
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

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  value: number | string;
  onChange: (v: number | "") => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
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

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
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
function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <Glass className="set-section">
      <div className="set-section-head">
        <span className="set-section-icon tone-violet">
          <Icon size={16} strokeWidth={2} />
        </span>
        <span className="set-section-title">{title}</span>
      </div>
      <div className="set-section-body">{children}</div>
    </Glass>
  );
}

/**
 * Сворачиваемое подменю «API-ключи» внутри раздела AI Chat.
 *
 * Как это работает:
 *  - список провайдеров берётся с GET /settings/providers (в ответе только
 *    флаг «настроен», сами ключи никогда не отдаются клиенту);
 *  - введённый ключ уходит один раз POST-ом на /settings/providers/:id/key;
 *  - на сервере ключ шифруется (safeStorage/DPAPI внутри Electron, иначе
 *    AES-256-GCM с мастер-ключом) и хранится в storage/secrets.json.
 */
function ApiKeysPanel() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<
    { id: string; label: string; configured: boolean; stub: boolean }[]
  >([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);

  const refresh = () => {
    api
      .getProviders()
      .then((list: any) => setProviders(list || []))
      .catch(() => setProviders([]));
  };
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const save = async (id: string) => {
    const key = (drafts[id] || "").trim();
    if (!key) return;
    try {
      await api.saveKey(id, key);
      setDrafts((d) => ({ ...d, [id]: "" }));
      setSavedId(id);
      refresh();
      setTimeout(() => setSavedId(null), 1500);
    } catch {
      /* ошибка сети — бейдж «configured» просто не обновится */
    }
  };

  return (
    <div className="keys-panel">
      <button
        type="button"
        className="keys-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
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
                <Badge tone={p.configured ? "teal" : "neutral"} mono>
                  {p.configured ? t("chat.keyConfigured") : t("chat.keyMissing")}
                </Badge>
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

/**
 * Строка API-ключа TMDB в разделе «Фильмы и Сериалы».
 * Ключ уходит один раз POST-ом, на сервере шифруется (storage/secrets.json);
 * статус «задан/не задан» берётся с бэкенда (GET /api/movies/status).
 */
function TmdbKeyRow() {
  const { t } = useI18n();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .moviesStatus()
      .then((st) => setConfigured(!!st.hasKey))
      .catch(() => setConfigured(null));
  }, []);

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    setSaving(true);
    try {
      await api.moviesSaveKey(key);
      setDraft("");
      setConfigured(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Row label={t("moviesSettings.keyLabel")} hint={t("moviesSettings.keyHint")}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone={configured ? "teal" : "neutral"} mono>
          {configured ? t("moviesSettings.keyConfigured") : t("moviesSettings.keyMissing")}
        </Badge>
        <input
          type="password"
          className="text-input"
          value={draft}
          placeholder="••••••"
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: 200 }}
        />
        <Btn icon={Save} disabled={saving || !draft.trim()} onClick={() => void save()}>
          {t("moviesSettings.keySave")}
        </Btn>
      </div>
    </Row>
  );
}

export default function SettingsPage() {
  const { t } = useI18n();
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [dirtyMap, setDirtyMap] = useState<Set<string>>(new Set());
  /**
   * Логические потоки процессора. 0 в поле «Потоки CPU» означает «все потоки»,
   * поэтому рядом с полем показываем, сколько их всего. В Electron это же число
   * видит и сервер (`os.cpus().length` в resolveThreads).
   */
  const cpuThreads = Math.max(0, Math.round(Number(navigator.hardwareConcurrency)) || 0);

  useEffect(() => {
    api
      .getSettings()
      .then(setS)
      .catch(() => setError(t("settings.loadError") || "Не удалось загрузить настройки"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Обновления приложения (appBridge; работают только в packaged-сборке).
  // С 0.2.2 обновления ОБЯЗАТЕЛЬНЫ: проверка запускается при каждом старте, файл
  // скачивается сам, а установка предлагается диалогом, который нельзя закрыть не
  // обновившись (electron/main.js → showMandatoryUpdate). Поэтому здесь нет
  // выключателя — только ручная проверка и «скачать сейчас».
  const [updBusy, setUpdBusy] = useState<string | null>(null);
  const [updStatus, setUpdStatus] = useState("");

  async function checkUpdatesNow() {
    const br = window.appBridge;
    if (!br?.checkUpdates) {
      setUpdStatus(t("settings.updatesDevHint"));
      return;
    }
    setUpdBusy("check");
    setUpdStatus(t("settings.updatesChecking"));
    try {
      const r = await br.checkUpdates();
      if (!r.ok) setUpdStatus(t("settings.updatesError", { msg: r.reason || "" }));
      else if (!r.available) setUpdStatus(t("settings.updatesNone"));
      else setUpdStatus(t("settings.updatesFound", { v: r.version || "" }));
    } catch (e) {
      setUpdStatus((e as Error).message);
    } finally {
      setUpdBusy(null);
    }
  }

  async function downloadUpdateNow() {
    const br = window.appBridge;
    if (!br?.downloadUpdate) {
      setUpdStatus(t("settings.updatesDevHint"));
      return;
    }
    setUpdBusy("download");
    setUpdStatus(t("settings.updatesChecking"));
    try {
      const r = await br.downloadUpdate();
      if (!r.ok) setUpdStatus(t("settings.updatesError", { msg: r.reason || "" }));
      else if (!r.available) setUpdStatus(t("settings.updatesNone"));
      // downloading: false — файл уже скачан, показан обязательный диалог установки.
      else if (!r.downloading) setUpdStatus(t("settings.updatesReady", { v: r.version || "" }));
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
    setDiagBusy(true);
    setDiagCopied(false);
    setDiagStatus(t("settings.diagCollecting"));
    try {
      // Сначала отправляем снимок локальных настроек интерфейса (localStorage),
      // чтобы он попал в отчёт вместе с настройками страниц из settings.json.
      await snapshotUiSettings();
      const r = await api.collectLogs();
      setDiagFile(r.file);
      setDiagStatus(
        t("settings.diagReady", {
          events: r.events,
          kb: Math.max(1, Math.round(r.size / 1024)),
        }),
      );
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

  /* --- Экспорт и импорт всех настроек ---
   * Файл содержит настройки ВСЕХ страниц: секции settings.json (эффективные
   * значения) + локальные настройки интерфейса из localStorage + по галочке
   * ключи API. Данные (заметки, задачи, история чатов) не входят — для них есть
   * резервные копии в разделе «Автобэкап».
   */
  const [ioSecrets, setIoSecrets] = useState(false); // включать/принимать ключи API
  const [ioBusy, setIoBusy] = useState<"export" | "import" | null>(null);
  const [ioStatus, setIoStatus] = useState("");
  const [ioTone, setIoTone] = useState<"ok" | "warn" | "err">("ok");
  const ioFileRef = useRef<HTMLInputElement>(null);

  async function exportSettings() {
    setIoBusy("export");
    setIoStatus("");
    try {
      const { blob, name } = await api.settingsExport({
        includeSecrets: ioSecrets,
        // Сервер не видит localStorage — отдаём снимок настроек страниц.
        ui: collectUiSettings(),
      });
      saveBlob(blob, name);
      setIoTone("ok");
      setIoStatus(t("settingsIO.ioExported", { name }));
    } catch (e) {
      setIoTone("err");
      setIoStatus(t("settingsIO.ioExportError", { msg: (e as Error).message }));
    } finally {
      setIoBusy(null);
    }
  }

  async function importSettingsFile(file: File) {
    setIoBusy("import");
    setIoStatus("");
    try {
      let payload: unknown = null;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        /* ниже — понятная ошибка */
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error(t("settingsIO.ioBadFormat"));
      }
      // Импорт заменяет текущие настройки — спрашиваем подтверждение.
      if (!window.confirm(t("settingsIO.ioImportConfirm", { name: file.name }))) return;

      const r = await api.settingsImport(payload, { importSecrets: ioSecrets });
      // Локальные настройки страниц применяет клиент: localStorage — его зона.
      applyUiSettings(r.ui);
      setS(r.settings);
      // Что App умеет менять на лету — применяем сразу (тема, язык, внешний вид,
      // keep-alive). Остальное (автозапуск, окно, ускорение) — после перезапуска,
      // о чём ниже говорит ioRestartHint.
      applyLiveSettings(r.settings);

      const parts = [t("settingsIO.ioImportDone", { n: r.applied, keys: r.keysApplied })];
      if (r.skipped.length) {
        parts.push(
          t("settingsIO.ioImportSkipped", {
            n: r.skipped.length,
            list: r.skipped.slice(0, 5).join(", "),
          }),
        );
      }
      if (r.keysSkipped.length)
        parts.push(t("settingsIO.ioKeysSkipped", { n: r.keysSkipped.length }));
      if (r.applied || r.keysApplied) parts.push(t("settingsIO.ioRestartHint"));
      setIoTone(r.skipped.length || r.keysSkipped.length ? "warn" : "ok");
      setIoStatus(parts.join(" "));
    } catch (e) {
      setIoTone("err");
      setIoStatus(t("settingsIO.ioImportError", { msg: (e as Error).message }));
    } finally {
      setIoBusy(null);
      // Сбрасываем input: иначе повторный выбор того же файла не вызовет onChange.
      if (ioFileRef.current) ioFileRef.current.value = "";
    }
  }

  // Синхронизируем состояние кнопок обновлений больше не нужно: выключателя нет,
  // обновления обязательны (см. выше).

  // Бейдж «сохранено / не сохранено» из шапки убран: рядом с названием страницы
  // он только занимал место, а факт записи виден всплывающей плашкой снизу
  // (см. `saved` в конце рендера). Поэтому usePageToolbar здесь не вызывается.

  async function persist(next: any, path: string) {
    setS(next);
    // Сохраняется только изменённая ветка (вложенный patch), deep-merge на сервере.
    const keys = path.split(".");
    const patch: any = {};
    let cur: any = patch;
    for (let i = 0; i < keys.length - 1; i++) {
      cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = getAt(next, path);
    try {
      await api.updateSettings(patch);
      setSaved(true);
      window.dispatchEvent(
        new CustomEvent("app:setting", { detail: { path, value: getAt(next, path) } }),
      );
      setDirtyMap((d) => {
        const n = new Set(d);
        n.delete(path);
        return n;
      });
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

  const g = s.general,
    ap = s.appearance,
    pf = s.performance;
  const chat = s.chat,
    store = s.store;
  // Новые секции могут отсутствовать в старых settings.json — даём фолбэки.
  const video = s.video || {},
    musicS = s.music || {},
    mysp = s.myspace || {};
  const moviesCfg = s.movies || {};
  const voice = s.voice || {},
    mon = s.monitor;
  const comp = s.compressor || {},
    up = s.upscaler || {},
    sb = s.sitebak || {};
  // Настройки лектория: часть живёт в панелях страницы лекций (модель, конспект,
  // говорящие), здесь — язык Whisper, промпт, потоки и тайминги VAD.
  const lec = s.lecture || {};
  const backup = s.backup,
    adv = s.advanced;

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
        <Glass
          className="source-placeholder"
          style={{ borderColor: "var(--coral)", color: "var(--text-secondary)" }}
        >
          <span>{error}</span>
        </Glass>
      )}

      <Glass className="settings-scroll-wrap">
        {/* ---- Store / загрузки (док: store) ---- */}
        {/* ---- Общее (док: settings) ---- */}
        <Section title={t("settings.general")} icon={Settings2}>
          <Row label={t("settings.language")} hint={t("settings.languageHint")}>
            <Select
              value={g.language}
              onChange={(e) => change("general.language", e.target.value)}
              options={LANGS.map((l) => ({ value: l.code, label: l.native }))}
            />
          </Row>
          <Row label={t("settings.startPage")} hint={t("settings.startPageHint")}>
            {/* Список строится из единого перечня страниц (src/navigation.ts):
                новая страница автоматически появляется здесь, и настройки не
                отстают от дока (раньше не хватало movies, lecture, bypass). */}
            <Select
              value={g.startPage}
              onChange={(e) => change("general.startPage", e.target.value)}
              options={startPageOptions(t)}
            />
          </Row>
          <BoolRow
            label={t("settings.autoLaunch")}
            hint={t("settings.autoLaunchHint")}
            value={g.autoLaunch}
            onChange={(v) => {
              void change("general.autoLaunch", v);
              // Применяем сразу: реестр Windows (Run) правит main-процесс, поэтому
              // без этого вызова настройка вступала в силу только после перезапуска
              // приложения — см. electron/main.js → app:autolaunch.
              void window.appBridge?.applyAutoLaunch?.();
            }}
          />
          <BoolRow
            label={t("settings.minimizeToTray")}
            hint={t("settings.minimizeToTrayHint")}
            value={g.minimizeToTray}
            onChange={(v) => change("general.minimizeToTray", v)}
          />
          <BoolRow
            label={t("settings.closeToTray")}
            hint={t("settings.closeToTrayHint")}
            value={!!g.closeToTray}
            onChange={(v) => change("general.closeToTray", v)}
          />
        </Section>

        {/* ---- Обновления приложения (док: general.autoUpdate) ----
             Обновления обязательны: проверка при каждом старте и каждые 4 часа,
             скачивание автоматическое, установка — через диалог, который нельзя
             закрыть не обновившись. Выключателя нет по построению (0.2.2). ---- */}
        <Section title={t("settings.updatesTitle")} icon={RefreshCw}>
          <Row label={t("settings.updatesAutoLabel")} hint={t("settings.updatesAutoHint")}>
            <Badge tone="teal">{t("settings.updatesMandatory")}</Badge>
          </Row>
          <Row label={t("settings.updatesCheckLabel")} hint={t("settings.updatesCheckHint")}>
            <Btn
              icon={updBusy === "check" ? RefreshCw : Check}
              onClick={checkUpdatesNow}
              disabled={updBusy !== null}
            >
              {t("settings.updatesCheck")}
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
          {updStatus && (
            <div className="muted-sm" style={{ marginTop: -6 }}>
              {updStatus}
            </div>
          )}
        </Section>

        {/* ---- Логи и диагностика: один файл со всеми событиями ---- */}
        <Section title={t("settings.diagTitle")} icon={FileDown}>
          <Row label={t("settings.diagLabel")} hint={t("settings.diagHint")}>
            <Btn
              variant="primary"
              icon={diagBusy ? RefreshCw : FileDown}
              onClick={collectLogs}
              disabled={diagBusy}
            >
              {diagBusy ? t("settings.diagCollecting") : t("settings.diagCollect")}
            </Btn>
          </Row>
          {diagFile && (
            <Row label={t("settings.diagFile")} hint={diagFile}>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn icon={FolderOpen} onClick={revealLogs} title={t("settings.diagRevealTitle")}>
                  {t("settings.diagReveal")}
                </Btn>
                <Btn
                  icon={ClipboardCopy}
                  onClick={copyLogsPath}
                  title={t("settings.diagCopyTitle")}
                >
                  {diagCopied ? t("settings.diagCopied") : t("settings.diagCopy")}
                </Btn>
              </div>
            </Row>
          )}
          {diagStatus && (
            <div className="muted-sm" style={{ marginTop: -6 }}>
              {diagStatus}
            </div>
          )}
        </Section>

        {/* ---- Внешний вид ---- */}
        <Section title={t("settings.appearance")} icon={Palette}>
          <Row label={t("settings.theme")} hint={t("settings.themeHint")}>
            <Select
              value={ap.theme}
              onChange={(e) => change("appearance.theme", e.target.value)}
              options={[
                { value: "dark", label: t("settings.themeDark") },
                { value: "midnight", label: t("settings.themeMidnight") },
                { value: "oled", label: t("settings.themeOled") },
                { value: "light", label: t("settings.themeLight") },
                { value: "sand", label: t("settings.themeSand") },
              ]}
            />
          </Row>
          <Row label={t("settings.accent")} hint={t("settings.accentHint")}>
            <Select
              value={ap.accent}
              onChange={(e) => change("appearance.accent", e.target.value)}
              options={[
                { value: "amber", label: t("settings.accentAmber") },
                { value: "violet", label: t("settings.accentViolet") },
                { value: "teal", label: t("settings.accentTeal") },
                { value: "coral", label: t("settings.accentCoral") },
                { value: "sky", label: t("settings.accentSky") },
                { value: "rose", label: t("settings.accentRose") },
              ]}
            />
          </Row>
          <BoolRow
            label={t("settings.reduceMotion")}
            hint={t("settings.reduceMotionHint")}
            value={ap.reduceMotion}
            onChange={(v) => change("appearance.reduceMotion", v)}
          />
          <Row label={t("settings.density")} hint={t("settings.densityHint")}>
            <Select
              value={ap.density}
              onChange={(e) => change("appearance.density", e.target.value)}
              options={["comfortable", "compact"]}
            />
          </Row>
          <BoolRow
            label={t("settings.opaqueBg")}
            hint={t("settings.opaqueBgHint")}
            value={!!ap.opaqueBackground}
            onChange={(v) => change("appearance.opaqueBackground", v)}
          />
        </Section>

        {/* ---- Производительность ---- */}
        <Section title={t("settings.performance")} icon={Gauge}>
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
              min={0}
              max={120}
              suffix=" min"
            />
          </Row>
        </Section>

        <Section title={t("settings.storeSection")} icon={Package}>
          <Row label={t("storeSection.storeDir")} hint={t("storeSection.storeDirHint")}>
            <TextInput
              value={store.downloadDir}
              onChange={(v) => change("store.downloadDir", v)}
              placeholder="C:\\Users\\You\\Downloads"
            />
          </Row>
          <BoolRow
            label={t("storeSection.storeAutoIndex")}
            hint={t("storeSection.storeAutoIndexHint")}
            value={store.wingetAutoIndex}
            onChange={(v) => change("store.wingetAutoIndex", v)}
          />
          <Row label={t("storeSection.storePageSize")} hint={t("storeSection.storePageSizeHint")}>
            <Select
              value={String(store.pageSize)}
              onChange={(e) => change("store.pageSize", Number(e.target.value))}
              options={["20", "40", "80"]}
            />
          </Row>
        </Section>

        {/* ---- Сжатие видео (док: compressor) — дефолты матрицы энкодеров ---- */}
        <Section title={t("settings.compressor")} icon={Gauge}>
          <Row label={t("cmpSettings.cmpEngine")} hint={t("cmpSettings.cmpEngineHint")}>
            <Select
              value={String(comp.engine ?? "auto")}
              onChange={(e) => change("compressor.engine", e.target.value)}
              options={[
                "auto",
                "svtav1",
                "x265",
                "x264",
                "aom",
                "rav1e",
                "av1an",
                "nvenc",
                "qsv",
                "amf",
                "nvencc",
                "qsvencc",
                "vceencc",
              ]}
            />
          </Row>
          <Row label={t("cmpSettings.cmpCodec")} hint={t("cmpSettings.cmpCodecHint")}>
            <Select
              value={String(comp.codec ?? "av1")}
              onChange={(e) => change("compressor.codec", e.target.value)}
              options={["av1", "hevc", "h264"]}
            />
          </Row>
          <Row label={t("cmpSettings.cmpMode")} hint={t("cmpSettings.cmpModeHint")}>
            <Select
              value={String(comp.qualityMode ?? "crf")}
              onChange={(e) => change("compressor.qualityMode", e.target.value)}
              options={["crf", "bitrate", "constrained"]}
            />
          </Row>
          <Row
            label={t("cmpSettings.cmpCrf", { v: comp.crf ?? 23 })}
            hint={t("cmpSettings.cmpCrfHint")}
          >
            <input
              type="range"
              min="0"
              max="51"
              step="1"
              value={Number(comp.crf ?? 23)}
              onChange={(e) => change("compressor.crf", parseInt(e.target.value))}
              style={{ width: 180 }}
            />
          </Row>
          <BoolRow
            label={t("cmpSettings.cmpTenBit")}
            hint={t("cmpSettings.cmpTenBitHint")}
            value={comp.tenBit === true}
            onChange={(v) => change("compressor.tenBit", v)}
          />
          <BoolRow
            label={t("cmpSettings.cmpCleanup")}
            hint={t("cmpSettings.cmpCleanupHint")}
            value={comp.cleanupTemp !== false}
            onChange={(v) => change("compressor.cleanupTemp", v)}
          />
        </Section>

        {/* ---- Апскейл медиа (док: upscale) — умолчания ONNX-движка ---- */}
        <Section title={t("settings.upscale")} icon={Sparkles}>
          <Row label={t("upSettings.model")} hint={t("upSettings.modelHint")}>
            <TextInput
              value={String(up.model ?? "realesr-general-x4v3")}
              onChange={(v) => change("upscaler.model", v)}
            />
          </Row>
          <Row label={t("upSettings.scale")} hint={t("upSettings.scaleHint")}>
            <Select
              value={String(up.scale ?? 4)}
              onChange={(e) => change("upscaler.scale", Number(e.target.value))}
              options={["2", "3", "4"]}
            />
          </Row>
          <Row label={t("upSettings.format")} hint={t("upSettings.formatHint")}>
            <Select
              value={String(up.format ?? "png")}
              onChange={(e) => change("upscaler.format", e.target.value)}
              options={["png", "jpeg", "webp", "avif"]}
            />
          </Row>
          <Row
            label={t("upSettings.quality", { v: up.quality ?? 92 })}
            hint={t("upSettings.qualityHint")}
          >
            <input
              type="range"
              min="1"
              max="100"
              step="1"
              value={Number(up.quality ?? 92)}
              onChange={(e) => change("upscaler.quality", parseInt(e.target.value))}
              style={{ width: 180 }}
            />
          </Row>
          <Row label={t("upSettings.tile")} hint={t("upSettings.tileHint")}>
            <Select
              value={String(up.tile ?? 0)}
              onChange={(e) => change("upscaler.tile", Number(e.target.value))}
              options={["0", "256", "512", "1024"]}
            />
          </Row>
          <Row label={t("upSettings.provider")} hint={t("upSettings.providerHint")}>
            <Select
              value={String(up.provider ?? "auto")}
              onChange={(e) => change("upscaler.provider", e.target.value)}
              options={["auto", "cpu", "cuda", "dml"]}
            />
          </Row>
          <Row
            label={t("upSettings.sharpen", { v: up.sharpen ?? 0 })}
            hint={t("upSettings.sharpenHint")}
          >
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={Number(up.sharpen ?? 0)}
              onChange={(e) => change("upscaler.sharpen", parseInt(e.target.value))}
              style={{ width: 180 }}
            />
          </Row>
          <Row
            label={t("upSettings.denoise", { v: up.denoise ?? 0 })}
            hint={t("upSettings.denoiseHint")}
          >
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={Number(up.denoise ?? 0)}
              onChange={(e) => change("upscaler.denoise", parseInt(e.target.value))}
              style={{ width: 180 }}
            />
          </Row>
          <Row label={t("upSettings.vcodec")} hint={t("upSettings.vcodecHint")}>
            <Select
              value={String(up.vcodec ?? "x264")}
              onChange={(e) => change("upscaler.vcodec", e.target.value)}
              options={["x264", "x265", "av1"]}
            />
          </Row>
          <Row label={t("upSettings.vcrf", { v: up.vcrf ?? 20 })} hint={t("upSettings.vcrfHint")}>
            <NumberInput
              value={up.vcrf ?? 20}
              min={0}
              max={51}
              onChange={(v) => change("upscaler.vcrf", v === "" ? 20 : v)}
            />
          </Row>
          <Row label={t("upSettings.audio")} hint={t("upSettings.audioHint")}>
            <Select
              value={String(up.audioAction ?? "copy")}
              onChange={(e) => change("upscaler.audioAction", e.target.value)}
              options={["copy", "aac"]}
            />
          </Row>
        </Section>

        {/* ---- Видео (док: video) — дефолты для новых загрузок yt-dlp ---- */}
        <Section title={t("settings.video")} icon={Video}>
          <Row label={t("videoSection.videoQuality")} hint={t("videoSection.videoQualityHint")}>
            <Select
              value={String(video.defaultHeight ?? "best")}
              onChange={(e) => change("video.defaultHeight", e.target.value)}
              options={[
                { value: "best", label: t("videoSection.qualityBest") },
                { value: "2160", label: "2160p" },
                { value: "1440", label: "1440p" },
                { value: "1080", label: "1080p" },
                { value: "720", label: "720p" },
                { value: "480", label: "480p" },
              ]}
            />
          </Row>
          <BoolRow
            label={t("videoSection.videoEmbedThumb")}
            hint={t("videoSection.videoEmbedThumbHint")}
            value={video.embedThumbnail !== false}
            onChange={(v) => change("video.embedThumbnail", v)}
          />
          <BoolRow
            label={t("videoSection.videoSubs")}
            hint={t("videoSection.videoSubsHint")}
            value={!!video.downloadSubs}
            onChange={(v) => change("video.downloadSubs", v)}
          />
        </Section>

        {/* ---- Музыка (док: music) — качество аудио по умолчанию ---- */}
        <Section title={t("settings.musicSection")} icon={Music2}>
          <Row label={t("musicSection.musicQuality")} hint={t("musicSection.musicQualityHint")}>
            <Select
              value={String(musicS.defaultQuality ?? "320 kbps")}
              onChange={(e) => change("music.defaultQuality", e.target.value)}
              options={[
                "320 kbps",
                "256 kbps",
                "192 kbps",
                "128 kbps",
                "FLAC",
                "OPUS",
                "WAV",
                "AAC",
              ]}
            />
          </Row>
        </Section>

        {/* ---- Книги (док: books) ---- */}
        <Section title={t("nav.movies")} icon={Clapperboard}>
          <TmdbKeyRow />
          <Row label={t("moviesSettings.language")} hint={t("moviesSettings.languageHint")}>
            <TextInput
              value={String(moviesCfg.language || "ru-RU")}
              onChange={(v) => change("movies.language", v)}
              placeholder="ru-RU"
            />
          </Row>
          <Row label={t("moviesSettings.region")} hint={t("moviesSettings.regionHint")}>
            <TextInput
              value={String(moviesCfg.region || "RU")}
              onChange={(v) => change("movies.region", v)}
              placeholder="RU"
            />
          </Row>
          <BoolRow
            label={t("moviesSettings.adult")}
            hint={t("moviesSettings.adultHint")}
            value={!!moviesCfg.showAdult}
            onChange={(v) => change("movies.showAdult", v)}
          />
        </Section>

        {/* ---- Мониторинг (док: monitor) ---- */}
        <Section title={t("settings.monitor")} icon={Activity}>
          <BoolRow
            label={t("monSettings.monAutoStart")}
            hint={t("monSettings.monAutoStartHint")}
            value={mon.autoStart}
            onChange={(v) => change("monitor.autoStart", v)}
          />
          <Row label={t("monSettings.monRefreshMs")} hint={t("monSettings.monIntervalHint")}>
            <Select
              value={String(mon.refreshMs ?? 500)}
              onChange={(e) => change("monitor.refreshMs", Number(e.target.value))}
              options={[100, 200, 300, 500, 750, 1000].map((ms) => ({
                value: String(ms),
                label: String(ms),
              }))}
            />
          </Row>
          <BoolRow
            label={t("monSettings.monLhmAuto")}
            hint={t("monSettings.monLhmAutoHint")}
            value={mon.lhmAutoStart !== false}
            onChange={(v) => change("monitor.lhmAutoStart", v)}
          />
        </Section>

        {/* ---- My Space (док: myspace) ---- */}
        <Section title={t("settings.myspace")} icon={User}>
          <BoolRow
            label={t("myspaceSection.myAutosave")}
            hint={t("myspaceSection.myAutosaveHint")}
            value={mysp.autosave !== false}
            onChange={(v) => change("myspace.autosave", v)}
          />
          <BoolRow
            label={t("myspaceSection.mySpellcheck")}
            hint={t("myspaceSection.mySpellcheckHint")}
            value={!!mysp.spellcheck}
            onChange={(v) => change("myspace.spellcheck", v)}
          />
        </Section>

        {/* ---- Чат / ИИ (док: aichat) — со сворачиваемым подменю API-ключей ---- */}
        <Section title={t("settings.chat")} icon={MessageSquare}>
          <ApiKeysPanel />
          <BoolRow
            label={t("chat.chatStream")}
            hint={t("chat.chatStreamHint")}
            value={chat.stream}
            onChange={(v) => change("chat.stream", v)}
          />
          <Row label={t("chat.chatContext")} hint={t("chat.chatContextHint")}>
            <NumberInput
              value={chat.contextMessages}
              onChange={(v) => change("chat.contextMessages", v)}
              min={4}
              max={100}
              suffix=" msg"
            />
          </Row>
        </Section>

        {/* ---- Голос (док: voice) ---- */}
        <Section title={t("settings.voice")} icon={Mic2}>
          <Row label={t("voiceSettings.voiceLang")} hint={t("voiceSettings.voiceLangHint")}>
            <Select
              value={voice.defaultLanguage}
              onChange={(e) => change("voice.defaultLanguage", e.target.value)}
              options={["English", "Russian", "Chinese", "Spanish", "French", "German", "Japanese"]}
            />
          </Row>
          <Row label={t("voiceSettings.voiceVram")} hint={t("voiceSettings.voiceVramHint")}>
            <NumberInput
              value={Number(voice.vramGb ?? 4.5)}
              onChange={(v) => change("voice.vramGb", v)}
              min={2}
              max={48}
              step={0.5}
              suffix=" GB"
            />
          </Row>
          <Row label={t("voiceSettings.voiceLoudness")} hint={t("voiceSettings.voiceLoudnessHint")}>
            <NumberInput
              value={Number(voice.loudnessTarget ?? -16)}
              onChange={(v) => change("voice.loudnessTarget", v)}
              min={-30}
              max={-8}
              step={1}
              suffix=" LUFS"
            />
          </Row>
          {/* --- Интерпретатор Python для движков озвучки (F5-TTS / XTTS) ---
              torch и f5-tts редко стоят в том python, что лежит в PATH: обычно
              это venv/conda. Без этого поля рендер падал с «No module named
              'torch'», и задать нужное окружение из интерфейса было нечем. --- */}
          <Row label={t("voiceSettings.pythonCmd")} hint={t("voiceSettings.pythonCmdHint")}>
            <TextInput
              value={String(voice.pythonCmd ?? "python")}
              onChange={(v) => change("voice.pythonCmd", v)}
              placeholder="python"
            />
          </Row>
        </Section>

        {/* ---- Лекции: распознавание речи и нарезка чанков (док: lecture) ----
             Здесь ТОЛЬКО то, чего нет на странице лектория: язык Whisper,
             начальный промпт, потоки CPU и тайминги VAD-нарезки чанков.
             Модель/ускорение, ИИ-конспект и говорящие намеренно НЕ дублируются —
             они живут в панелях страницы лекций (кнопки «Модель и ускорение»,
             «ИИ-конспект», «Говорящие»), где рядом стоит сам материал записи. ---- */}
        <Section title={t("settings.lectureSttTitle")} icon={AudioLines}>
          <Row label={t("settings.lectureLangLabel")} hint={t("settings.lectureLangHint")}>
            <Select
              value={String(lec.language || "ru")}
              onChange={(e) => change("lecture.language", e.target.value)}
              options={[
                { value: "auto", label: t("settings.lectureLangAuto") },
                { value: "ru", label: "Русский" },
                { value: "en", label: "English" },
                { value: "de", label: "Deutsch" },
                { value: "fr", label: "Français" },
                { value: "es", label: "Español" },
                { value: "it", label: "Italiano" },
                { value: "zh", label: "中文" },
                { value: "ar", label: "العربية" },
              ]}
            />
          </Row>
          <Row label={t("settings.lecturePromptLabel")} hint={t("settings.lecturePromptHint")}>
            {/* Промпт уходит в whisper.cpp как --prompt: термины из него модель
                распознаёт заметно точнее (имена, формулы, предметная лексика). */}
            <TextInput
              value={String(lec.initialPrompt || "")}
              onChange={(v) => change("lecture.initialPrompt", v)}
              placeholder={t("settings.lecturePromptPlaceholder")}
            />
          </Row>
          <Row
            label={t("settings.lectureThreadsLabel")}
            hint={`${t("settings.lectureThreadsHint")}${
              cpuThreads > 0 ? ` ${t("settings.lectureThreadsAll", { n: cpuThreads })}` : ""
            }`}
          >
            {/* 0 (по умолчанию) — все логические потоки процессора: сервер сам
                подставит их число (см. resolveThreads в whisperEngine.ts). */}
            <NumberInput
              value={Number(lec.threads ?? 0)}
              onChange={(v) => change("lecture.threads", v)}
              min={0}
              max={64}
            />
          </Row>
        </Section>

        {/* ---- Web Archive / .sitebak (док: sitebak) — параметры краулера ---- */}
        <Section title={t("settings.sitebak")} icon={Archive}>
          <Row label={t("sbSettings.sbConcurrent")} hint={t("sbSettings.sbConcurrentHint")}>
            <NumberInput
              value={Number(sb.maxConcurrent ?? 3)}
              onChange={(v) => change("sitebak.maxConcurrent", v)}
              min={1}
              max={8}
            />
          </Row>
          <Row
            label={t("sbSettings.sbDelay", { v: sb.crawlDelayMs ?? 500 })}
            hint={t("sbSettings.sbDelayHint")}
          >
            <input
              type="range"
              min="0"
              max="3000"
              step="100"
              value={Number(sb.crawlDelayMs ?? 500)}
              onChange={(e) => change("sitebak.crawlDelayMs", parseInt(e.target.value))}
              style={{ width: 180 }}
            />
          </Row>
          <Row label={t("sbSettings.sbUa")} hint={t("sbSettings.sbUaHint")}>
            <TextInput
              value={sb.userAgent}
              onChange={(v) => change("sitebak.userAgent", v)}
              placeholder="Mozilla/5.0 …"
            />
          </Row>
          <Row label={t("sbSettings.sbDict")} hint={t("sbSettings.sbDictHint")}>
            <NumberInput
              value={Number(sb.zstdDictKb ?? 1024)}
              onChange={(v) => change("sitebak.zstdDictKb", v)}
              min={0}
              max={8192}
              step={256}
              suffix=" KB"
            />
          </Row>
          <Row label={t("sbSettings.sbMedia")} hint={t("sbSettings.sbMediaHint")}>
            <Select
              value={String(sb.mediaFormat ?? "webp")}
              onChange={(e) => change("sitebak.mediaFormat", e.target.value)}
              options={["original", "lossless", "webp", "avif"]}
            />
          </Row>
          <Row label={t("sbSettings.sbMaxPages")} hint={t("sbSettings.sbMaxPagesHint")}>
            <NumberInput
              value={Number(sb.maxPages ?? 500)}
              onChange={(v) => change("sitebak.maxPages", v)}
              min={10}
              max={5000}
              step={10}
            />
          </Row>
        </Section>

        {/* ---- Автобэкап ---- */}
        <Section title={t("settings.backup")} icon={Database}>
          <BoolRow
            label={t("backupSettings.backupEnable")}
            hint={t("backupSettings.backupEnableHint")}
            value={backup.auto}
            onChange={(v) => change("backup.auto", v)}
          />
          <Row
            label={t("backupSettings.backupInterval")}
            hint={t("backupSettings.backupIntervalHint")}
          >
            <NumberInput
              value={backup.intervalHours}
              onChange={(v) => change("backup.intervalHours", v)}
              min={1}
              max={720}
              suffix=" h"
            />
          </Row>
        </Section>

        {/* Экспорт и импорт ВСЕХ настроек: секции settings.json для каждой страницы
            + локальные настройки интерфейса (localStorage) + по галочке ключи API. */}
        <Section title={t("settingsIO.ioSection")} icon={Download}>
          <div className="muted-sm" style={{ marginBottom: 8 }}>
            {t("settingsIO.ioHint")}
          </div>
          <BoolRow
            label={t("settingsIO.ioSecrets")}
            hint={t("settingsIO.ioSecretsHint")}
            value={ioSecrets}
            onChange={setIoSecrets}
          />
          <Row label={t("settingsIO.ioFile")} hint={t("settingsIO.ioFileHint")}>
            <Btn
              variant="primary"
              icon={ioBusy === "export" ? RefreshCw : Download}
              onClick={exportSettings}
              disabled={!!ioBusy}
            >
              {t("settingsIO.ioExport")}
            </Btn>
            <Btn
              icon={ioBusy === "import" ? RefreshCw : Upload}
              onClick={() => ioFileRef.current?.click()}
              disabled={!!ioBusy}
            >
              {t("settingsIO.ioImport")}
            </Btn>
          </Row>
          {/* Скрытый input: выбор файла экспорта (.json) для импорта настроек. */}
          <input
            ref={ioFileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importSettingsFile(f);
            }}
          />
          {ioStatus && (
            <div
              className="muted-sm"
              style={{
                marginTop: -6,
                color:
                  ioTone === "err"
                    ? "var(--coral)"
                    : ioTone === "warn"
                      ? "var(--amber)"
                      : "var(--success)",
              }}
            >
              {ioStatus}
            </div>
          )}
        </Section>

        {/* ---- Продвинутое ---- */}
        <Section title={t("settings.advanced")} icon={ShieldCheck}>
          <BoolRow
            label={t("advanced.advancedTelemetry")}
            hint={t("advanced.advancedTelemetryHint")}
            value={adv.telemetry}
            onChange={(v) => change("advanced.telemetry", v)}
          />
          <Row label={t("advanced.advancedLogLevel")} hint={t("advanced.advancedLogLevelHint")}>
            <Select
              value={adv.logLevel}
              onChange={(e) => change("advanced.logLevel", e.target.value)}
              options={["debug", "info", "warn", "error"]}
            />
          </Row>
          <Row label={t("advanced.advancedMasterKey")} hint={t("advanced.advancedMasterKeyHint")}>
            <TextInput
              value={adv.masterKey}
              onChange={(v) => change("advanced.masterKey", v)}
              placeholder={t("advanced.advancedMasterKeyPlaceholder")}
            />
          </Row>
        </Section>

        {saved && (
          <Glass
            className="source-placeholder"
            style={{ borderColor: "var(--teal)", color: "var(--text-secondary)" }}
          >
            <Check size={15} style={{ color: "var(--success)" }} />
            <span>{t("settings.savedMsg")}</span>
          </Glass>
        )}

        {/* Несохранённые ветки: сюда попадают только те правки, которые сервер НЕ
            принял (успешные сразу убираются из набора, см. persist). Раньше это
            же число показывалось бейджем в шапке страницы — он убран, потому что
            рядом с названием страницы ничего не объяснял. */}
        {dirtyMap.size > 0 && (
          <Glass
            className="source-placeholder"
            style={{ borderColor: "var(--coral)", color: "var(--text-secondary)" }}
          >
            <AlertTriangle size={15} style={{ color: "var(--coral)" }} />
            <span>{t("settings.unsaved", { n: dirtyMap.size })}</span>
          </Glass>
        )}
      </Glass>
    </div>
  );
}

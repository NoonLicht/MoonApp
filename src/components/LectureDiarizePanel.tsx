import { useCallback, useEffect, useState } from "react";
import { Users, X, Download, Trash2, Check, AlertTriangle, RefreshCw, Play } from "lucide-react";
import { Btn, Badge } from "./ui";
import { useI18n } from "../i18n";
import type { TranslateFn } from "../i18n";
import { api } from "../api/client";
import type { LectureDiarizeSetup, LectureDiarizeState } from "../api/client";

/**
 * Панель «Говорящие»: разделение голосов внутри дорожки (sherpa-onnx).
 *
 * Зачем: двухдорожечный режим знает только «эфир = лектор, микрофон = аудитория».
 * На семинаре этого мало — не понять, кто из студентов отвечал. Диаризация
 * кластеризует голоса по отпечаткам и даёт «Лектор 2», «Аудитория 1».
 *
 * Пакет (~64 МБ: бинарь sherpa + модель сегментации + модель эмбеддингов)
 * скачивается по кнопке: тянуть его «на всякий случай» при первом запуске
 * приложения неправильно. Считается на процессоре; прогресс виден здесь и на
 * странице (полоса в шапке), потому что разбор длинной лекции идёт минутами.
 */

/** Коды ошибок бэкенда → текст (неизвестный код показываем как есть). */
function errorText(t: TranslateFn, raw: string): string {
  if (!raw) return "";
  if (/diarize_not_installed/.test(raw)) return t("lecture.diarizePanel.errNotInstalled");
  if (/raw_audio_missing/.test(raw)) return t("lecture.diarizePanel.errNoRaw");
  if (/session_live/.test(raw)) return t("lecture.diarizePanel.errLive");
  if (/diarize_busy/.test(raw)) return t("lecture.diarizePanel.errBusy");
  if (/diarize_track_unknown/.test(raw)) return t("lecture.diarizePanel.errTrack");
  if (/download_http_/.test(raw)) return t("lecture.setup.errDownload", { code: raw.replace("download_http_", "") });
  if (/tar_missing|extract_failed/.test(raw)) return t("lecture.diarizePanel.errExtract");
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|timeout/i.test(raw)) return t("lecture.setup.errNetwork");
  return raw;
}

export default function LectureDiarizePanel({
  onClose, inline = false, sessionId = 0, onChanged,
}: { onClose?: () => void; inline?: boolean; sessionId?: number; onChanged?: () => void }) {
  const { t } = useI18n();
  const [setup, setSetup] = useState<LectureDiarizeSetup | null>(null);
  const [st, setSt] = useState<LectureDiarizeState | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setSetup(await api.lectureDiarizeSetup()); }
    catch { /* бэкенд ещё поднимается — панель покажет «нет данных» */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Прогресс скачивания/распаковки пакета: одна задача за раз (task.state).
  const working = setup?.task.state === "working";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => { void load(); }, 900);
    return () => clearInterval(timer);
  }, [working, load]);

  // Прогресс разбора: авто-диаризация стартует сама после записи, поэтому панель
  // обязана видеть состояние и без нажатия кнопки.
  useEffect(() => {
    if (!sessionId) { setSt(null); return; }
    let alive = true;
    const tick = () => {
      void api.lectureDiarizeState(sessionId)
        .then((s) => { if (alive) setSt(s); })
        .catch(() => { /* состояние — необязательная роскошь */ });
    };
    tick();
    const timer = setInterval(tick, st?.state === "working" ? 1200 : 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [sessionId, st?.state]);const run = useCallback(async (fn: () => Promise<LectureDiarizeSetup | LectureDiarizeState>, key: string) => {
    setBusy(key);
    setError("");
    try {
      const r = await fn();
      // setupInfo и состояние прогона приходят разными формами — различаем по полю.
      if (r && (r as LectureDiarizeSetup).packages) setSetup(r as LectureDiarizeSetup);
      else setSt(r as LectureDiarizeState);
      onChanged?.();
    } catch (e) { setError(errorText(t, String((e as Error)?.message || e))); }
    setBusy("");
  }, [onChanged, t]);

  const install = (id: "bin" | "seg" | "emb" | "all") =>
    void run(() => api.lectureDiarizeInstall(id), `install:${id}`);
  const remove = (id: string) => void run(() => api.lectureDiarizeRemove(id), `remove:${id}`);
  const saveSetting = (patch: {
    enabled?: boolean; track?: "auto" | "sys" | "mic"; threshold?: number; speakers?: number;
  }) => void run(() => api.lectureDiarizeSet(patch).then(() => api.lectureDiarizeSetup()), "settings");
  const startRun = () => {
    if (!sessionId) return;
    void run(() => api.lectureDiarizeRun(sessionId), "run");
  };

  const cfg = setup?.settings || null;
  const ready = !!setup?.ready;
  const totalMb = (setup?.packages || []).reduce((n, p) => n + (p.installed ? 0 : p.sizeMb), 0);
  const running = st?.state === "working";

  const body = (
    <div className={inline ? "lecs-inline-body" : "lecs-panel"}>
      {/* Шапка */}
      <div className="lecs-head">
        <span className="lecs-icon"><Users size={17} /></span>
        <div className="lecs-title">
          <div className="lecs-eyebrow">{t("lecture.diarizePanel.eyebrow")}</div>
          <div className="lecs-h1">{t("lecture.diarizePanel.title")}</div>
        </div>
        <span className={`lecs-pill ${ready ? "on" : "off"}`}>
          {ready ? t("lecture.diarizePanel.ready") : t("lecture.diarizePanel.notReady")}
        </span>
        <button className="lecs-close" onClick={load} title={t("lecture.diarizePanel.refresh")}><RefreshCw size={14} /></button>
        {!inline && (
          <button className="lecs-close" onClick={onClose} title={t("common.close")}><X size={15} /></button>
        )}
      </div>

      {!!error && <div className="lecs-error">{error}</div>}

      {/* --- Пакет не установлен: объясняем, что и зачем качаем --- */}
      {!ready && (
        <div className="lecs-block">
          <div className="lecs-block-label">{t("lecture.diarizePanel.packages")}</div>
          {setup?.packages.map((p) => {
            const active = setup.task.state === "working" && setup.task.id === p.id;
            return (
              <div className="lecs-row" key={p.id}>
                <div className="lecs-row-main">
                  <div className="lecs-row-name">
                    {t(`lecture.diarizePanel.pkg.${p.id}`)}
                    <Badge tone="neutral" mono>{p.sizeMb} MB</Badge>
                    {p.installed && <Badge tone="teal">{t("lecture.setup.installed")}</Badge>}
                  </div>
                  {active && (
                    <div className="leca-bar">
                      <i style={{ width: `${setup.task.progress}%` }} />
                    </div>
                  )}
                </div>
                <div className="lecs-row-actions">
                  {!p.installed && (
                    <Btn variant="secondary" icon={Download} disabled={!!busy || working}
                      onClick={() => install(p.id as "bin" | "seg" | "emb")}>
                      {active ? t("lecture.setup.downloading") : t("lecture.setup.download")}
                    </Btn>
                  )}
                </div>
              </div>
            );
          })}
          <div className="lecs-dim lecs-hint">{t("lecture.diarizePanel.packagesHint", { mb: totalMb || 54 })}</div>
          <Btn variant="primary" icon={Download} disabled={!!busy || working} onClick={() => install("all")}>
            {working ? t("lecture.setup.downloading") : t("lecture.diarizePanel.installAll", { mb: totalMb || 54 })}
          </Btn>
        </div>
      )}      {/* --- Пакет установлен: настройки разбора и запуск --- */}
      {ready && cfg && (
        <div className="lecs-block">
          <div className="lecs-block-label">{t("lecture.diarizePanel.settings")}</div>

          {/* Авто-разбор после записи. По умолчанию выключен: это минуты CPU. */}
          <label className="lec-check">
            <input type="checkbox" checked={cfg.enabled} disabled={!!busy}
              onChange={(e) => saveSetting({ enabled: e.target.checked })} />
            {t("lecture.diarizePanel.auto")}
          </label>
          <div className="lecs-dim lecs-hint">{t("lecture.diarizePanel.autoHint")}</div>

          <div className="leca-row">
            <span className="lecs-dim leca-label">{t("lecture.diarizePanel.track")}</span>
            <select className="lecs-select leca-select" value={cfg.track} disabled={!!busy}
              onChange={(e) => saveSetting({ track: e.target.value as "auto" | "sys" | "mic" })}>
              {(["auto", "sys", "mic"] as const).map((k) => (
                <option key={k} value={k}>{t(`lecture.diarizePanel.trackKind.${k}`)}</option>
              ))}
            </select>
          </div>

          <div className="leca-row">
            <span className="lecs-dim leca-label">{t("lecture.diarizePanel.speakers")}</span>
            <input
              className="lecs-input leca-num"
              type="number" min={-1} max={12} step={1}
              value={cfg.speakers} disabled={!!busy}
              onChange={(e) => saveSetting({ speakers: Number(e.target.value) })}
            />
            <span className="lecs-dim lecs-hint">{t("lecture.diarizePanel.speakersHint")}</span>
          </div>

          <div className="leca-row">
            <span className="lecs-dim leca-label">{t("lecture.diarizePanel.threshold")}</span>
            <input
              className="lecs-input leca-num"
              type="number" min={0.3} max={0.9} step={0.05}
              value={cfg.threshold} disabled={!!busy || cfg.speakers > 0}
              onChange={(e) => saveSetting({ threshold: Number(e.target.value) })}
            />
            <span className="lecs-dim lecs-hint">{t("lecture.diarizePanel.thresholdHint")}</span>
          </div>

          <div className="lecs-verify">
            <Btn variant="primary" icon={Play} onClick={startRun} disabled={!sessionId || running || !!busy}>
              {running ? t("lecture.diarizePanel.running") : t("lecture.diarizePanel.run")}
            </Btn>
            {!sessionId && <span className="lecs-dim">{t("lecture.diarizePanel.pickSession")}</span>}
            <Btn variant="ghost" icon={Trash2} disabled={!!busy || working}
              onClick={() => remove("all")} title={t("lecture.diarizePanel.removeHint")}>
              {t("lecture.diarizePanel.remove")}
            </Btn>
          </div>

          {/* Прогресс разбора: дорожка + проценты. */}
          {running && (
            <div className="lecs-block">
              <div className="leca-bar"><i style={{ width: `${st?.progress || 0}%` }} /></div>
              <div className="lecs-dim lecs-hint">
                {t(`lecture.diarizePanel.trackKind.${st?.phase === "sys" ? "sys" : "mic"}`)}
                {` · ${st?.progress || 0}%`}
              </div>
            </div>
          )}
          {st?.state === "done" && (
            <div className="lecs-ok">
              <Check size={12} />
              <span>{t("lecture.diarizePanel.done", { n: st.speakers })}</span>
            </div>
          )}
          {st?.state === "error" && (
            <div className="lecs-error">{errorText(t, st.error)}</div>
          )}
          <div className="lecs-dim lecs-hint">{t("lecture.diarizePanel.speedHint")}</div>
        </div>
      )}

      {/* Пакет есть, но лекция не выбрана: подсказываем, что делать. */}
      {ready && !sessionId && (
        <div className="lecs-warn">
          <AlertTriangle size={13} />
          <span>{t("lecture.diarizePanel.pickSessionHint")}</span>
        </div>
      )}
    </div>
  );

  if (inline) return body;
  return (
    <div className="lecs-overlay" onClick={onClose}>
      <div className="lecs-modal leca-modal" onClick={(e) => e.stopPropagation()}>
        {/* .lecs-body — тело со скроллом, шапка с крестиком остаётся видимой. */}
        <div className="lecs-body">{body}</div>
      </div>
    </div>
  );
}
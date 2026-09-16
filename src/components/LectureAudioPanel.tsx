import { useCallback, useEffect, useState } from "react";
import { X, Mic, Volume2, RefreshCw, Waves, AlertTriangle, Check } from "lucide-react";
import { Btn, Badge } from "./ui";
import { useI18n } from "../i18n";
import type { TranslateFn } from "../i18n";
import type { LectureAudioSettings, LectureVadMetrics } from "../api/client";

/**
 * Панель «Аудио» страницы лекций: выбор микрофона, усиление входа и настройки
 * VAD (порог, автоподстройка, анти-шум).
 *
 * Зачем это появилось: раньше вход всегда брался «по умолчанию» (часто это
 * микрофон веб-камеры), порог VAD был жёстко зашит (0.008 RMS), а причина
 * пустых чанков в UI не показывалась. В итоге запись могла собирать шум, а
 * пользователь видел только «тишина/шум — отброшено VAD».
 */
export default function LectureAudioPanel({
  onClose, settings, devices, levelDb, metrics, recording, calibrating,
  onSave, onCalibrate, onRefreshDevices, inline = false,
}: {
  onClose?: () => void;
  settings: LectureAudioSettings | null;
  devices: { id: string; label: string }[];
  levelDb: number;
  metrics: LectureVadMetrics | null;
  recording: boolean;
  calibrating: boolean;
  onSave: (patch: {
    micDeviceId?: string; micGain?: number; micAgc?: boolean;
    vad?: { rmsThreshold?: number; adaptive?: boolean; thresholdFactor?: number; minSpeechRatio?: number; zcrGate?: boolean };
  }) => Promise<void> | void;
  onCalibrate: () => void;
  onRefreshDevices: () => void;
  inline?: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<LectureAudioSettings | null>(settings);
  const [saved, setSaved] = useState(false);

  // Настройки приходят извне (после сохранения/калибровки) — держим черновик
  // синхронным, иначе слайдеры «отскакивали» бы к прежним значениям.
  useEffect(() => { setDraft(settings); }, [settings]);

  const apply = useCallback(async () => {
    if (!draft) return;
    await onSave({
      micGain: draft.micGain,
      vad: {
        rmsThreshold: draft.vad.rmsThreshold,
        adaptive: draft.vad.adaptive,
        thresholdFactor: draft.vad.thresholdFactor,
        minSpeechRatio: draft.vad.minSpeechRatio,
        zcrGate: draft.vad.zcrGate,
      },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, [draft, onSave]);

  const vad = draft?.vad;
  const thresholdDb = Math.round(20 * Math.log10(Math.max(0.0005, vad?.rmsThreshold ?? 0.008)) * 10) / 10;

  const body = (
    <div className={inline ? "lecs-inline-body" : "lecs-panel"}>
      <div className="lecs-head">
        <span className="lecs-icon"><Volume2 size={17} /></span>
        <div className="lecs-title">
          <div className="lecs-eyebrow">{t("lecture.audio.eyebrow")}</div>
          <div className="lecs-h1">{t("lecture.audio.title")}</div>
        </div>
        <span className={`lecs-pill ${levelDb >= (vad?.rmsThreshold != null ? 20 * Math.log10(vad.rmsThreshold) : -42) ? "on" : "off"}`}>
          {Math.round(levelDb)} dBFS
        </span>
        {!inline && (
          <button className="lecs-close" onClick={onClose} title={t("common.close")}><X size={15} /></button>
        )}
      </div>

      {recording && (
        <div className="lecs-warn">
          <AlertTriangle size={13} />
          <span>{t("lecture.audio.appliesNext")}</span>
        </div>
      )}

      {/* --- Микрофон --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.audio.micTitle")}</div>
        <div className="lecs-bin">
          <Mic size={14} />
          <select
            className="lecs-select leca-select"
            value={draft?.micDeviceId || ""}
            disabled={recording}
            onChange={(e) => void onSave({ micDeviceId: e.target.value })}
          >
            <option value="">{t("lecture.audio.micDefault")}</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <Btn variant="ghost" icon={RefreshCw} onClick={onRefreshDevices} disabled={recording}>
            {t("lecture.audio.micRefresh")}
          </Btn>
        </div>
        <div className="lecs-dim lecs-hint">{t("lecture.audio.micHint")}</div>
        {devices.length === 0 && <div className="lecs-warn"><AlertTriangle size={13} /><span>{t("lecture.audio.micNone")}</span></div>}
      </div>

      {/* --- Уровень и усиление входа --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.audio.levelTitle")}</div>
        <div className="leca-row">
          <LevelMeter db={levelDb} thresholdDb={thresholdDb} t={t} />
          <span className="lecs-dim">{t("lecture.audio.thresholdShort", { db: thresholdDb })}</span>
        </div>
        <div className="leca-row">
          <span className="lecs-dim leca-label">{t("lecture.audio.gain", { v: Number(vad ? draft?.micGain ?? 1 : 1).toFixed(1) })}</span>
          <input
            type="range" min="0.5" max="4" step="0.1"
            value={Number(draft?.micGain ?? 1)}
            disabled={recording}
            onChange={(e) => setDraft((d) => (d ? { ...d, micGain: parseFloat(e.target.value) } : d))}
            style={{ width: 170 }}
          />
          <label className="lec-check">
            <input type="checkbox" checked={draft?.micAgc === true} disabled={recording}
              onChange={(e) => void onSave({ micAgc: e.target.checked })} />
            {t("lecture.audio.agc")}
          </label>
        </div>
        <div className="lecs-dim lecs-hint">{t("lecture.audio.gainHint")}</div>
        <div className="lecs-verify">
          <Btn variant="secondary" icon={Waves} onClick={onCalibrate} disabled={calibrating || recording}>
            {calibrating ? t("lecture.audio.calibrating") : t("lecture.audio.calibrate")}
          </Btn>
          <span className="lecs-dim">{t("lecture.audio.calibrateHint")}</span>
        </div>
      </div>

      {/* --- Порог VAD --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.audio.vadTitle")}</div>
        <div className="leca-row">
          <label className="lec-check">
            <input type="checkbox" checked={vad?.adaptive !== false}
              onChange={(e) => void onSave({ vad: { adaptive: e.target.checked } })} />
            {t("lecture.audio.adaptive")}
          </label>
          <label className="lec-check">
            <input type="checkbox" checked={vad?.zcrGate !== false}
              onChange={(e) => void onSave({ vad: { zcrGate: e.target.checked } })} />
            {t("lecture.audio.zcr")}
          </label>
        </div>
        <div className="leca-row">
          <span className="lecs-dim leca-label">{t("lecture.audio.manualThreshold", { db: thresholdDb })}</span>
          <input
            type="range" min="-66" max="-14" step="1"
            value={Math.max(-66, Math.min(-14, thresholdDb))}
            disabled={vad?.adaptive !== false}
            onChange={(e) => {
              const db = parseFloat(e.target.value);
              setDraft((d) => (d ? { ...d, vad: { ...d.vad, rmsThreshold: Math.pow(10, db / 20) } } : d));
            }}
            style={{ width: 170 }}
          />
        </div>
        <div className="leca-row">
          <span className="lecs-dim leca-label">{t("lecture.audio.factor", { v: Number(vad?.thresholdFactor ?? 3).toFixed(1) })}</span>
          <input
            type="range" min="1.5" max="8" step="0.5"
            value={Number(vad?.thresholdFactor ?? 3)}
            disabled={vad?.adaptive === false}
            onChange={(e) => setDraft((d) => (d ? { ...d, vad: { ...d.vad, thresholdFactor: parseFloat(e.target.value) } } : d))}
            style={{ width: 170 }}
          />
        </div>
        <div className="leca-row">
          <span className="lecs-dim leca-label">{t("lecture.audio.minRatio", { v: Math.round(Number(vad?.minSpeechRatio ?? 0.15) * 100) })}</span>
          <input
            type="range" min="0" max="0.6" step="0.01"
            value={Number(vad?.minSpeechRatio ?? 0.15)}
            onChange={(e) => setDraft((d) => (d ? { ...d, vad: { ...d.vad, minSpeechRatio: parseFloat(e.target.value) } } : d))}
            style={{ width: 170 }}
          />
        </div>
        <div className="lecs-dim lecs-hint">{t("lecture.audio.vadHint")}</div>
        <div className="lecs-verify">
          <Btn variant="secondary" icon={saved ? Check : undefined} onClick={() => void apply()} disabled={recording}>
            {saved ? t("lecture.notesSaved") : t("lecture.audio.apply")}
          </Btn>
        </div>
      </div>

      {/* --- Диагностика: что реально происходит со входом --- */}
      {metrics && (
        <div className="lecs-block">
          <div className="lecs-block-label">{t("lecture.audio.diagTitle")}</div>
          <div className="leca-diag">
            <span><Badge tone="neutral" mono>{t("lecture.audio.diagThreshold")}</Badge> {metrics.thresholdDb} dBFS</span>
            <span><Badge tone="neutral" mono>{t("lecture.audio.diagNoise")}</Badge> {metrics.noiseFloorDb} dBFS</span>
            <span><Badge tone="neutral" mono>{t("lecture.audio.diagSpeech")}</Badge> {metrics.stats.speechFrames}/{metrics.stats.frames}</span>
            <span><Badge tone="neutral" mono>{t("lecture.audio.diagNoiseFrames")}</Badge> {metrics.stats.noiseFrames}</span>
            <span><Badge tone="neutral" mono>{t("lecture.audio.diagSkipped")}</Badge> {Math.round(metrics.stats.skippedMs / 1000)} {t("lecture.audio.sec")}</span>
            <span><Badge tone="neutral" mono>{t("lecture.audio.diagChunks")}</Badge> {metrics.stats.chunks}</span>
          </div>
          <div className="lecs-dim lecs-hint">{t("lecture.audio.diagHint")}</div>
        </div>
      )}
    </div>
  );
  const inner = <div className="lecs-body">{body}</div>;

  if (inline) return <div className="leca-inline">{body}</div>;
  return (
    <div className="lecs-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="lecs-modal leca-modal">{inner}</div>
    </div>
  );
}

/** Индикатор уровня входа в dBFS с отметкой порога VAD. */
export function LevelMeter({ db, thresholdDb, t }: { db: number; thresholdDb: number; t: TranslateFn }) {
  // −60…0 dBFS → 0…100 %.
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const thrPct = Math.max(0, Math.min(100, ((thresholdDb + 60) / 60) * 100));
  const quiet = db < thresholdDb;
  return (
    <span className={`lec-meter ${quiet ? "quiet" : "ok"}`} title={t("lecture.audio.meterHint", { db, thr: thresholdDb })}>
      <span className="lec-meter-bar"><i style={{ width: `${pct}%` }} /></span>
      <span className="lec-meter-mark" style={{ left: `${thrPct}%` }} />
      <span className="lec-meter-db">{Math.round(db)} dB</span>
    </span>
  );
}
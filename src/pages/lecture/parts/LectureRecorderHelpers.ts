/**
 * Выделено из LectureRecorderPage.tsx при разбиении крупного файла (поведение не менялось).
 */
import type { LectureChunk, LectureConspectusState } from "@/api/client";
import type { TranslateFn } from "@/app/i18n";
import { parseModelNameError } from "@/lib/modelError";

/**
 * Lecture Recorder — реалтайм-запись лекции и академический speech-to-text.
 *
 * Поток (fail-safe архитектура):
 *   getUserMedia → AudioContext → ScriptProcessorNode
 *     ├─ даунсэмпл →16k + Int16 → POST /api/lecture/:id/ingest (~каждые 500 мс)
 *     │     └─ на сервере: непрерывный raw.wav + VAD-чанки → whisper.cpp
 *     └─ локальный waveform-визуализатор (canvas)
 *
 * Транскрипт приходит поллингом GET /api/lecture/:id — чанки с таймкодами,
 * click-to-edit. Ctrl+B / F2 — маркер «важного». AI-конспект — через провайдера
 * чата (DeepSeek и др.), чанками по блокам расшифровки.
 */

export const TARGET_RATE = 16000;
export const SEND_INTERVAL_MS = 500;

export function fmtTs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  return [h, m, sec].map((x) => String(x).padStart(2, "0")).join(":");
}

/**
 * Человеческая подпись пустой/пропущенной строки транскрипта.
 *
 * Раньше на всё было одно «тишина/шум — отброшено VAD», и понять, что случилось
 * (шум на входе? тихий микрофон? Whisper не разобрал?), было невозможно.
 * Теперь показываем РЕАЛЬНУЮ причину и измеренный уровень в dBFS.
 */
/**
 * Метка говорящего по диаризации: «№2» — второй голос на этой дорожке.
 * «?» — в чанке звучали двое (доля доминирующего голоса < 55%): честнее
 * показать сомнение, чем приписать реплику не тому человеку.
 */
export function speakerBadge(c: LectureChunk): string {
  const sp = String(c.speaker || "");
  if (!sp) return "";
  const n = Number(sp.split("_")[1]);
  if (!Number.isFinite(n)) return "";
  return `№${n + 1}${Number(c.speakerRatio ?? 1) < 0.55 ? "?" : ""}`;
}

export function chunkNote(t: TranslateFn, c: LectureChunk): string {
  const db = typeof c.rms_db === "number" ? t("lecture.diag.db", { db: c.rms_db }) : "";
  const peak =
    typeof c.rms_peak_db === "number" ? t("lecture.diag.peak", { db: c.rms_peak_db }) : "";
  switch (c.reason) {
    case "noise":
      return t("lecture.diag.noise", { db: peak || db });
    case "hum":
      return t("lecture.diag.hum", { db: peak || db });
    case "noise_burst":
      return t("lecture.diag.noiseBurst", { db: peak || db });
    case "low_speech_ratio":
      return t("lecture.diag.lowSpeech", { db: peak || db });
    case "whisper_empty":
      return t("lecture.diag.whisperEmpty", { db: peak || db });
    default:
      break;
  }
  if (c.status === "vad_skip") return t("lecture.diag.vadSkip", { db: peak || db });
  if (c.status === "empty") return t("lecture.diag.whisperEmpty", { db: peak || db });
  return c.error || t("lecture.chunkEmpty");
}

/**
 * Ошибки бэкенда — это коды (session_not_found, whisper_not_installed, …), а
 * браузера — DOMException'ы. Показываем пользователю понятный текст, а не код.
 */
export function lectureError(t: TranslateFn, e: unknown): string {
  const msg = String((e as Error)?.message || e || "");
  if (/no_system_audio/.test(msg)) return t("lecture.errSystemAudio");
  if (/NotAllowedError|PermissionDenied|permission denied|NotAllowed/i.test(msg))
    return t("lecture.errMic");
  if (/NotFoundError|Requested device|no_mic/i.test(msg)) return t("lecture.errNoMic");
  if (/session_not_found/.test(msg)) return t("lecture.errSession");
  if (/whisper_not_installed|whisper_model_missing/.test(msg)) return t("lecture.errWhisper");
  if (/no_transcript_yet/.test(msg)) return t("lecture.errNoTranscript");
  // Конспект идёт через провайдера чата: нет ключа/провайдера или модель не
  // найдена — это разные подсказки пользователю (сохранить ключ vs выбрать модель).
  if (/conspectus_not_configured/.test(msg))
    return t("lecture.errConspectusKey", { provider: msg.split(": ")[1] || "" });
  if (/conspectus_provider_unknown/.test(msg))
    return t("lecture.errConspectusProvider", { provider: msg.split(": ")[1] || "" });
  if (/conspectus_model_missing/.test(msg)) return t("lecture.errConspectusModel");
  if (/conspectus_busy/.test(msg)) return t("lecture.errConspectusBusy");
  if (/conspectus_empty_response/.test(msg)) return t("lecture.errConspectusEmpty");
  // Провайдер не знает такую модель (опечатка или переименование у вендора).
  // Раньше пользователь видел сырой ответ шлюза вроде
  // «api error 400: {"error":{"message":"The supported API model names are …"}}»,
  // из которого не понять, что делать: теперь показываем имена, которые
  // принимает сервис, а рядом есть кнопка их сохранения (см. баннер ошибки).
  const modelErr = parseModelNameError(msg);
  if (modelErr)
    return t("lecture.errModelNames", {
      model: modelErr.model || "—",
      names: modelErr.names.join(", "),
    });
  if (/HTTP \d+/.test(msg)) return t("lecture.errServer", { code: msg.replace(/^HTTP\s+/, "") });
  return msg || t("lecture.errGeneric");
}

/** Текст прогресса сборки конспекта: заметки по блокам → сведение в конспект. */
export function conspectusProgressText(t: TranslateFn, st: LectureConspectusState): string {
  if (st.phase === "merge") return t("lecture.conspectusMerge");
  return t("lecture.conspectusNotes", { done: st.progress, total: st.total });
}

/** Даунсэмпл Float32 → Int16 16 кГц (линейная интерполяция). */
export function downsampleToInt16(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Int16Array {
  const ratio = inputRate / outputRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const frac = idx - i0;
    const s0 = input[i0] ?? 0;
    const s1 = input[i0 + 1] ?? s0;
    const v = (s0 + (s1 - s0) * frac) * 32767;
    out[i] = v > 32767 ? 32767 : v < -32767 ? -32767 : Math.round(v);
  }
  return out;
}

/** Устройство ввода по умолчанию: явный выбор → дефолт системы. */
export async function acquireMic(deviceId: string, agc: boolean): Promise<MediaStream> {
  const base: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    // AGC браузера по умолчанию ВЫКЛ: он «качает» уровень, из-за чего VAD
    // видит то тишину, то всплеск — а для лекции нужен ровный сигнал.
    autoGainControl: agc === true,
  };
  if (deviceId) base.deviceId = { exact: deviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: base });
  } catch (e) {
    // Устройство могло отключиться между выбором и стартом — падать нельзя,
    // иначе лекция не начнётся вообще. Возвращаемся к системному дефолту.
    if (
      deviceId &&
      /NotFoundError|OverconstrainedError|NotReadableError/i.test(String((e as Error)?.message))
    ) {
      delete base.deviceId;
      return navigator.mediaDevices.getUserMedia({ audio: base });
    }
    throw e;
  }
}

/**
 * Системный звук онлайн-лекции: WASAPI-loopback через Electron.
 *
 * РАНЬШЕ: getDisplayMedia({video:true, audio:true}) — без
 * setDisplayMediaRequestHandler Electron отдавал видео (скрин/окно), а аудио
 * приходило от выбранного источника или отсутствовало: в запись уходил шум и
 * «звук с камер», а не звук системы. Теперь main-процесс по IPC ставит
 * обработчик с audio: "loopback" и отдаёт НАСТОЯЩИЙ звук устройства вывода.
 */
export async function acquireSystemAudio(): Promise<MediaStream> {
  const bridge = window.appBridge;
  await bridge?.setCaptureMode?.("loopback");
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    const audioTracks = display.getAudioTracks();
    if (!audioTracks.length) {
      display.getTracks().forEach((tr) => tr.stop());
      throw new Error("no_system_audio");
    }
    // Видео нужно было только как «носитель» аудио — сразу отпускаем.
    display.getVideoTracks().forEach((tr) => tr.stop());
    return new MediaStream(audioTracks);
  } finally {
    // Обработчик живёт только на время захвата, иначе он подменил бы обычный
    // выбор экрана всем остальным страницам приложения.
    await bridge?.setCaptureMode?.("default");
  }
}

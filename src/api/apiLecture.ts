/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { req, rawPost, BASE, tokenHeaders, filenameFromDisposition } from "@/api/apiHttp";
import type {
  LectureEngineStatus,
  LectureSession,
  LectureCreateResult,
  LectureStatus,
  LectureAudioSettings,
  LectureAudioPatch,
  LectureRecheckState,
  LectureChunk,
  LectureConspectusResult,
  LectureConspectusState,
  LectureConspectusSettings,
  LectureConspectusTrigger,
  LectureConspectusPreset,
  LectureProviderInfo,
  LectureDiarizeSetup,
  LectureDiarizeSettings,
  LectureDiarizeState,
  LectureEngineSetup,
} from "@/api/apiTypesLecture";

export const lectureApi = {
  // Lecture Recorder
  lectureEngine: () => req<LectureEngineStatus>("GET", "/lecture/engine"),
  lectureSessions: () => req<LectureSession[]>("GET", "/lecture/sessions"),
  lectureCreate: (title: string) =>
    req<LectureCreateResult>("POST", "/lecture/sessions", {
      title,
      sampleRate: 16000,
      channels: 1,
    }),
  lectureStatus: (id: number) => req<LectureStatus>("GET", `/lecture/${id}`),
  lectureIngest: (id: number, body: ArrayBuffer, track: "mic" | "sys" = "mic") =>
    rawPost(`/api/lecture/${id}/ingest${track === "sys" ? "?track=sys" : ""}`, body),
  // --- Аудиовход: микрофон, гейн, порог VAD + «Проверить пропуски» ---
  // Настройки меняются до старта записи: VAD-опции читаются в createSession.
  lectureAudio: () => req<LectureAudioSettings>("GET", "/lecture/audio"),
  lectureAudioSet: (patch: LectureAudioPatch) =>
    req<LectureAudioSettings>("POST", "/lecture/audio", patch),
  // Повторная расшифровка участков, потерянных VAD/Whisper (шум, тихий сигнал).
  lectureRecheck: (id: number) => req<LectureRecheckState>("POST", `/lecture/${id}/recheck`, {}),
  lectureRecheckState: (id: number) => req<LectureRecheckState>("GET", `/lecture/${id}/recheck`),
  lectureEditChunk: (chunkId: number, text: string) =>
    req<LectureChunk>("PATCH", `/lecture/chunks/${chunkId}`, { text }),
  lectureMarker: (id: number, atMs: number, label: string) =>
    req<{ atMs: number; timestamp: string; label: string }>("POST", `/lecture/${id}/markers`, {
      atMs,
      label,
    }),
  lectureStop: (id: number) => req<LectureStatus>("POST", `/lecture/${id}/stop`),
  lectureDelete: (id: number) => req<{ ok: boolean }>("DELETE", `/lecture/${id}`),
  // ВНИМАНИЕ: раньше здесь были lectureExportUrl/lectureAudioUrl — «голые»
  // ссылки на /api/lecture/... Их нельзя использовать для скачивания: роуты
  // закрыты токеном, а <a download>/<audio src> заголовок не передают (401).
  // Для файлов используйте lectureDownloadExport/lectureDownloadAudio/
  // lectureChunkAudio — они тянут blob с токеном (см. ниже).
  lectureSetNotes: (id: number, notes: string) =>
    req<LectureSession>("PATCH", `/lecture/${id}`, { notes }),
  // replace=true — «Регенерировать»: конспект собирается заново из расшифровки и
  // ПЕРЕЗАПИСЫВАЕТ заметки лекции (см. server/routes/lecture.js).
  lectureConspectus: (id: number, replace = false) =>
    req<LectureConspectusResult>("POST", `/lecture/${id}/conspectus`, { replace }),
  // Прогресс сборки конспекта: POST выше может идти минутами (десятки запросов
  // к модели), поэтому страница параллельно опрашивает состояние.
  lectureConspectusState: (id: number) =>
    req<LectureConspectusState>("GET", `/lecture/${id}/conspectus`),
  // --- ИИ-конспект: провайдер и режим запуска (панель «ИИ-конспект») ---
  lectureConspectusSettings: () =>
    req<LectureConspectusSettings>("GET", "/lecture/conspectus/settings"),
  lectureConspectusSetSettings: (patch: {
    providerId?: string;
    model?: string;
    trigger?: LectureConspectusTrigger;
    autoMinChars?: number;
    chunkChars?: number;
    overlapChars?: number;
    maxChunks?: number;
    systemPrompt?: string;
    presetId?: string;
    maxTokens?: number;
  }) => req<LectureConspectusSettings>("POST", "/lecture/conspectus/settings", patch),
  lectureConspectusSavePreset: (patch: { id?: string; label: string; systemPrompt: string }) =>
    req<LectureConspectusPreset[]>("POST", "/lecture/conspectus/presets", patch),
  lectureConspectusDeletePreset: (id: string) =>
    req<LectureConspectusPreset[]>(
      "DELETE",
      `/lecture/conspectus/presets/${encodeURIComponent(id)}`,
    ),
  lectureProviders: () => req<LectureProviderInfo[]>("GET", "/lecture/providers"),
  lectureProviderModels: (id: string) =>
    req<{ provider: string; models: string[] }>(
      "GET",
      `/lecture/providers/${encodeURIComponent(id)}/models`,
    ),
  // --- Разделение говорящих (sherpa-onnx diarization) ---
  lectureDiarizeSetup: () => req<LectureDiarizeSetup>("GET", "/lecture/diarize/setup"),
  lectureDiarizeInstall: (id: "bin" | "seg" | "emb" | "all" = "all") =>
    req<LectureDiarizeSetup>("POST", "/lecture/diarize/install", { id }),
  lectureDiarizeRemove: (id: string) =>
    req<LectureDiarizeSetup>("POST", "/lecture/diarize/remove", { id }),
  lectureDiarizeCancel: () => req<LectureDiarizeSetup>("POST", "/lecture/diarize/cancel", {}),
  lectureDiarizeSet: (patch: {
    enabled?: boolean;
    track?: "auto" | "sys" | "mic";
    threshold?: number;
    speakers?: number;
  }) => req<LectureDiarizeSettings>("POST", "/lecture/diarize/settings", patch),
  lectureDiarizeRun: (id: number, track?: "sys" | "mic") =>
    req<LectureDiarizeState>("POST", `/lecture/${id}/diarize`, track ? { track } : {}),
  lectureDiarizeState: (id: number) => req<LectureDiarizeState>("GET", `/lecture/${id}/diarize`),
  // --- Настройка движка распознавания: модель, сборка (CPU/CUDA), устройство ---
  // Все методы возвращают один и тот же LectureEngineSetup, поэтому панель
  // настроек после любого действия просто перезаписывает состояние целиком.
  lectureEngineSetup: () => req<LectureEngineSetup>("GET", "/lecture/engine/setup"),
  lectureEngineModel: (id: string, action: "select" | "download" | "remove" = "select") =>
    req<LectureEngineSetup>("POST", "/lecture/engine/model", { id, action }),
  lectureEngineBuild: (id: string, action: "select" | "download" = "select") =>
    req<LectureEngineSetup>("POST", "/lecture/engine/build", { id, action }),
  lectureEngineGpu: (mode: "auto" | "off", deviceId?: number) =>
    req<LectureEngineSetup>("POST", "/lecture/engine/gpu", { mode, deviceId }),
  lectureEngineBin: (path: string) =>
    req<LectureEngineSetup>("POST", "/lecture/engine/bin", { path }),
  lectureEngineCancel: () => req<LectureEngineSetup>("POST", "/lecture/engine/cancel", {}),
  lectureEngineVerify: () => req<LectureEngineSetup>("POST", "/lecture/engine/verify", {}),
  // Скачивания идут через fetch с токеном: <a download> не умеет заголовок
  // x-moonapp-token, поэтому в Electron такие ссылки отдавали 401.
  lectureDownloadExport: async (
    id: number,
    format: "md" | "srt" | "vtt",
    // Подписи говорящих: сервер не знает языка интерфейса, поэтому строки в
    // экспорте подписывает клиент (dual-разметка mic/sys — см. speakerOf).
    labels: { mic?: string; sys?: string; off?: boolean } = {},
  ): Promise<{ blob: Blob; name: string }> => {
    const q = new URLSearchParams({ format });
    if (labels.off) q.set("labels", "off");
    if (labels.mic) q.set("mic", labels.mic);
    if (labels.sys) q.set("sys", labels.sys);
    const res = await fetch(`${BASE}/api/lecture/${id}/export?${q.toString()}`, {
      headers: { ...tokenHeaders() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = filenameFromDisposition(res) || `lecture_${id}.${format}`;
    return { blob: await res.blob(), name };
  },
  lectureDownloadAudio: async (
    id: number,
    track: "mic" | "sys" = "mic",
  ): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(
      `${BASE}/api/lecture/${id}/audio${track === "sys" ? "?track=sys" : ""}`,
      { headers: { ...tokenHeaders() } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { blob: await res.blob(), name: `lecture_${id}${track === "sys" ? "_sys" : ""}.wav` };
  },
  /** WAV отдельного VAD-чанка — для прослушивания фрагмента прямо в ленте. */
  lectureChunkAudio: async (chunkId: number): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/lecture/chunks/${chunkId}/audio`, {
      headers: { ...tokenHeaders() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },
};

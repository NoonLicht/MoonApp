/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { req, multipart, BASE, tokenHeaders } from "@/api/apiHttp";
import type {
  TtsHardware,
  TtsPythonEnv,
  PyInstallState,
  PyInterpreter,
  PyInstallSnapshot,
  PyRemoved,
  TtsPreset,
  TtsProfile,
  TtsBook,
  TtsChunk,
  TtsJob,
} from "@/api/apiTypesMedia";

export const ttsApi = {
  // --- Аудиокнижная TTS-студия (F5-TTS / Coqui XTTS v2) ---
  ttsHardware: () => req<TtsHardware>("GET", "/tts/hardware"),
  // Окружение Python: интерпретатор (voice.pythonCmd) и установленные модули.
  // force=true — перепроверить, минуя серверный кэш (кнопка «Проверить снова»).
  ttsEnv: (force = false) => req<TtsPythonEnv>("GET", `/tts/env${force ? "?force=1" : ""}`),
  // Установка Python-окружения из интерфейса (см. server/ts/pyEnv.ts):
  // план (CUDA/CPU) → установка с прогрессом → отмена. Ручной ввод pip-команд
  // в консоли больше не нужен.
  ttsEnvInstallInfo: (engine: string, device: string) =>
    req<PyInstallState>(
      "GET",
      `/tts/env/install?engine=${encodeURIComponent(engine)}&device=${encodeURIComponent(device)}`,
    ),
  ttsEnvInterpreters: () => req<{ list: PyInterpreter[] }>("GET", "/tts/env/interpreters"),
  ttsEnvInstall: (engine: string, device: string, python?: string) =>
    req<PyInstallSnapshot>("POST", "/tts/env/install", { engine, device, python }),
  ttsEnvCancel: () => req<PyInstallSnapshot>("POST", "/tts/env/cancel", {}),
  // Удаление сборки torch (`pip uninstall -y torch torchvision torchaudio`) — так
  // освобождают ~2.5 ГБ CUDA-сборки, не трогая модели и профили голоса.
  ttsEnvUninstall: (device: string, python?: string) =>
    req<PyInstallSnapshot>("POST", "/tts/env/uninstall", { device, python }),
  // Очистка лога: хвост вывода pip остаётся на экране и после ошибки (там
  // причина), поэтому нужна кнопка «убрать, когда прочитано».
  ttsEnvClearLog: () => req<PyInstallSnapshot>("POST", "/tts/env/log/clear", {}),
  // Портативный Python 3.11 в storage: классический Coqui TTS не ставится на
  // Python 3.12+, а на 3.11 работают оба движка (F5-TTS и Coqui).
  ttsEnvInstallPython: () => req<PyInstallSnapshot>("POST", "/tts/env/python/install", {}),
  ttsEnvRemovePython: () => req<PyRemoved>("POST", "/tts/env/python/remove", {}),
  ttsEnvSetPython: (cmd: string) =>
    req<{ ok: boolean; cmd: string }>("POST", "/tts/env/python", { cmd }),
  ttsPresets: () => req<TtsPreset[]>("GET", "/tts/presets"),
  ttsSavePreset: (p: {
    name: string;
    engine: string;
    params: Record<string, unknown>;
    refFile?: string;
  }) => req<TtsPreset>("POST", "/tts/presets", p),
  ttsDeletePreset: (id: string) => req("DELETE", `/tts/presets/${id}`),
  ttsProfiles: () => req<TtsProfile[]>("GET", "/tts/profiles"),
  ttsSaveProfile: (p: Partial<TtsProfile>) => req<TtsProfile>("POST", "/tts/profiles", p),
  ttsDeleteProfile: (id: string) => req("DELETE", `/tts/profiles/${id}`),
  // Референс грузится отдельным шагом — сервер возвращает имя ref_* файла.
  ttsUploadReference: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return multipart<{ refFile: string; size: number }>("/tts/reference", fd);
  },
  // Универсальный импорт книги: epub/fb2/fb2.zip/pdf/mobi/rtf/txt → главы.
  ttsImportBook: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return multipart<TtsBook>("/tts/import-book", fd);
  },
  // NLP-предпросмотр чанков для Batch Editor (без генерации).
  ttsPreviewChunks: (text: string, engine: string, opts: Record<string, unknown>) =>
    req<{ chunks: TtsChunk[] }>("POST", "/tts/preview-chunks", { text, engine, ...opts }),
  ttsStart: (body: Record<string, unknown>) => req<TtsJob>("POST", "/tts", body),
  ttsStatus: (id: string) => req<TtsJob>("GET", `/tts/${id}`),
  ttsReveal: (path: string) => req<{ ok: boolean }>("POST", "/tts/reveal", { path }),
  ttsDownload: async (id: string): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`${BASE}/api/tts/${id}/download`, { headers: { ...tokenHeaders() } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cd = res.headers.get("content-disposition") || "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    return { blob: await res.blob(), name: m?.[1] ? decodeURIComponent(m[1]) : "audiobook.mp3" };
  },
};

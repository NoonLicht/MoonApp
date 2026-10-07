/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { multipart, req, blobGet } from "@/api/apiHttp";
import type {
  UpJob,
  UpProbe,
  UpEstimate,
  UpHardware,
  UpModelsState,
  UpManifestSync,
  UpTrtBuild,
  UpTrtStatus,
  UpModelInfo,
  UpBenchState,
  UpBenchSingle,
  UpPackState,
  UpPresets,
  UpPreset,
} from "@/api/types";

export const upscaleApi = {
  // --- Апскейл медиа: встроенный ONNX-рантайм, модели качаются по требованию ---
  upscaleStart: (file: File, opts: Record<string, string | number | boolean>) => {
    const fd = new FormData();
    fd.append("file", file);
    for (const [k, v] of Object.entries(opts)) fd.append(k, String(v));
    return multipart<UpJob>("/upscale", fd);
  },
  upscaleStatus: (id: string) => req<UpJob>("GET", `/upscale/${id}`),
  upscaleDelete: (id: string) => req("DELETE", `/upscale/${id}`),
  upscaleReveal: (id: string) => req<{ path: string }>("GET", `/upscale/${id}/reveal`),
  /** Результат как blob: сравнение «до/после» и скачивание (токен в заголовке). */
  upscaleBlob: (id: string, what: "download" | "preview") => blobGet(`/upscale/${id}/${what}`),
  upscaleProbe: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return multipart<UpProbe>("/upscale/probe", fd);
  },
  /**
   * Оценка задания до запуска: размеры, кадры, частота, ожидаемое время.
   * Проба передаётся как есть (она уже получена через /probe) — файл не грузим.
   */
  upscaleEstimate: (params: Record<string, unknown>, probe: UpProbe) =>
    req<UpEstimate>("POST", "/upscale/estimate", { params, probe }),
  upscaleHardware: () => req<UpHardware>("GET", "/upscale/hardware"),
  /**
   * Мягкая остановка задания (кнопка «Стоп» рядом с прогрессом): движок
   * завершается между кадрами, файл результата остаётся на месте.
   */
  upscaleCancel: (id: string) =>
    req<{ ok: boolean; job: UpJob | null }>("POST", `/upscale/${encodeURIComponent(id)}/cancel`),
  /**
   * Пауза всей очереди: текущий файл замирает на том же кадре, следующие не
   * стартуют (задание держит слот очереди), процессы и модели остаются живыми.
   */
  upscalePause: () => req<{ ok: boolean; paused: number; jobs: UpJob[] }>("POST", "/upscale/pause"),
  /** Продолжить очередь с того кадра, где остановились. */
  upscaleResume: () =>
    req<{ ok: boolean; resumed: number; jobs: UpJob[] }>("POST", "/upscale/resume"),
  /** Убрать исходники прошлых задач из storage/upscale/in (выбор нового файла). */
  upscaleCleanInputs: () => req<{ ok: boolean; removed: number }>("POST", "/upscale/inputs/clean"),
  upscaleModels: () => req<UpModelsState>("GET", "/upscale/models"),
  /**
   * «Обновить каталог»: стянуть свежий манифест моделей из GitHub (или свой
   * адрес) — новым моделям обновление приложения не нужно.
   */
  upscaleSyncModels: (url?: string) =>
    req<UpManifestSync>("POST", "/upscale/models/sync", url ? { url } : {}),
  upscaleDownloadModel: (id: string) =>
    req<{ ok: boolean; path: string; sizeMb: number }>("POST", "/upscale/models/download", { id }),
  /** Пере-скачать модель (например, если файл повреждён): force = true. */
  upscaleRedownloadModel: (id: string) =>
    req<{ ok: boolean; path: string; sizeMb: number }>("POST", "/upscale/models/download", {
      id,
      force: true,
    }),
  /** Удалить файл модели с диска (каталог остаётся). */
  upscaleRemoveModel: (id: string) =>
    req<{ ok: boolean; removed: boolean }>("DELETE", `/upscale/models/${encodeURIComponent(id)}`),
  /**
   * Собрать движок TensorRT FP16 для модели (NVIDIA): ONNX Runtime компилирует
   * граф под GPU и кладёт .engine в кэш. Для AMD/Intel/CPU не нужен — там
   * работает обычный ONNX-путь.
   */
  /**
   * Сколько заняла сборка (мс). При повторном клике это уже не сборка, а загрузка
   * готового движка из кэша — отсюда флаг `reused`.
   */
  upscaleBuildTrt: (id: string, tile?: number) =>
    req<UpTrtBuild & { trt?: UpTrtStatus }>(
      "POST",
      `/upscale/models/${encodeURIComponent(id)}/trt`,
      {
        tile: tile || 0,
      },
    ),
  /** «Освободить ONNX»: движок есть, файл модели убираем с диска (докачается сам). */
  upscaleDropOnnx: (id: string) =>
    req<{ ok: boolean; freedMb: number; models: UpModelInfo[] }>(
      "POST",
      `/upscale/models/${encodeURIComponent(id)}/onnx/delete`,
    ),
  /**
   * Замеры скорости моделей: считаются на этой машине (см. UpBenchState), поэтому
   * список свой у каждого пользователя. Панель моделей показывает их в карточках.
   */
  upscaleBench: () => req<UpBenchState>("GET", "/upscale/bench"),
  /** Замерить одну модель: сервер считает один её тайл несколько раз. */
  upscaleBenchModel: (id: string, o: { provider?: string; tile?: number; runs?: number } = {}) =>
    req<UpBenchSingle>("POST", "/upscale/bench", {
      model: id,
      provider: o.provider || "",
      tile: o.tile || 0,
      runs: o.runs || 0,
    }),
  upscaleBenchClear: () => req<UpBenchState>("POST", "/upscale/bench/clear"),
  /**
   * GPU-пак (CUDA/TensorRT): статус, прогресс установки и — по требованию — индекс
   * доступных архивов. Ставится ступенями: первая даёт CUDA, вторая — TensorRT.
   */
  upscalePack: (o: { index?: boolean; url?: string } = {}) => {
    const q = new URLSearchParams();
    if (o.index) q.set("index", "1");
    if (o.url) q.set("url", o.url);
    const qs = q.toString();
    return req<UpPackState>("GET", `/upscale/gpu-pack${qs ? `?${qs}` : ""}`);
  },
  /** Поставить ступень пака: загрузка идёт в фоне, прогресс — через upscalePack. */
  upscalePackInstall: (step: string, o: { url?: string; file?: string; sha256?: string } = {}) =>
    req<{ started: boolean; step: string; file: string; mb: number }>(
      "POST",
      "/upscale/gpu-pack/install",
      {
        step,
        ...o,
      },
    ),
  /** Отменить установку: недокачанный архив убирается автоматически. */
  upscalePackCancel: () => req<{ ok: boolean }>("POST", "/upscale/gpu-pack/cancel"),
  /** Удалить пак (рантайм вернётся к DirectML/CPU); занятые файлы отпустит перезапуск. */
  upscalePackRemove: () => req<{ ok: boolean; mb: number }>("DELETE", "/upscale/gpu-pack"),
  upscalePresets: () => req<UpPresets>("GET", "/upscale/presets"),
  upscaleSavePreset: (p: { name: string } & Record<string, unknown>) =>
    req<{ ok: boolean; custom: UpPreset[] }>("POST", "/upscale/presets", p),
  upscaleDeletePreset: (name: string) =>
    req<{ ok: boolean }>("DELETE", `/upscale/presets/${encodeURIComponent(name)}`),
};

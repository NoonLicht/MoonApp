import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Cpu,
  Download,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Glass, Btn, Badge, SectionHead } from "@/components/ui";
import { usePageActive, usePageBusy } from "@/components/Toolbar";
import { useI18n } from "@/app/i18n";
import { useContextMenu, copyToClipboard } from "@/components/ContextMenu";
import { api } from "@/api/client";
import type {
  UpBenchState,
  UpEstimate,
  UpHardware,
  UpJob,
  UpModelInfo,
  UpModelsState,
  UpPackState,
  UpParams,
  UpPreset,
  UpProbe,
} from "@/api/types";
import { saveBlob } from "@/lib/download";
import CompareSlider from "@/components/upscale/CompareSlider";
import UpscaleDashboard from "@/pages/upscale/parts/UpscaleDashboard";
import UpscaleBatchList, { type BatchItem } from "@/pages/upscale/parts/UpscaleBatchList";
import UpscaleModelsPanel from "@/pages/upscale/parts/UpscaleModelsPanel";
import { fmtTime } from "@/pages/upscale/parts/formatTime";
import { fileKind } from "@/pages/upscale/parts/fileKind";

/**
 * Страница «Апскейл фото и видео» на встроенном ONNX-рантайме.
 *
 * Раскладка и поведение повторяют страницу сжатия видео: слева — исходник
 * (dropzone → плеер/картинка → результат «до/после» с действиями), справа — одна
 * карточка настроек (`.up-card.up-fill`), которая прокручивается сама. Внутри:
 * пресеты своего типа медиа, переключатель Express/Pro, поля (у фото и видео
 * разные), оценка будущего задания и кнопка запуска.
 *
 * Тип медиа определяется по расширению файла сразу при выборе, поэтому
 * предпросмотр показывает <video> для видео и <img> для картинки, не дожидаясь
 * ответа /probe (раньше видео успевало отрисоваться как картинка).
 */
type Params = UpParams;

const DEFAULT_PARAMS: Params = {
  model: "realesr-general-x4v3",
  model2: "",
  blendAmount: 0,
  scale: 4,
  targetW: 0,
  targetH: 0,
  tile: 0,
  overlap: 16,
  threads: 0,
  provider: "auto",
  format: "png",
  quality: 100,
  sharpen: 0,
  denoise: 0,
  vcodec: "x264",
  vcrf: 20,
  audioAction: "copy",
  presetId: "",
  interpMode: "off",
  interpModel: "",
  interpMult: 2,
  minterpolateMode: "mci",
  minterpolateSide: "decode",
  sceneCutThreshold: 12,
  // Пачка кадров: 0 — «Авто» — движок сам подбирает размер по свободной
  // видеопамяти (максимум скорости без риска нехватки памяти).
  batchFrames: 0,
  // Пачка ТАЙЛОВ интерполятора: 0 — «Авто» (движок берёт 4 тайла, если граф
  // принимает пачку; у моделей с фиксированным batch — по тайлу за раз).
  interpBatch: 0,
  frameLimit: 0,
  // Видеокарта включена по умолчанию: аппаратные кодировщик/декодер берутся,
  // только если сборка ffmpeg их умеет, иначе всё тихо считает CPU.
  hwAccel: true,
  slowMotion: 1,
};

const fmtMB = (b?: number | null) => (!b && b !== 0 ? "—" : `${(b / 1024 / 1024).toFixed(1)} MB`);

export default function UpscalePage() {
  const { t } = useI18n();
  const isActive = usePageActive();
  const menu = useContextMenu();

  const [file, setFile] = useState<File | null>(null);
  /**
   * Пакетный режим: несколько файлов за раз. Работает вместо одиночного
   * (`file`/`job`), потому что набор параметров общий, а прогресс — по каждому.
   */
  const [batch, setBatch] = useState<BatchItem[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [probe, setProbe] = useState<UpProbe | null>(null);
  const [hw, setHw] = useState<UpHardware | null>(null);
  /** Запрос к API упал (404/сеть) — это НЕ «нет рантайма», показываем отдельно. */
  const [apiDown, setApiDown] = useState(false);
  const [presets, setPresets] = useState<{ system: UpPreset[]; custom: UpPreset[] }>({
    system: [],
    custom: [],
  });
  const [p, setP] = useState<Params>(DEFAULT_PARAMS);
  const [mode, setMode] = useState<"express" | "pro">("express");
  const [job, setJob] = useState<UpJob | null>(null);
  const [jobId, setJobId] = useState<string>("");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [defect, setDefect] = useState("");
  const [saveModal, setSaveModal] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [modelBusy, setModelBusy] = useState("");
  /** Сборка движка TensorRT для модели (может идти минутами). */
  const [trtBusy, setTrtBusy] = useState("");
  /** Ответ сервера на последнюю сборку движка: «собран» / «уже был в кэше». */
  const [trtNote, setTrtNote] = useState("");
  /** «Пересобрать все модели»: прогресс серии сборок (null — серия не идёт). */
  const [trtProgress, setTrtProgress] = useState<{ done: number; total: number } | null>(null);
  const [modelsState, setModelsState] = useState<UpModelsState | null>(null);
  /**
   * Замеры скорости моделей: считаются на этой машине (видеокарта, драйвер,
   * собранный движок) и лежат в storage — у каждого пользователя свои цифры.
   * Показываются в окне каталога моделей, в селекторе их нет.
   */
  const [bench, setBench] = useState<UpBenchState | null>(null);
  /** Ид модели, которая замеряется сейчас ("" — ничего не идёт). */
  const [benchBusy, setBenchBusy] = useState("");
  /** Серия «Замерить все модели»: сколько прошло (null — серия не идёт). */
  const [benchProgress, setBenchProgress] = useState<{ done: number; total: number } | null>(null);
  /** Просьба прервать серию (текущая модель досчитывается, дальше — стоп). */
  const benchStop = useRef(false);
  /** GPU-пак: что установлено, прогресс установки и (по запросу) индекс сборок. */
  const [pack, setPack] = useState<UpPackState | null>(null);
  /** Идёт обновление каталога моделей из GitHub (кнопка в панели моделей). */
  const [manifestBusy, setManifestBusy] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  /** Запрос на мягкую остановку отправлен — кнопка «Стоп» заблокирована. */
  const [stopping, setStopping] = useState(false);
  /** Запрос паузы/продолжения отправлен — кнопка у полосы прогресса ждёт ответа. */
  const [pausing, setPausing] = useState(false);
  /**
   * Пакетная операция с файлами моделей («Скачать все» / «Удалить все»): сервер
   * качает и удаляет по одному файлу, поэтому идём последовательно и показываем
   * прогресс «{done} из {total}» — иначе кнопка выглядит зависшей на 20 файлах.
   */
  const [bulkModels, setBulkModels] = useState<{
    kind: "down" | "del";
    done: number;
    total: number;
  } | null>(null);
  const [estimate, setEstimate] = useState<UpEstimate | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  // Актуальный список партии читают таймер и обработчики — без перезапуска опроса.
  const batchRef = useRef<BatchItem[]>([]);
  batchRef.current = batch;

  /**
   * Железо/рантайм. Важно различать два отказа: сервер не ответил (роут не
   * подключён, сервер не запущен) и сервер ответил «рантайма нет». Раньше оба
   * случая показывались как «установите onnxruntime-node» — это сбивало с толку.
   */
  const loadHardware = useCallback(async () => {
    try {
      setHw(await api.upscaleHardware());
      setApiDown(false);
    } catch {
      setHw(null);
      setApiDown(true);
    }
  }, []);

  // --- Железо/каталог моделей и пресеты: один раз при входе на страницу ---
  useEffect(() => {
    void loadHardware();
    api
      .upscalePresets()
      .then((r) => setPresets({ system: r.system || [], custom: r.custom || [] }))
      .catch(() => {
        /* без пресетов страница работоспособна */
      });
  }, [loadHardware]);

  // Каталог моделей: обновляем при входе и пока идёт скачивание (прогресс в UI).
  const loadModels = useCallback(async () => {
    try {
      setModelsState(await api.upscaleModels());
    } catch {
      setModelsState(null);
    }
  }, []);
  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  /** Замеры читаем один раз при входе: они меняются только по кнопкам в каталоге. */
  const loadBench = useCallback(async () => {
    try {
      setBench(await api.upscaleBench());
    } catch {
      setBench(null);
    }
  }, []);
  useEffect(() => {
    void loadBench();
  }, [loadBench]);

  /**
   * GPU-пак: без индекса это просто «что установлено», с индексом — ещё и список
   * доступных сборок. В сеть без просьбы пользователя не ходим: индекс тянется
   * кнопкой «Проверить сборки».
   */
  const loadPack = useCallback(async (withIndex = false) => {
    try {
      setPack(await api.upscalePack({ index: withIndex }));
    } catch {
      setPack(null);
    }
  }, []);
  useEffect(() => {
    void loadPack();
  }, [loadPack]);
  // Пока ступень ставится (скачивание + распаковка) — опрашиваем прогресс.
  useEffect(() => {
    if (!pack?.busy) return undefined;
    const timer = window.setInterval(() => void loadPack(), 1200);
    return () => window.clearInterval(timer);
  }, [pack?.busy, loadPack]);
  const downloading = useMemo(
    () => (modelsState?.models || []).some((m) => m.downloading),
    [modelsState],
  );
  useEffect(() => {
    if (!downloading) return undefined;
    const timer = window.setInterval(() => void loadModels(), 900);
    return () => window.clearInterval(timer);
  }, [downloading, loadModels]);

  // Объект-URL оригинала: освобождаем при смене файла и уходе со страницы.
  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Опрос задания: только пока страница видима, ровно один таймер.
  useEffect(() => {
    if (!jobId || !isActive) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const j = await api.upscaleStatus(jobId);
        if (stop) return;
        setJob(j);
        if (j.done || j.stage === "error" || j.stage === "stopped") {
          stop = true;
          window.clearInterval(timer);
        }
      } catch {
        /* задание могли удалить из другого места */
      }
    };
    const timer = window.setInterval(tick, 1000);
    void tick();
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [jobId, isActive]);

  // Готовый результат тянем blob'ом (токен в заголовке) и держим объект-URL.
  useEffect(() => {
    if (!jobId || !job?.done) return undefined;
    let url = "";
    let cancelled = false;
    api
      .upscaleBlob(jobId, "preview")
      .then((b) => {
        if (cancelled) return;
        url = URL.createObjectURL(b);
        setResultUrl(url);
      })
      .catch(() => {
        /* результат мог исчезнуть по TTL */
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [jobId, job?.done]);

  // Оценка будущего задания: пересчитываем на смену параметров с небольшой
  // задержкой (поля меняются чаще, чем приходит ответ) и с защитой от гонок.
  useEffect(() => {
    if (!probe || !probe.width) {
      setEstimate(null);
      return undefined;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .upscaleEstimate(p as unknown as Record<string, unknown>, probe)
        .then((e) => {
          if (alive) setEstimate(e);
        })
        .catch(() => {
          if (alive) setEstimate(null);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [probe, p]);

  usePageBusy(
    (!!job && !job.done && job.stage !== "error") ||
      batch.some(
        (x) => x.jobId && x.stage !== "done" && x.stage !== "error" && x.stage !== "stopped",
      ),
  );

  /** Партия считается активной, пока есть не закончившие задания. */
  const batchBusy = batch.some(
    (x) => x.jobId && x.stage !== "done" && x.stage !== "error" && x.stage !== "stopped",
  );

  // Опрос партии: один таймер на все задания, только пока страница видима.
  useEffect(() => {
    if (!batchBusy || !isActive) return undefined;
    let stop = false;
    const tick = async () => {
      const ids = batchRef.current.filter((x) => x.jobId).map((x) => x.jobId);
      if (!ids.length) return;
      const res = await Promise.all(ids.map((id) => api.upscaleStatus(id).catch(() => null)));
      if (stop) return;
      const byId = new Map<string, UpJob>();
      for (const j of res) if (j) byId.set(j.id, j);
      setBatch((prev) =>
        prev.map((x) => {
          const j = byId.get(x.jobId);
          if (!j) return x;
          const stage = j.done ? "done" : j.stage === "error" ? "error" : j.stage;
          return {
            ...x,
            stage,
            progress: j.progress,
            error: j.error,
            outSize: j.outSize,
            outExt: j.outExt || x.outExt,
            paused: !!j.paused,
          };
        }),
      );
    };
    const timer = window.setInterval(() => void tick(), 1000);
    void tick();
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [batchBusy, isActive]);

  const busy = !!job && !job.done && job.stage !== "error" && job.stage !== "stopped";
  // Тип медиа: по файлу сразу, проба только уточняет.
  const kind: "photo" | "video" = probe?.kind || (file ? fileKind(file.name) : "photo");
  const isVideo = kind === "video";
  const models = useMemo(() => hw?.models || [], [hw]);
  const aspect = probe && probe.width > 0 ? probe.width / probe.height : 16 / 9;
  const done = !!job?.done;
  const savedPct =
    done && job?.size && job.outSize ? Math.round(100 - (100 * job.outSize) / job.size) : null;

  const pick = useCallback(async (f: File | null) => {
    setFile(f);
    setProbe(null);
    setDefect("");
    // Новый файл (или сброс) закрывает прошлое задание: результат на сервере
    // живёт до TTL, а страница показывает только текущее медиа.
    setJob(null);
    setJobId("");
    setResultUrl(null);
    // Пользователь выбрал следующий файл — исходники прошлых задач в
    // storage/upscale/in больше не нужны (видео там занимают гигабайты).
    void api.upscaleCleanInputs().catch(() => {});
    if (!f) return;
    try {
      setProbe(await api.upscaleProbe(f));
    } catch (e) {
      setDefect(String((e as Error).message || e));
    }
  }, []);

  /**
   * Мягкая остановка задания («Стоп» у полосы прогресса): движок завершается
   * между кадрами, частичный результат и файл на диске остаются.
   */
  const cancelRun = async (id: string) => {
    if (!id) return;
    setStopping(true);
    try {
      const r = await api.upscaleCancel(id);
      if (r.job) setJob(r.job);
    } catch (e) {
      setDefect(String((e as Error).message || e));
    } finally {
      setStopping(false);
    }
  };

  /**
   * Пауза/продолжение всей очереди: текущее задание замирает на том же кадре
   * (процессы и модели живы), следующие файлы не стартуют. Состояние приходит с
   * сервера, поэтому UI не угадывает: показываем то, что реально стоит.
   */
  const togglePause = async (next: boolean) => {
    setPausing(true);
    try {
      const r = next ? await api.upscalePause() : await api.upscaleResume();
      const list = Array.isArray(r.jobs) ? r.jobs : [];
      // Состояние — из ответа сервера: «Пауза» задевает всю очередь, поэтому
      // обновляем и текущее задание, и карточки пакетного списка.
      const byId = new Map(list.map((x) => [x.id, x]));
      const mine = byId.get(jobId);
      if (mine) setJob(mine);
      setBatch((prev) =>
        prev.map((x) => {
          const fresh = x.jobId ? byId.get(x.jobId) : undefined;
          return fresh ? { ...x, paused: !!fresh.paused, stage: fresh.stage } : x;
        }),
      );
    } catch (e) {
      setDefect(String((e as Error).message || e));
    } finally {
      setPausing(false);
    }
  };

  const start = async () => {
    if (!file) return;
    setDefect("");
    try {
      const payload: Record<string, string | number | boolean> = { ...p };
      const j = await api.upscaleStart(file, payload);
      setJob(j);
      setJobId(j.id);
    } catch (e) {
      setDefect(String((e as Error).message || e));
    }
  };

  // ---------------- Пакетный режим: много файлов за раз ----------------

  /** Выбор файлов: один — обычный режим, несколько — пакет. */
  const pickMany = useCallback(
    (list: File[]) => {
      if (list.length <= 1) {
        setBatch([]);
        void pick(list[0] || null);
        return;
      }
      // Одиночное состояние сбрасываем: панель результата и пакет не смешиваются.
      setFile(null);
      setProbe(null);
      setJob(null);
      setJobId("");
      setResultUrl(null);
      setDefect("");
      setBatch(
        list.map((f) => ({
          key: `${f.name}|${f.size}|${f.lastModified}`,
          file: f,
          jobId: "",
          stage: "pending",
          progress: 0,
          error: "",
          outSize: 0,
          outExt: "",
        })),
      );
    },
    [pick],
  );

  /** Запуск партии: файлы уходят в очередь движка по одному (она последовательная). */
  const runBatch = async () => {
    const items = batchRef.current;
    if (!items.length) return;
    setDefect("");
    const payload: Record<string, string | number | boolean> = { ...p };
    for (const it of items) {
      if (it.jobId) continue; // уже поставлено в очередь
      try {
        const j = await api.upscaleStart(it.file, payload);
        setBatch((prev) =>
          prev.map((x) => (x.key === it.key ? { ...x, jobId: j.id, stage: j.stage } : x)),
        );
      } catch (e) {
        setBatch((prev) =>
          prev.map((x) =>
            x.key === it.key
              ? { ...x, stage: "error", error: String((e as Error).message || e) }
              : x,
          ),
        );
      }
    }
  };

  const clearBatch = () => {
    for (const it of batchRef.current) {
      if (it.jobId) api.upscaleDelete(it.jobId).catch(() => {});
    }
    setBatch([]);
    setDefect("");
  };

  const downloadBatch = async (it: BatchItem) => {
    try {
      const b = await api.upscaleBlob(it.jobId, "download");
      const stem = it.file.name.replace(/\.[^.]+$/, "");
      saveBlob(b, `${stem}_upscaled.${it.outExt || "png"}`);
    } catch (e) {
      setDefect(String((e as Error).message || e));
    }
  };

  const downloadBatchAll = async () => {
    for (const it of batchRef.current) {
      if (it.stage === "done") await downloadBatch(it);
    }
  };

  const revealBatch = (it: BatchItem) => {
    api.upscaleReveal(it.jobId).catch(() => {});
  };

  const reset = () => {
    if (jobId && !busy) api.upscaleDelete(jobId).catch(() => {});
    // Партия тоже снимается: кнопка «Выбрать другое» должна очищать всё.
    for (const it of batchRef.current) {
      if (it.jobId) api.upscaleDelete(it.jobId).catch(() => {});
    }
    setBatch([]);
    setJob(null);
    setJobId("");
    setResultUrl(null);
    setFile(null);
    setProbe(null);
    setEstimate(null);
    setDefect("");
  };

  /** Пресет: системные держат поля на верхнем уровне, пользовательские — в params. */
  const applyPreset = (pr: UpPreset) => {
    const q = (pr as { params?: Record<string, unknown> }).params || pr;
    setP((prev) => ({
      ...prev,
      model: String(q.model ?? prev.model),
      scale: Number(q.scale ?? prev.scale),
      format: String(q.format ?? prev.format),
      quality: Number(q.quality ?? prev.quality),
      tile: Number(q.tile ?? prev.tile),
      overlap: Number(q.overlap ?? prev.overlap),
      sharpen: Number(q.sharpen ?? prev.sharpen),
      denoise: Number(q.denoise ?? prev.denoise),
      provider: String(q.provider ?? prev.provider),
      targetW: Number(q.targetW ?? prev.targetW),
      targetH: Number(q.targetH ?? prev.targetH),
      vcodec: String(q.vcodec ?? prev.vcodec),
      vcrf: Number(q.vcrf ?? prev.vcrf),
      audioAction: String(q.audioAction ?? prev.audioAction),
      // Пресет может не содержать полей плавности (в фото-пресетах их нет):
      // тогда возвращаем значения по умолчанию, а не «что было».
      interpMode: String(q.interpMode ?? "off"),
      interpModel: String(q.interpModel ?? prev.interpModel),
      interpMult: Number(q.interpMult ?? prev.interpMult),
      minterpolateMode: String(q.minterpolateMode ?? prev.minterpolateMode),
      minterpolateSide: String(q.minterpolateSide ?? prev.minterpolateSide),
      sceneCutThreshold: Number(q.sceneCutThreshold ?? prev.sceneCutThreshold),
      batchFrames: Number(q.batchFrames ?? prev.batchFrames),
      interpBatch: Number(q.interpBatch ?? prev.interpBatch),
      frameLimit: Number(q.frameLimit ?? 0),
      slowMotion: Number(q.slowMotion ?? 1),
      presetId: pr.id || "",
    }));
  };

  /**
   * «Скачать все»: файлы всех моделей каталога, которых ещё нет на диске.
   *
   * Последовательно, а не Promise.all: сервер отдаёт прогресс по каждому файлу,
   * а двадцать параллельных загрузок по несколько сотен мегабайт забили бы канал.
   * Возвращаем текст ошибки ("" — всё скачалось) для баннера в панели моделей.
   */
  const downloadAllModels = async (): Promise<string> => {
    const pending = models.filter((m) => !m.available && !!m.url);
    if (!pending.length) return "";
    setBulkModels({ kind: "down", done: 0, total: pending.length });
    let firstError = "";
    for (let i = 0; i < pending.length; i++) {
      try {
        await api.upscaleDownloadModel(pending[i].id);
      } catch (e) {
        if (!firstError) firstError = String((e as Error).message || e);
      }
      setBulkModels({ kind: "down", done: i + 1, total: pending.length });
    }
    setBulkModels(null);
    // Список моделей живёт в состоянии железа (available/url) — обновляем и его,
    // иначе галочки «скачано» останутся старыми до перезапуска страницы.
    await Promise.all([
      loadModels(),
      api
        .upscaleHardware()
        .then(setHw)
        .catch(() => {}),
    ]);
    if (!firstError) setDefect("");
    return firstError;
  };

  /**
   * «Удалить все»: файлы всех скачанных моделей уходят с диска (каталог остаётся,
   * модели снова можно скачать). Подтверждение спрашивает панель.
   *
   * Модель, выбранную в текущих настройках, не трогаем — в карточке каталога её
   * кнопка «Удалить» тоже заблокирована: иначе задача упадёт с model_missing.
   */
  const removeAllModels = async (): Promise<string> => {
    const ready = models.filter((m) => m.available && m.id !== p.model && m.id !== p.interpModel);
    if (!ready.length) return "";
    setBulkModels({ kind: "del", done: 0, total: ready.length });
    let firstError = "";
    for (let i = 0; i < ready.length; i++) {
      try {
        await api.upscaleRemoveModel(ready[i].id);
      } catch (e) {
        if (!firstError) firstError = String((e as Error).message || e);
      }
      setBulkModels({ kind: "del", done: i + 1, total: ready.length });
    }
    setBulkModels(null);
    await Promise.all([
      loadModels(),
      api
        .upscaleHardware()
        .then(setHw)
        .catch(() => {}),
    ]);
    return firstError;
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    try {
      // Тип медиа уходит в пресет: списки пресетов у фото и видео раздельные.
      const r = await api.upscaleSavePreset({ name, ...p, kind });
      setPresets((prev) => ({ ...prev, custom: r.custom }));
      setSaveModal(false);
      setPresetName("");
    } catch {
      /* не сохранилось — молча */
    }
  };

  const deletePreset = async (name: string) => {
    try {
      await api.upscaleDeletePreset(name);
      setPresets((prev) => ({ ...prev, custom: prev.custom.filter((x) => x.name !== name) }));
    } catch {
      /* ignore */
    }
  };

  const downloadModel = async (id: string, force = false) => {
    setModelBusy(id);
    try {
      if (force) await api.upscaleRedownloadModel(id);
      else await api.upscaleDownloadModel(id);
      setDefect("");
      await Promise.all([
        loadModels(),
        api
          .upscaleHardware()
          .then(setHw)
          .catch(() => {}),
      ]);
    } catch (e) {
      setDefect(String((e as Error).message || e));
    } finally {
      setModelBusy("");
    }
  };

  /**
   * «Собрать движок TensorRT FP16»: TRT компилирует ONNX под GPU и кэширует
   * движок на диске — дальше он грузится мгновенно. Может занять минуты, поэтому
   * держим отдельный trtBusy и не блокируем остальную панель.
   */
  const buildTrt = async (id: string, tile?: number) => {
    setTrtBusy(id);
    try {
      const r = await api.upscaleBuildTrt(id, tile);
      setDefect("");
      // Сервер различает «собрал движок» и «движок уже был в кэше»: без этой
      // строки повторный клик выглядел как «ничего не произошло».
      const sec = (r.ms / 1000).toFixed(1);
      setTrtNote(
        r.reused
          ? t("up.mdlTrtReused", { sec, file: r.engine || "—" })
          : t("up.mdlTrtBuilt", { sec, file: r.engine || "—", size: String(r.engineMb) }),
      );
      await Promise.all([
        loadModels(),
        api
          .upscaleHardware()
          .then(setHw)
          .catch(() => {}),
      ]);
    } catch (e) {
      setDefect(String((e as Error).message || e));
    } finally {
      setTrtBusy("");
    }
  };

  const buildTrtAll = async () => {
    const targets = (modelsState?.models || []).filter((m) => m.kind !== "interp" && m.available);
    if (!targets.length) return;
    setTrtProgress({ done: 0, total: targets.length });
    let built = 0;
    let freed = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const m = targets[i];
        setTrtBusy(m.id);
        try {
          const r = await api.upscaleBuildTrt(m.id, m.rec.tile);
          if (!r.reused) built++;
          freed += r.onnxFreedMb || 0;
        } catch (e) {
          // Одна модель не собралась — серию не бросаем, покажем причину в конце.
          setDefect(`${m.label}: ${String((e as Error).message || e)}`);
        }
        setTrtProgress({ done: i + 1, total: targets.length });
      }
      setTrtNote(
        t("up.mdlTrtAllDone", {
          total: targets.length,
          built,
          mb: freed,
        }),
      );
      await Promise.all([
        loadModels(),
        api
          .upscaleHardware()
          .then(setHw)
          .catch(() => {}),
      ]);
    } finally {
      setTrtBusy("");
      setTrtProgress(null);
    }
  };

  /**
   * «Замер» модели: сервер считает один её тайл несколько раз и сохраняет лучшее
   * время. Цифры у каждой машины свои — видеокарта, драйвер, собранный движок,
   * поэтому они и лежат локально, а в каталоге видны строкой в карточке.
   */
  const benchModel = async (id: string) => {
    setBenchBusy(id);
    try {
      const r = await api.upscaleBenchModel(id);
      setDefect("");
      setBench({ results: r.results, frame: r.frame, runs: r.runs });
    } catch (e) {
      setDefect(String((e as Error).message || e));
    } finally {
      setBenchBusy("");
    }
  };

  /**
   * «Замерить все модели»: по одной, с прогрессом — как серия сборок движков.
   * Порядок и кнопка «Остановить» те же: серия не должна занимать GPU навсегда.
   */
  const benchAll = async () => {
    const targets = (modelsState?.models || []).filter(
      (m) => m.kind !== "interp" && (m.available || m.trtEngine),
    );
    if (!targets.length) return;
    benchStop.current = false;
    setBenchProgress({ done: 0, total: targets.length });
    try {
      for (let i = 0; i < targets.length; i++) {
        if (benchStop.current) break;
        const m = targets[i];
        setBenchBusy(m.id);
        try {
          const r = await api.upscaleBenchModel(m.id, { tile: m.rec.tile });
          setBench({ results: r.results, frame: r.frame, runs: r.runs });
        } catch (e) {
          // Одна модель не замерилась — серию не бросаем, причину покажем.
          setDefect(`${m.label}: ${String((e as Error).message || e)}`);
        }
        setBenchProgress({ done: i + 1, total: targets.length });
      }
    } finally {
      setBenchBusy("");
      setBenchProgress(null);
    }
  };

  /** «Забыть замеры»: файл замеров удаляется целиком (сменилось железо). */
  const benchClear = async () => {
    try {
      const r = await api.upscaleBenchClear();
      setBench({ results: r.results, frame: r.frame, runs: r.runs });
    } catch (e) {
      setDefect(String((e as Error).message || e));
    }
  };

  /** «Освободить ONNX»: движок на месте, файл графа убираем (докачается сам). */
  const dropOnnx = async (id: string) => {
    setTrtBusy(id);
    try {
      const r = await api.upscaleDropOnnx(id);
      setDefect("");
      setTrtNote(t("up.mdlOnnxDroppedNote", { mb: r.freedMb }));
      if (r.models) setModelsState((prev) => (prev ? { ...prev, models: r.models } : prev));
    } catch (e) {
      setDefect(String((e as Error).message || e));
    } finally {
      setTrtBusy("");
    }
  };

  const removeModel = async (id: string) => {
    setModelBusy(id);
    try {
      await api.upscaleRemoveModel(id);
      await Promise.all([
        loadModels(),
        api
          .upscaleHardware()
          .then(setHw)
          .catch(() => {}),
      ]);
    } catch (e) {
      setDefect(String((e as Error).message || e));
    } finally {
      setModelBusy("");
    }
  };

  /**
   * GPU-пак: поставить ступень (cuda или tensorrt). Загрузка идёт на сервере в
   * фоне (архив до 1,5 ГБ), поэтому здесь только запуск и перечитывание статуса —
   * прогресс приходит опросом, пока `busy` не опустеет.
   */
  const packInstall = async (step: string, src: { file?: string; url?: string } = {}) => {
    setDefect("");
    try {
      await api.upscalePackInstall(step, src);
      await loadPack();
    } catch (e) {
      setDefect(String((e as Error).message || e));
    }
  };

  /** Отмена установки: недокачанный архив убирает загрузчик. */
  const packCancel = async () => {
    try {
      await api.upscalePackCancel();
      await loadPack();
    } catch (e) {
      setDefect(String((e as Error).message || e));
    }
  };

  /** Удалить пак с диска: диск освобождается, рантайм вернётся к DirectML/CPU. */
  const packRemove = async () => {
    try {
      await api.upscalePackRemove();
      await Promise.all([loadPack(), loadHardware()]);
    } catch (e) {
      setDefect(String((e as Error).message || e));
    }
  };

  /**
   * «Обновить каталог»: тянем манифест моделей из GitHub и сразу перечитываем
   * список — новая модель появляется без обновления приложения. Возвращаем
   * текст ошибки для баннера в панели ("" — всё хорошо).
   */
  const syncModels = async (): Promise<string> => {
    setManifestBusy(true);
    try {
      const r = await api.upscaleSyncModels();
      await Promise.all([
        loadModels(),
        api
          .upscaleHardware()
          .then(setHw)
          .catch(() => {}),
      ]);
      // Что именно изменилось, пишем в лог приложения (server), а в панели
      // пользователь видит новый список моделей и дату обновления каталога.
      void r;
      return "";
    } catch (e) {
      return String((e as Error).message || e);
    } finally {
      setManifestBusy(false);
    }
  };

  /**
   * «Применить» в панели моделей: подставляем настройки, оптимальные именно для
   * этой модели (rec из манифеста) — тайл, перекрытие, резкость, шум. У
   * интерполятора вместо тайлинга включаем плавность моделью.
   */
  const applyModel = (m: UpModelInfo) => {
    if (m.kind === "interp") {
      setP((prev) => ({
        ...prev,
        interpMode: "model",
        interpModel: m.id,
        interpMult: m.rec.interpMult ?? m.mult ?? 2,
        sceneCutThreshold: m.rec.sceneCut ?? prev.sceneCutThreshold,
        presetId: "",
      }));
      return;
    }
    setP((prev) => ({
      ...prev,
      model: m.id,
      scale: m.rec.scale ?? m.scale ?? prev.scale,
      tile: m.rec.tile ?? prev.tile,
      overlap: m.rec.overlap ?? prev.overlap,
      sharpen: m.rec.sharpen ?? 0,
      denoise: m.rec.denoise ?? 0,
      presetId: "",
    }));
  };

  /** Папка моделей: в Electron открываем проводник (IPC shell), иначе путь в буфер. */
  const openModelsDir = async () => {
    const dir = modelsState?.dir || "";
    if (!dir) return;
    const br = (window as unknown as { appBridge?: { revealPath?: (p: string) => void } })
      .appBridge;
    if (br?.revealPath) br.revealPath(dir);
    else copyToClipboard(dir);
  };

  const reveal = async (id: string) => {
    try {
      const { path } = await api.upscaleReveal(id);
      const br = (window as unknown as { appBridge?: { revealPath?: (p: string) => void } })
        .appBridge;
      if (br?.revealPath) br.revealPath(path);
      else copyToClipboard(path); // вне Electron — хотя бы путь в буфер
    } catch {
      /* не готово */
    }
  };

  const download = async (id: string, j: UpJob) => {
    try {
      const b = await api.upscaleBlob(id, "download");
      const stem = (j.name || "media").replace(/\.[^.]+$/, "");
      saveBlob(b, `${stem}_upscaled.${j.outExt || "bin"}`);
    } catch (e) {
      setDefect(String((e as Error).message || e));
    }
  };

  const resultBadges = (
    <div className="up-badges">
      <Badge tone="violet" mono>
        {job?.model || p.model}
      </Badge>
      {job?.outWidth && job?.outHeight ? (
        <Badge tone="neutral">
          {job.outWidth}×{job.outHeight}
        </Badge>
      ) : null}
      <Badge tone="neutral">{fmtMB(job?.outSize)}</Badge>
      {job?.fpsOut && job.info?.fps && job.fpsOut !== job.info.fps ? (
        <Badge tone="teal">{Number(job.fpsOut).toFixed(2)} fps</Badge>
      ) : null}
      {job?.slowMotion && job.slowMotion < 1 ? (
        <Badge tone="coral">{`${job.slowMotion}×`}</Badge>
      ) : null}
      {job?.providerUsed ? <Badge tone="teal">{job.providerUsed}</Badge> : null}
      {job?.encoderUsed ? (
        <Badge tone="violet" mono>
          {job.encoderUsed}
        </Badge>
      ) : null}
      {savedPct != null ? (
        savedPct >= 0 ? (
          <Badge tone="teal">−{savedPct}%</Badge>
        ) : (
          <Badge tone="coral">+{Math.abs(savedPct)}%</Badge>
        )
      ) : null}
    </div>
  );

  return (
    <div className="page up-page">
      <SectionHead eyebrow={t("up.eyebrow")} title={t("up.title")} />

      <div className="up-grid">
        {/* --- Левая колонка: исходник и результат --- */}
        <div className="up-left">
          {!file && batch.length === 0 && (
            <div
              className="dropzone"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pickMany(Array.from(e.dataTransfer.files || []));
              }}
              onContextMenu={(e) =>
                menu.open(e, [
                  {
                    label: t("up.choose"),
                    icon: Upload,
                    onClick: () => fileInput.current?.click(),
                  },
                ])
              }
            >
              <Sparkles size={28} strokeWidth={1.5} />
              <div>{t("up.drop")}</div>
              <span className="muted-sm">{t("up.dropHint")}</span>
            </div>
          )}

          {/* Выбор файлов: один — обычный режим, несколько — пакетный. Поле живёт
              на верхнем уровне, а не внутри dropzone: иначе кнопка «Добавить» в
              пакете не смогла бы его открыть. */}
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept="image/*,video/*"
            onChange={(e) => {
              pickMany(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />

          {batch.length > 0 && (
            <UpscaleBatchList
              items={batch}
              busy={batchBusy}
              onAdd={() => fileInput.current?.click()}
              onRun={() => void runBatch()}
              onClear={clearBatch}
              onDownload={(it) => void downloadBatch(it)}
              onDownloadAll={() => void downloadBatchAll()}
              onReveal={revealBatch}
              onCancel={(id) => void cancelRun(id)}
            />
          )}

          {/* Исходник: видео — плеером, картинка — изображением. Тип берём по
              расширению файла, а не из пробы: проба приходит позже, и «video в
              теге img» не показывался вовсе. */}
          {file && !done && (
            <Glass
              className="up-card"
              style={{ flexDirection: "column", gap: 8 }}
              onContextMenu={(e) =>
                menu.open(e, [
                  {
                    label: t("ctx.copyName"),
                    icon: Copy,
                    onClick: () => copyToClipboard(file.name),
                  },
                  { label: t("up.rechoose"), icon: X, onClick: () => void pick(null) },
                ])
              }
            >
              {previewUrl &&
                (isVideo ? (
                  <div className="up-player-wrap">
                    <video
                      src={previewUrl}
                      controls
                      style={{ ["--up-ar" as string]: aspect, ["--up-max-h" as string]: "52vh" }}
                    />
                  </div>
                ) : (
                  <img className="up-preview" src={previewUrl} alt={file.name} />
                ))}
              <div className="media-title up-ellipsis">{file.name}</div>
              <div className="up-badges">
                {probe?.codec ? (
                  <Badge tone="violet" mono>
                    {probe.codec.toUpperCase()}
                  </Badge>
                ) : null}
                {probe?.width ? (
                  <Badge tone="neutral">
                    {probe.width}×{probe.height}
                  </Badge>
                ) : null}
                <Badge tone="neutral">{fmtMB(file.size)}</Badge>
                {probe?.duration ? <Badge tone="neutral">{fmtTime(probe.duration)}</Badge> : null}
                {isVideo && probe?.fps ? (
                  <Badge tone="neutral">{probe.fps.toFixed(2)} fps</Badge>
                ) : null}
              </div>
            </Glass>
          )}

          {/* --- Результат: сравнение «до/после» и действия (как у сжатия) --- */}
          {done && job && (
            <Glass
              className="up-card"
              style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}
              onContextMenu={(e) =>
                menu.open(e, [
                  {
                    label: t("ctx.copyName"),
                    icon: Copy,
                    onClick: () => copyToClipboard(job.name),
                  },
                  {
                    label: t("up.download"),
                    icon: Download,
                    onClick: () => void download(job.id, job),
                  },
                  { label: t("ctx.reveal"), icon: FolderOpen, onClick: () => void reveal(job.id) },
                  { label: t("up.savePreset"), icon: Save, onClick: () => setSaveModal(true) },
                  { separator: true },
                  { label: t("up.delete"), icon: Trash2, danger: true, onClick: () => reset() },
                ])
              }
            >
              {resultUrl && previewUrl ? (
                <CompareSlider
                  kind={kind}
                  originalSrc={previewUrl}
                  resultSrc={resultUrl}
                  originalLabel={t("up.original")}
                  resultLabel={t("up.result")}
                  aspect={aspect}
                  fps={isVideo ? job.fpsOut || probe?.fps || 30 : 30}
                  active={isActive}
                />
              ) : null}
              <div className="up-result-row">
                <div className="media-title up-ellipsis">{job.name}</div>
                {resultBadges}
              </div>
              <div className="up-row-actions">
                <Btn variant="primary" icon={Download} onClick={() => void download(job.id, job)}>
                  {t("up.download")}
                </Btn>
                <Btn icon={Upload} onClick={() => void pick(null)}>
                  {t("up.newMedia")}
                </Btn>
                <Btn icon={RotateCcw} onClick={reset}>
                  {t("up.again")}
                </Btn>
              </div>
            </Glass>
          )}

          {defect && (
            <Glass className="up-alert">
              <AlertTriangle size={14} />
              <span className="up-err">{defect}</span>
            </Glass>
          )}
        </div>

        {/* --- Правая колонка: предупреждения и карточка настроек --- */}
        <div className="up-right">
          {apiDown ? (
            <div className="up-alert up-alert-warn up-alert-stack">
              <div className="up-alert-row">
                <AlertTriangle size={14} />
                <span>{t("up.apiDown")}</span>
                <Btn icon={RefreshCw} onClick={() => void loadHardware()}>
                  {t("up.runtimeRetry")}
                </Btn>
              </div>
            </div>
          ) : null}
          {hw && !hw.runtime ? (
            <div className="up-alert up-alert-warn up-alert-stack">
              <div className="up-alert-row">
                <Cpu size={14} />
                <span>{t("up.runtimeMissing")}</span>
                <code className="up-code">npm install onnxruntime-node</code>
                <Btn icon={RefreshCw} onClick={() => void loadHardware()}>
                  {t("up.runtimeRetry")}
                </Btn>
              </div>
              {/* Реальная причина: без неё сообщение не отличить от «модуль не в сборке». */}
              {hw.runtimeInfo?.error ? (
                <div className="muted-sm up-runtime-why" title={hw.runtimeInfo.error}>
                  {t("up.runtimeWhy")} {hw.runtimeInfo.error}
                </div>
              ) : null}
            </div>
          ) : null}
          {hw && !hw.ffmpeg?.found ? (
            <div className="up-alert up-alert-warn">
              <AlertTriangle size={14} />
              <span>{t("up.ffmpegMissing")}</span>
            </div>
          ) : null}

          <Glass className="up-card up-fill" style={{ flexDirection: "column", gap: 12 }}>
            <UpscaleDashboard
              file={file}
              probe={probe}
              params={p}
              onParams={(patch) => setP((prev) => ({ ...prev, ...patch }))}
              presets={presets.system}
              customPresets={presets.custom}
              onPreset={applyPreset}
              onDeletePreset={deletePreset}
              mode={mode}
              onMode={setMode}
              models={models}
              modelCount={{ ready: models.filter((m) => m.available).length, total: models.length }}
              onOpenModels={() => setModelsOpen(true)}
              estimate={estimate}
              job={job}
              busy={busy}
              batchCount={batch.length}
              onStart={batch.length > 0 ? () => void runBatch() : start}
              onReset={reset}
              onSavePreset={() => setSaveModal(true)}
              onCancel={() => void cancelRun(jobId)}
              stopping={stopping}
              onPause={(next) => void togglePause(next)}
              pausing={pausing}
              pack={pack}
              onPackInstall={(step) => void packInstall(step)}
              onPackCancel={() => void packCancel()}
              onPackRemove={() => void packRemove()}
              onPackCheck={() => void loadPack(true)}
              hw={
                hw?.gpu
                  ? { ...hw.gpu, providers: hw.providers, trt: hw.trt, pack: hw.pack }
                  : undefined
              }
            />
          </Glass>
        </div>
      </div>

      {/* --- Модалка: каталог моделей ONNX (скачивание с прогрессом) --- */}
      {modelsOpen ? (
        <UpscaleModelsPanel
          models={models}
          params={p}
          busy={modelBusy}
          runtime={!!hw?.runtime}
          runtimeError={hw?.runtimeInfo?.error || ""}
          apiDown={apiDown}
          dir={modelsState?.dir || ""}
          manifest={modelsState?.manifest}
          trt={modelsState?.trt || hw?.trt || null}
          trtBusy={trtBusy}
          trtNote={trtNote}
          trtProgress={trtProgress}
          onBuildTrt={(id, tile) => void buildTrt(id, tile)}
          onBuildTrtAll={() => void buildTrtAll()}
          onDropOnnx={(id) => void dropOnnx(id)}
          bench={bench}
          benchBusy={benchBusy}
          benchProgress={benchProgress}
          onBench={(id) => void benchModel(id)}
          onBenchAll={() => void benchAll()}
          onBenchStop={() => {
            benchStop.current = true;
          }}
          onBenchClear={() => void benchClear()}
          syncing={manifestBusy}
          bulk={bulkModels}
          onSync={syncModels}
          onDownload={(id, force) => void downloadModel(id, force)}
          onRemove={(id) => void removeModel(id)}
          onDownloadAll={downloadAllModels}
          onRemoveAll={removeAllModels}
          onApply={applyModel}
          onOpenDir={() => void openModelsDir()}
          onClose={() => setModelsOpen(false)}
        />
      ) : null}

      {/* --- Модалка: сохранить параметры как пресет --- */}
      {saveModal ? (
        <div className="modal-overlay" onClick={() => setSaveModal(false)}>
          <Glass className="modal-panel" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <div className="up-modal-head">
              <div className="media-title">{t("up.savePreset")}</div>
              <button className="up-icon-x" onClick={() => setSaveModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="up-modal-row">
              <input
                className="text-input"
                style={{ flex: 1 }}
                value={presetName}
                placeholder={t("up.presetName")}
                onChange={(e) => setPresetName(e.target.value)}
              />
              <Btn variant="primary" icon={Save} onClick={savePreset}>
                {t("up.save")}
              </Btn>
            </div>
          </Glass>
        </div>
      ) : null}
    </div>
  );
}

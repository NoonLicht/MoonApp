import { useState, useEffect, useRef, useCallback } from "react";
import {
  Upload,
  Wand2,
  Download,
  Save,
  Trash2,
  Copy,
  RefreshCw,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Zap,
  Heart,
  SplitSquareHorizontal,
  Merge,
  ArrowUp,
  ArrowDown,
  Pause,
  FolderOpen,
  FileText,
  Layers,
  RotateCcw,
} from "lucide-react";
import {
  Glass,
  Btn,
  IconBtn,
  Select,
  Badge,
  SectionHead,
  ProgressBar,
  EmptyHint,
  Checkbox,
} from "@/components/ui";
import { ParamField } from "@/pages/voice/parts/ParamField";
import AudioPlayer from "@/pages/voice/parts/AudioPlayer";
import { PyEnvPanel } from "@/pages/voice/parts/PyEnvPanel";
import { useI18n } from "@/app/i18n";
import type { TranslateFn } from "@/app/i18n";
import { useContextMenu, copyToClipboard } from "@/components/ContextMenu";
import { usePageBusy } from "@/components/Toolbar";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";
import type {
  TtsProfile,
  TtsPreset,
  TtsHardware,
  TtsBook,
  TtsBookChapter,
  TtsChunk,
  TtsJob,
  TtsPythonEnv,
} from "@/api/client";

/**
 * AudiobookTTSPage: полная студия аудиокниг на двух движках (F5-TTS и
 * Coqui XTTS v2) с универсальным импортом книг (epub/fb2/pdf/mobi/rtf/txt),
 * русским NLP (ёфикация, числа, ударения), интерактивным Batch-редактором,
 * аппаратно-адаптивными бейджами [Optimal] и тултипами (i) у каждого параметра,
 * VRAM-монитором в реальном времени и M4B/MP3-экспортом с главами.
 */

type EngineId = "f5" | "xtts";
type Params = Record<string, any>;

const DEFAULT_PARAMS: Params = {
  mode: "express",
  precision: "float16",
  attention: "sdpa",
  gcEveryChunks: 1,
  nfe: 36,
  cfg: 2.2,
  solver: "euler",
  exaggeration: 1.0,
  temperature: 0.7,
  repetitionPenalty: 3.5,
  topK: 50,
  topP: 0.85,
  speed: 1.0,
  crossFadeMs: 60,
  sentencePauseMs: 400,
  paragraphPauseMs: 1200,
  loudnessTarget: -16,
  format: "m4b",
  expandNumbers: true,
  yoficate: true,
  markStress: true,
  chunkLimit: 380,
};

const ACCEPT = ".epub,.fb2,.zip,.pdf,.mobi,.azw3,.rtf,.txt,.md";

/* -------------- Подкомпоненты Pro-панели (уровень модуля) --------------
   ВАЖНО: они объявлены здесь, а НЕ внутри страницы. Если объявить их внутри
   функции страницы, то на каждый ре-рендер создаётся новый тип компонента,
   React пересоздаёт DOM-узлы, и перетаскивание ползунка мышью обрывается на
   первом же изменении (ползунок сдвигается ровно на одно деление). Данные
   приходят пропсами единым пакетом `proPanel`, поэтому тип компонента
   неизменен и DOM живёт между рендерами. */

interface ProPanelProps {
  params: Params;
  setManual: (k: string, v: any) => void;
  openAcc: Record<string, boolean>;
  toggleAcc: (id: string) => void;
}

type ProParamsProps = Pick<ProPanelProps, "params" | "setManual">;
type ProAccProps = Pick<ProPanelProps, "openAcc" | "toggleAcc">;

/** Аккордеон Pro-панели: плавное раскрытие grid-rows 0fr→1fr, контент
    смонтирован всегда — анимация работает и на открытие, и на закрытие. */
function Accordion({
  id,
  title,
  openAcc,
  toggleAcc,
  children,
}: ProAccProps & {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  const open = !!openAcc[id];
  return (
    <div className="ab-acc">
      <button className="ab-acc-head" aria-expanded={open} onClick={() => toggleAcc(id)}>
        <ChevronDown size={14} className={`ab-acc-chev ${open ? "is-open" : ""}`} />
        <span>{title}</span>
      </button>
      <div className={`ab-acc-collapse ${open ? "is-open" : ""}`}>
        <div className="ab-acc-body">{children}</div>
      </div>
    </div>
  );
}

/** Ползунок параметра: всегда доступен для ручной правки, изменение
    автоматически выключает Smart Express (см. setManual на странице). */
function ProSlider({
  p,
  label,
  tip,
  opt,
  min,
  max,
  step,
  fmt,
  params,
  setManual,
}: ProParamsProps & {
  p: string;
  label: string;
  tip: string;
  opt?: string;
  min: number;
  max: number;
  step: number;
  fmt?: (v: number) => string;
}) {
  const raw = Number(params[p]);
  const value = Number.isFinite(raw) ? raw : min;
  return (
    <ParamField label={`${label} — ${fmt ? fmt(value) : value}`} tooltip={tip} optimal={opt}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => setManual(p, parseFloat(e.target.value))}
      />
    </ParamField>
  );
}

/** Выпадающий параметр Pro-панели. */
function ProSelect({
  p,
  label,
  tip,
  opt,
  options,
  params,
  setManual,
}: ProParamsProps & {
  p: string;
  label: string;
  tip: string;
  opt?: string;
  options: { value: string; label: string }[];
}) {
  return (
    <ParamField label={label} tooltip={tip} optimal={opt}>
      <Select
        value={String(params[p])}
        onChange={(e) => setManual(p, e.target.value)}
        options={options}
      />
    </ParamField>
  );
}

/** Булев параметр Pro-панели. */
function ProToggle({
  p,
  label,
  tip,
  params,
  setManual,
}: ProParamsProps & {
  p: string;
  label: string;
  tip: string;
}) {
  return (
    <ParamField label={label} tooltip={tip}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Checkbox checked={!!params[p]} onClick={() => setManual(p, !params[p])} />
        <span className="muted-sm">{params[p] ? "On" : "Off"}</span>
      </div>
    </ParamField>
  );
}

/**
 * Текст ошибки рендера. Для ошибок Python-окружения показываем понятное
 * объяснение вместо сырого «No module named 'torch'»: он не говорит ни что
 * ставить, ни куда (torch должен стоять в том же интерпретаторе, что выбран в
 * Настройках → «Голос»).
 */
function jobErrorText(t: TranslateFn, job: TtsJob): string {
  const env = job.envError;
  if (!env) return job.error;
  if (env.code === "python_not_found") return t("ab.envNotFound", { cmd: env.cmd });
  if (env.code === "python_env_missing")
    return t("ab.envMissing", { modules: (env.missing || []).join(", ") });
  if (env.code === "probe_failed") return t("ab.envProbeFailed", { detail: env.detail || "" });
  return job.error;
}

export default function AudiobookTTSPage() {
  const { t } = useI18n();
  const menu = useContextMenu();

  // --- Железо, пресеты, профили ---
  const [hw, setHw] = useState<TtsHardware | null>(null);
  const [presets, setPresets] = useState<TtsPreset[]>([]);
  const [profiles, setProfiles] = useState<TtsProfile[]>([]);
  const [presetName, setPresetName] = useState("");

  // --- Python-окружение движка (torch / torchaudio / f5_tts / TTS) ---
  // «Нет torch» раньше выяснялось только в самом конце — сообщением «Ошибка
  // рендера: No module named 'torch'» после загрузки модели. Теперь окружение
  // проверяется до старта, а ставится и переключается оно в панели PyEnvPanel
  // (server/ts/pyEnv.ts) — консоль и ручной ввод пути python не нужны.
  const [pyEnv, setPyEnv] = useState<TtsPythonEnv | null>(null);
  const loadPyEnv = useCallback((force = false) => {
    api
      .ttsEnv(force)
      .then(setPyEnv)
      .catch(() => setPyEnv(null));
  }, []);

  // --- Книга и структура ---
  const [book, setBook] = useState<TtsBook | null>(null);
  const [chapterIdx, setChapterIdx] = useState(0);
  const [rawText, setRawText] = useState("");

  // --- Движок и параметры ---
  const [engine, setEngine] = useState<EngineId>("f5");
  const [params, setParams] = useState<Params>({ ...DEFAULT_PARAMS });
  const setP = (k: string, v: any) => setParams((p) => ({ ...p, [k]: v }));
  // Ручная правка в Pro-панели: значения больше не «авто-конфиг», поэтому
  // Smart Express выключается — дальше всё настраивается как угодно.
  const setManual = (k: string, v: any) =>
    setParams((p) => ({ ...p, [k]: v, ...(p.mode === "express" ? { mode: "pro" } : {}) }));

  // --- Batch editor ---
  const [chunks, setChunks] = useState<TtsChunk[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);
  // Диапазон батчей «с какого по какой»: применяется к массовым операциям
  // (удаление) и, если включён onlyRange, ограничивает рендер.
  const [batchFrom, setBatchFrom] = useState(1);
  const [batchTo, setBatchTo] = useState(0);
  const [onlyRange, setOnlyRange] = useState(false);

  // --- Генерация ---
  const [job, setJob] = useState<TtsJob | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultName, setResultName] = useState("audiobook.mp3");
  const pollRef = useRef<number | null>(null);
  const resultUrlRef = useRef<string | null>(null);

  // --- Референс ---
  const [refFile, setRefFile] = useState("");
  const [sampleName, setSampleName] = useState("");
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("Voice 1");
  const refInputRef = useRef<HTMLInputElement | null>(null);
  const bookInputRef = useRef<HTMLInputElement | null>(null);

  // --- Правая панель ---
  const [proOpen, setProOpen] = useState(false);
  const [centerTab, setCenterTab] = useState<"book" | "batch">("book");
  // Сворачивание рабочей области отдельно для каждой вкладки: длинные списки
  // глав/батчей можно сложить, чтобы не крутить страницу до настроек.
  const [wsOpen, setWsOpen] = useState<{ book: boolean; batch: boolean }>({
    book: true,
    batch: true,
  });
  const [openAcc, setOpenAcc] = useState<Record<string, boolean>>({
    vram: true,
    f5: true,
    xtts: true,
    nlp: true,
    post: true,
    ref: false,
  });
  // Единый пакет данных для модульных подкомпонентов Pro-панели.
  const toggleAcc = useCallback((id: string) => setOpenAcc((o) => ({ ...o, [id]: !o[id] })), []);
  const proPanel = { params, setManual, openAcc, toggleAcc };

  const busy = !!job && !job.done && job.stage !== "error";
  // Синтез озвучки — задача: страницу нельзя выгружать из памяти (keep-alive).
  usePageBusy(busy);
  const optimal = hw?.optimal || {};

  // --- Python-окружение ---
  // Чего именно не хватает (torch / torchaudio / f5_tts / TTS), показывает сама
  // панель окружения бейджами и подсказкой — здесь это не дублируем.
  // Панель установки сообщает, что окружение обновилось (модули появились) —
  // страница перечитывает окружение, минуя серверный кэш.
  const onEnvChanged = useCallback(() => loadPyEnv(true), [loadPyEnv]);

  // Рабочая область: у каждой вкладки своё состояние сворачивания.
  const wsIsOpen = wsOpen[centerTab];
  const toggleWs = () => setWsOpen((o) => ({ ...o, [centerTab]: !o[centerTab] }));

  // Диапазон батчей «#с — #по»: значения всегда зажаты в границы списка,
  // причём from ≤ to, чтобы нельзя было задать границы вразнобой.
  const rangeCount = chunks.length ? Math.max(0, batchTo - batchFrom + 1) : 0;
  const rangeChars = chunks
    .slice(batchFrom - 1, batchTo)
    .reduce((n, c) => n + (c.text?.length || 0), 0);

  const setRangeFrom = (v: number) => {
    const n = Math.max(1, chunks.length);
    const f = Math.min(Math.max(1, Math.round(v) || 1), n);
    setBatchFrom(f);
    setBatchTo((t) => Math.max(f, t >= 1 ? Math.min(t, n) : n));
  };

  const setRangeTo = (v: number) => {
    const n = Math.max(1, chunks.length);
    const t = Math.min(Math.max(1, Math.round(v) || n), n);
    setBatchTo(t);
    setBatchFrom((f) => Math.min(f, t));
  };

  // Массовая операция по выбранному диапазону: удалить батчи #from..#to.
  const deleteRange = () => {
    if (!chunks.length) return;
    setChunks((cs) => [...cs.slice(0, batchFrom - 1), ...cs.slice(batchTo)]);
    setOnlyRange(false);
  };

  // Smart Express ↔ Pro. Тумблер переехал из верхнего тулбара в шапку
  // Pro-настроек, а его место в тулбаре занял монитор VRAM/GPU справа от заголовка.
  // Express возвращает авто-конфиг (точность под вашу карту) и блокирует слайдеры.
  const toggleExpress = () => {
    const next = params.mode === "express" ? "pro" : "express";
    if (next === "express") {
      setParams((p) => ({
        ...p,
        mode: "express",
        ...(optimal.precision ? { precision: optimal.precision } : {}),
      }));
    } else setParams((p) => ({ ...p, mode: next }));
  };

  const reloadPresets = useCallback(() => {
    api
      .ttsPresets()
      .then(setPresets)
      .catch(() => {});
  }, []);

  // Стартовая загрузка: железо (VRAM/бейджи), пресеты, профили, Python-окружение.
  useEffect(() => {
    api
      .ttsHardware()
      .then((h) => {
        setHw(h);
        if (h.optimal?.precision) setP("precision", h.optimal.precision);
      })
      .catch(() => {});
    reloadPresets();
    api
      .ttsProfiles()
      .then(setProfiles)
      .catch(() => {});
    loadPyEnv();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [reloadPresets, loadPyEnv]);

  // Монитор VRAM/GPU живёт в шапке страницы, поэтому опрашивается всегда:
  // часто во время генерации, реже в простое (сервер кэширует nvidia-smi).
  useEffect(() => {
    const id = window.setInterval(
      () => {
        api
          .ttsHardware()
          .then(setHw)
          .catch(() => {});
      },
      busy ? 2000 : 8000,
    );
    return () => window.clearInterval(id);
  }, [busy]);

  // Границы диапазона всегда валидны для текущего списка: после пересборки
  // чанков «с/по» подрезаются до #1..#N (и to = N, если ещё не задан).
  useEffect(() => {
    const n = chunks.length;
    setBatchFrom((f) => (n ? Math.min(Math.max(1, f), n) : 1));
    setBatchTo((t) => (n ? (t >= 1 ? Math.min(t, n) : n) : 0));
  }, [chunks]);

  /* ------------------------- Импорт книги ------------------------- */

  const importBook = async (f: File | null) => {
    if (!f) return;
    try {
      if (/\.(txt|md)$/i.test(f.name)) {
        const text = await f.text();
        setBook({
          title: f.name.replace(/\.\w+$/, ""),
          author: "",
          coverImage: null,
          chapters: [{ title: f.name, text }],
        });
        setRawText(text.slice(0, 900000));
        setChapterIdx(0);
      } else {
        const b = await api.ttsImportBook(f);
        setBook(b);
        setRawText(
          b.chapters
            .map((c) => c.text)
            .join("\n\n")
            .slice(0, 900000),
        );
        setChapterIdx(0);
      }
      setChunks([]); // пересобираются вручную кнопкой или при генерации
    } catch {
      /* счётчик чанков покажет пустоту */
    }
  };

  // Сброс книги: чистим структуру, текст и батчи, оставляя движок/референс/
  // уже сгенерированный файл — чтобы можно было сразу загрузить другую книгу.
  const resetBook = () => {
    setBook(null);
    setRawText("");
    setChunks([]);
    setChapterIdx(0);
    setOnlyRange(false);
    setBatchFrom(1);
    setBatchTo(0);
    setCenterTab("book");
  };

  /* ------------------------- Референс ------------------------- */

  const pickRef = async (f: File | null) => {
    if (!f) return;
    setSampleName(f.name);
    setSampleUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(f);
    });
    try {
      const r = await api.ttsUploadReference(f);
      setRefFile(r.refFile);
    } catch {
      /* покажется при генерации */
    }
  };

  const saveProfile = async () => {
    if (!refFile) return;
    try {
      await api.ttsSaveProfile({
        name: profileName || sampleName || "voice",
        refFile,
        engine,
      });
      api
        .ttsProfiles()
        .then(setProfiles)
        .catch(() => {});
    } catch {
      /* не критично */
    }
  };

  const applyProfile = (p: TtsProfile) => {
    setProfileName(p.name);
    if (p.refFile) setRefFile(p.refFile);
    if (p.engine) setEngine(p.engine);
  };

  /* ------------------------- Пресеты ------------------------- */

  const applyPreset = (p: TtsPreset) => {
    setEngine(p.engine);
    setParams((old) => ({ ...old, ...p.params, mode: "express" }));
    if (p.refFile) setRefFile(p.refFile);
  };

  const savePreset = async () => {
    try {
      await api.ttsSavePreset({
        name: presetName || "Мой пресет",
        engine,
        params: { ...params, mode: undefined },
        refFile,
      });
      setPresetName("");
      reloadPresets();
    } catch {
      /* не критично */
    }
  };

  /* ------------------------- Batch editor ------------------------- */

  const rebuildChunks = async () => {
    const text = rawText.trim();
    if (!text) {
      setChunks([]);
      return;
    }
    setChunksLoading(true);
    try {
      const r = await api.ttsPreviewChunks(text, engine, {
        expandNumbers: params.expandNumbers,
        yoficate: params.yoficate,
        markStress: params.markStress,
      });
      setChunks(r.chunks || []);
    } catch {
      setChunks([]);
    }
    setChunksLoading(false);
  };

  const mergeWithNext = (i: number) => {
    setChunks((cs) => {
      if (i + 1 >= cs.length) return cs;
      const a = cs[i],
        b = cs[i + 1];
      const merged: TtsChunk = {
        text: [a.text, b.text].filter(Boolean).join(" "),
        pauseMs: b.pauseMs,
      };
      return [...cs.slice(0, i), merged, ...cs.slice(i + 2)];
    });
  };

  const splitChunk = (i: number) => {
    setChunks((cs) => {
      const c = cs[i];
      if (!c.text) return cs;
      const mid = c.text.lastIndexOf(" ", Math.ceil(c.text.length / 2));
      if (mid <= 0) return cs;
      const a = { text: c.text.slice(0, mid).trim() };
      const b = { text: c.text.slice(mid + 1).trim(), pauseMs: c.pauseMs };
      return [...cs.slice(0, i), a, b, ...cs.slice(i + 1)];
    });
  };

  const moveChunk = (i: number, dir: -1 | 1) => {
    setChunks((cs) => {
      const j = i + dir;
      if (j < 0 || j >= cs.length) return cs;
      const next = [...cs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const addPause = (i: number) => {
    setChunks((cs) => [...cs.slice(0, i + 1), { pauseMs: 500 }, ...cs.slice(i + 1)]);
  };

  const editChunkText = (i: number, text: string) => {
    setChunks((cs) => cs.map((c, k) => (k === i ? { ...c, text } : c)));
  };

  /* ------------------------- Генерация ------------------------- */

  const generate = async () => {
    if (!refFile) return;
    // «Только диапазон»: рендерим лишь выбранные батчи #from..#to, иначе — весь
    // текст целиком (сервер сам нарежет его на чанки).
    const scoped =
      chunks.length && onlyRange && rangeCount > 0 ? chunks.slice(batchFrom - 1, batchTo) : chunks;
    const useChunks = scoped.length ? scoped : undefined;
    try {
      const j = await api.ttsStart({
        refFile,
        engine,
        chunks: useChunks,
        text: useChunks ? undefined : rawText,
        ...params,
        mode: undefined,
        title: book?.title || "Audiobook",
        author: book?.author || "",
        coverImage: book?.coverImage || null,
      });
      setJob(j);
      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current);
        resultUrlRef.current = null;
      }
      setResultUrl(null);
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const s = await api.ttsStatus(j.id);
          setJob(s);
          if (s.done || s.stage === "error") {
            // Рендер упал из-за окружения (нет torch/f5_tts/TTS или не найден
            // интерпретатор) — сразу перепроверяем окружение, чтобы баннер над
            // панелью показал актуальную подсказку, а не устаревшую.
            if (s.stage === "error" && s.envError) loadPyEnv(true);
            if (pollRef.current) {
              window.clearInterval(pollRef.current);
              pollRef.current = null;
            }
            if (s.done) {
              const { blob, name } = await api.ttsDownload(j.id);
              const url = URL.createObjectURL(blob);
              resultUrlRef.current = url;
              setResultUrl(url);
              setResultName(name);
            }
          }
        } catch {
          /* повтор на следующем тике */
        }
      }, 1500);
    } catch (e: any) {
      setJob({
        id: "",
        engine,
        stage: "error",
        progress: 0,
        chunkIndex: 0,
        chunksTotal: 0,
        error: String(e?.message || e),
        done: false,
        outSize: 0,
      });
    }
  };

  const downloadResult = async () => {
    if (!job?.done) return;
    try {
      const { blob, name } = await api.ttsDownload(job.id);
      // Единый путь скачивания (src/utils/download.ts): здесь копия была урезана
      // до a.click() без appendChild — на части сборок Chromium такой клик
      // игнорировался.
      saveBlob(blob, name);
    } catch {
      /* уже показано в UI */
    }
  };

  /* --- Подкомпоненты Pro-панели ---
     Accordion / ProSlider / ProSelect / ProToggle объявлены на уровне модуля
     (см. начало файла) и получают данные пропсами через `proPanel`. Если
     объявить их здесь, на каждый ре-рендер React будет пересоздавать DOM-узлы
     и перетаскивание ползунка будет обрываться на первом делении. */

  return (
    <div className="page page-ab">
      <SectionHead
        eyebrow={t("ab.eyebrow")}
        title={t("ab.title")}
        action={
          <Badge tone={busy ? "amber" : job?.done ? "teal" : "neutral"} mono>
            {busy
              ? t("ab.statusBusy", { i: (job?.chunkIndex || 0) + 1, n: job?.chunksTotal || 0 })
              : job?.done
                ? t("ab.statusDone")
                : t("ab.statusIdle")}
          </Badge>
        }
      />

      {/* --- Пресеты --- */}
      <div className="ab-presets">
        {presets.map((p) => (
          <Glass
            key={p.id}
            className="ab-preset"
            onClick={() => applyPreset(p)}
            onContextMenu={(e) =>
              menu.open(e, [
                { label: t("ab.applyPreset"), icon: Wand2, onClick: () => applyPreset(p) },
                { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(p.name) },
                ...(!p.builtin
                  ? [
                      { separator: true },
                      {
                        label: t("ctx.del"),
                        icon: Trash2,
                        danger: true,
                        onClick: async () => {
                          await api.ttsDeletePreset(p.id);
                          reloadPresets();
                        },
                      },
                    ]
                  : []),
              ] as any)
            }
          >
            {p.engine === "f5" ? <Zap size={13} /> : <Heart size={13} />}
            <span className="ab-preset-name">{p.name}</span>
            {p.builtin && <Badge tone="teal">SYS</Badge>}
          </Glass>
        ))}
        <Glass className="ab-preset ab-preset-save">
          <input
            className="text-input"
            placeholder={t("ab.presetName")}
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <IconBtn icon={Save} title={t("ab.savePreset")} onClick={savePreset} />
        </Glass>
      </div>

      {/* --- Основная зона: панель управления слева, рабочая область справа --- */}
      <div className="ab-layout">
        {/* Левая колонка (~340px): книга, референс голоса, движок */}
        <div className="ab-col ab-left">
          <Glass className="split-pane">
            <div className="field-label">{t("ab.bookFile")}</div>
            <div
              className="dropzone"
              onClick={() => bookInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                importBook(e.dataTransfer.files?.[0] || null);
              }}
              onContextMenu={(e) =>
                menu.open(e, [
                  {
                    label: t("ab.importBook"),
                    icon: Upload,
                    onClick: () => bookInputRef.current?.click(),
                  },
                  ...(book
                    ? [
                        {
                          label: t("ctx.copyName"),
                          icon: Copy,
                          onClick: () => copyToClipboard(book.title),
                        },
                      ]
                    : []),
                ] as any)
              }
            >
              <input
                ref={bookInputRef}
                type="file"
                hidden
                accept={ACCEPT}
                onChange={(e) => importBook(e.target.files?.[0] || null)}
              />
              {book ? (
                <>
                  <BookOpen size={22} strokeWidth={1.6} />
                  <div className="dropzone-file">{book.title}</div>
                  <span className="muted-sm">
                    {t("ab.chapters", { n: book.chapters.length })} ·{" "}
                    {String(book.format || "").toUpperCase()}
                  </span>
                </>
              ) : (
                <>
                  <Upload size={22} strokeWidth={1.6} />
                  <div>{t("ab.dropBook")}</div>
                  <span className="muted-sm">epub · fb2 · pdf · mobi · rtf · txt</span>
                </>
              )}
            </div>

            {/* Сброс книги: чистим главы/текст/батчи, чтобы сразу загрузить
                другую книгу, не перезагружая страницу. */}
            {book && (
              <div className="ab-book-tools">
                <Btn
                  variant="secondary"
                  icon={RotateCcw}
                  onClick={resetBook}
                  title={t("ab.resetBook")}
                >
                  {t("ab.resetBook")}
                </Btn>
                <span className="muted-sm">{t("ab.resetBookHint")}</span>
              </div>
            )}

            {/* Референс голоса — компактной строкой сразу под импортом книги:
                это первое, что нужно после книги, поэтому держим рядом. */}
            <div className="field-label" style={{ marginTop: 10 }}>
              {t("ab.reference")}
            </div>
            <div className="ab-ref-row ab-ref-compact">
              <button
                type="button"
                className={`ab-ref-pick ${refFile ? "has-file" : ""}`}
                onClick={() => refInputRef.current?.click()}
                title={t("ab.uploadRef")}
              >
                <Upload size={13} />
                <span className="ab-ref-name">
                  {refFile ? sampleName || t("ab.uploadRef") : t("ab.uploadRef")}
                </span>
              </button>
              <input
                ref={refInputRef}
                type="file"
                hidden
                accept="audio/*"
                onChange={(e) => pickRef(e.target.files?.[0] || null)}
              />
              <input
                className="text-input ab-ref-input"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder={t("ab.saveProfile")}
              />
              <IconBtn
                icon={Save}
                title={t("ab.saveProfile")}
                onClick={saveProfile}
                disabled={!refFile}
              />
            </div>
            {sampleUrl && <AudioPlayer src={sampleUrl} compact className="ab-ref-player" />}
            {profiles.length > 0 && (
              <div className="task-list ab-ref-profiles">
                {profiles.map((p) => (
                  <Glass
                    key={p.id}
                    className="task-row"
                    onClick={() => applyProfile(p)}
                    onContextMenu={(e) =>
                      menu.open(e, [
                        {
                          label: t("ab.applyProfile"),
                          icon: Heart,
                          onClick: () => applyProfile(p),
                        },
                        { separator: true },
                        {
                          label: t("ctx.del"),
                          icon: Trash2,
                          danger: true,
                          onClick: async () => {
                            await api.ttsDeleteProfile(p.id);
                            api
                              .ttsProfiles()
                              .then(setProfiles)
                              .catch(() => {});
                          },
                        },
                      ] as any)
                    }
                  >
                    <Heart size={13} />
                    <span className="task-text">{p.name}</span>
                    <span className="muted-sm">{p.engine === "xtts" ? "XTTS" : "F5"}</span>
                    <IconBtn
                      icon={Trash2}
                      size={12}
                      title={t("ctx.del")}
                      onClick={async () => {
                        await api.ttsDeleteProfile(p.id);
                        api
                          .ttsProfiles()
                          .then(setProfiles)
                          .catch(() => {});
                      }}
                    />
                  </Glass>
                ))}
              </div>
            )}

            <div className="field-label" style={{ marginTop: 10 }}>
              {t("ab.engine")}
            </div>
            <div className="ab-engines">
              <div
                className={`ab-engine ${engine === "f5" ? "is-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setEngine("f5")}
                onKeyDown={(e) => e.key === "Enter" && setEngine("f5")}
              >
                <Zap size={15} />
                <b>F5-TTS</b>
                <span className="muted-sm">{t("ab.f5Desc")}</span>
                <span className="ab-tab-badge">~3.8 GB · {t("ab.nonFiction")}</span>
              </div>
              <div
                className={`ab-engine ${engine === "xtts" ? "is-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setEngine("xtts")}
                onKeyDown={(e) => e.key === "Enter" && setEngine("xtts")}
              >
                <Heart size={15} />
                <b>Coqui XTTS v2</b>
                <span className="muted-sm">{t("ab.xttsDesc")}</span>
                <span className="ab-tab-badge ab-tab-badge-amber">~4.5 GB · {t("ab.fiction")}</span>
              </div>
            </div>
          </Glass>
        </div>

        {/* --- Центр: вкладки «Структура книги» / «Batch-редактор» --- */}
        <div className="ab-col ab-center">
          {/* --- Pro-настройки: секция в потоке страницы, глобальный тумблер + под-аккордеоны --- */}
          <Glass className="split-pane ab-pro">
            <div className="ab-pro-head">
              <div className="ab-pro-head-text">
                <div className="field-label" style={{ marginBottom: 2 }}>
                  {t("ab.proSettings")}
                </div>
                {!proOpen && (
                  <div className="muted-sm">
                    {t("ab.expressNote", {
                      precision: String(optimal.precision || "float16").toUpperCase(),
                    })}
                  </div>
                )}
              </div>
              <div className="ab-pro-head-actions">
                {/* Smart Express переехал из верхнего тулбара в шапку Pro-настроек:
                    его место в тулбаре занял монитор VRAM/GPU. */}
                <div className="ab-express-toggle">
                  <Checkbox checked={params.mode === "express"} onClick={toggleExpress} />
                  <span className="muted-sm" onClick={toggleExpress} title={t("ab.expressMode")}>
                    {t("ab.expressMode")}
                  </span>
                </div>
                <Btn icon={proOpen ? ChevronUp : ChevronDown} onClick={() => setProOpen((v) => !v)}>
                  {proOpen ? t("ab.hidePro") : t("ab.showPro")}
                </Btn>
              </div>
            </div>
            {/* Глобальное раскрытие: grid-rows 0fr→1fr, плавная анимация высоты */}
            <div className={`ab-pro-collapse ${proOpen ? "is-open" : ""}`}>
              <div className="ab-pro-inner">
                <div className="ab-pro-accs">
                  <Accordion {...proPanel} id="vram" title={t("ab.accVram")}>
                    <ProSelect
                      {...proPanel}
                      p="precision"
                      label={t("ab.precision")}
                      tip={t("ab.tipPrecision")}
                      opt={
                        optimal.precision === params.precision
                          ? t("ab.optimalForVram", { gb: String(optimal.vram || 8) })
                          : undefined
                      }
                      options={[
                        { value: "float16", label: "FP16" },
                        { value: "bfloat16", label: "BF16" },
                        { value: "float32", label: "FP32" },
                        { value: "int8", label: "INT8" },
                      ]}
                    />
                    <ProSelect
                      {...proPanel}
                      p="attention"
                      label={t("ab.attention")}
                      tip={t("ab.tipAttention")}
                      opt={params.attention === "sdpa" ? t("ab.optimal") : undefined}
                      options={[
                        { value: "flash", label: "FlashAttention-2" },
                        { value: "sdpa", label: "Torch SDPA" },
                        { value: "eager", label: "Eager" },
                      ]}
                    />
                    <ProToggle
                      {...proPanel}
                      p="gcEveryChunks"
                      label={t("ab.vramGc")}
                      tip={t("ab.tipVramGc")}
                    />
                  </Accordion>

                  {engine === "f5" && (
                    <Accordion {...proPanel} id="f5" title={t("ab.accF5")}>
                      <ProSlider
                        {...proPanel}
                        p="nfe"
                        label={t("ab.nfe")}
                        tip={t("ab.tipNfe")}
                        opt={t("ab.optimalNfe")}
                        min={16}
                        max={100}
                        step={2}
                      />
                      <ProSlider
                        {...proPanel}
                        p="cfg"
                        label={t("ab.cfg")}
                        tip={t("ab.tipCfg")}
                        opt={t("ab.optimalCfg")}
                        min={1}
                        max={10}
                        step={0.1}
                        fmt={(v) => v.toFixed(1)}
                      />
                      <ProSelect
                        {...proPanel}
                        p="solver"
                        label="ODE Solver"
                        tip={t("ab.tipSolver")}
                        opt={params.solver === "euler" ? t("ab.optimal") : undefined}
                        options={[
                          { value: "euler", label: "Euler" },
                          { value: "midpoint", label: "Midpoint" },
                          { value: "rk4", label: "RK4" },
                        ]}
                      />
                      <ProSlider
                        {...proPanel}
                        p="exaggeration"
                        label={t("ab.exaggeration")}
                        tip={t("ab.tipExaggeration")}
                        min={0.5}
                        max={2}
                        step={0.05}
                        fmt={(v) => v.toFixed(2)}
                      />
                    </Accordion>
                  )}

                  {engine === "xtts" && (
                    <Accordion {...proPanel} id="xtts" title={t("ab.accXtts")}>
                      <ProSlider
                        {...proPanel}
                        p="temperature"
                        label={t("ab.temperature")}
                        tip={t("ab.tipTemperature")}
                        opt={t("ab.optimalTemp")}
                        min={0.01}
                        max={1.5}
                        step={0.01}
                        fmt={(v) => v.toFixed(2)}
                      />
                      <ProSlider
                        {...proPanel}
                        p="repetitionPenalty"
                        label={t("ab.repPenalty")}
                        tip={t("ab.tipRepPenalty")}
                        opt={t("ab.optimalRep")}
                        min={1}
                        max={15}
                        step={0.1}
                        fmt={(v) => v.toFixed(1)}
                      />
                      <ProSlider
                        {...proPanel}
                        p="topK"
                        label="Top-K"
                        tip={t("ab.tipTopK")}
                        min={1}
                        max={100}
                        step={1}
                      />
                      <ProSlider
                        {...proPanel}
                        p="topP"
                        label="Top-P"
                        tip={t("ab.tipTopP")}
                        opt={t("ab.optimalTopP")}
                        min={0.05}
                        max={1}
                        step={0.05}
                        fmt={(v) => v.toFixed(2)}
                      />
                    </Accordion>
                  )}

                  <Accordion {...proPanel} id="nlp" title={t("ab.accNlp")}>
                    <ProToggle
                      {...proPanel}
                      p="expandNumbers"
                      label={t("ab.expandNumbers")}
                      tip={t("ab.tipExpandNumbers")}
                    />
                    <ProToggle
                      {...proPanel}
                      p="yoficate"
                      label={t("ab.yoficate")}
                      tip={t("ab.tipYoficate")}
                    />
                    <ProToggle
                      {...proPanel}
                      p="markStress"
                      label={t("ab.markStress")}
                      tip={t("ab.tipMarkStress")}
                    />
                  </Accordion>

                  <Accordion {...proPanel} id="post" title={t("ab.accPost")}>
                    <ProSlider
                      {...proPanel}
                      p="crossFadeMs"
                      label={t("ab.crossFade")}
                      tip={t("ab.tipCrossFade")}
                      opt={t("ab.optimalCrossFade")}
                      min={0}
                      max={500}
                      step={10}
                      fmt={(v) => `${v} ms`}
                    />
                    <ProSlider
                      {...proPanel}
                      p="sentencePauseMs"
                      label={t("ab.sentencePause")}
                      tip={t("ab.tipSentencePause")}
                      opt="400 ms"
                      min={100}
                      max={1500}
                      step={50}
                      fmt={(v) => `${v} ms`}
                    />
                    <ProSlider
                      {...proPanel}
                      p="paragraphPauseMs"
                      label={t("ab.paragraphPause")}
                      tip={t("ab.tipParagraphPause")}
                      opt="1200 ms"
                      min={500}
                      max={3000}
                      step={100}
                      fmt={(v) => `${v} ms`}
                    />
                    <ProSlider
                      {...proPanel}
                      p="loudnessTarget"
                      label={t("ab.loudness")}
                      tip={t("ab.tipLoudness")}
                      opt="-16 LUFS"
                      min={-24}
                      max={-10}
                      step={1}
                      fmt={(v) => `${v} LUFS`}
                    />
                    <ProSlider
                      {...proPanel}
                      p="speed"
                      label={t("ab.speed")}
                      tip={t("ab.tipSpeed")}
                      opt="1.0x"
                      min={0.5}
                      max={2}
                      step={0.05}
                      fmt={(v) => `${v.toFixed(2)}x`}
                    />
                    <ProSelect
                      {...proPanel}
                      p="format"
                      label={t("ab.format")}
                      tip={t("ab.tipFormat")}
                      options={[
                        { value: "m4b", label: "M4B (главы)" },
                        { value: "mp3", label: "MP3 (главы)" },
                        { value: "wav", label: "WAV" },
                      ]}
                    />
                  </Accordion>
                </div>
              </div>
            </div>
          </Glass>

          {/* --- Python-окружение движка: панель установки (PyEnvPanel).
              Раньше здесь была только подсказка с командой pip, которую нужно
              было выполнять в консоли руками; теперь torch/f5-tts ставятся из
              интерфейса (выбор CUDA/CPU, прогресс, отмена). Если модулей не
              хватает — панель развёрнута, если всё на месте — свёрнута. --- */}
          <PyEnvPanel engine={engine} env={pyEnv} onChanged={onEnvChanged} />

          {/* --- Плеер + генерация: одна строка. Плеер занимает всё свободное
              место (flex: 20), кнопка генерации компактная справа. --- */}
          <Glass className="ab-run-bar">
            <div className="ab-run-player">
              <AudioPlayer src={resultUrl || undefined} />
              {resultUrl && (
                <div
                  className="ab-run-actions"
                  onContextMenu={(e) =>
                    menu.open(e, [
                      { label: t("ab.downloadResult"), icon: Download, onClick: downloadResult },
                      {
                        label: t("ab.revealInExplorer"),
                        icon: FolderOpen,
                        onClick: () => job && api.ttsReveal(job.outFile || "").catch(() => {}),
                      },
                      { label: t("ab.reRender"), icon: RefreshCw, onClick: generate },
                      { separator: true },
                      {
                        label: t("ctx.copyName"),
                        icon: Copy,
                        onClick: () => copyToClipboard(resultName),
                      },
                    ] as any)
                  }
                >
                  <IconBtn
                    icon={Download}
                    title={t("ab.downloadResult")}
                    onClick={downloadResult}
                  />
                  <IconBtn
                    icon={FolderOpen}
                    title={t("ab.revealInExplorer")}
                    onClick={() => job && api.ttsReveal(job.outFile || "").catch(() => {})}
                  />
                  <IconBtn icon={RefreshCw} title={t("ab.reRender")} onClick={generate} />
                </div>
              )}
            </div>
            <Btn
              variant="primary"
              icon={Wand2}
              disabled={!refFile || busy || (!rawText.trim() && !chunks.length)}
              onClick={generate}
            >
              {busy ? t("ab.generating") : t("ab.generate")}
            </Btn>
            {/* Окружение не готово: панель выше уже объясняет, что установить.
                Здесь короткая памятка у самой кнопки — «почему не поедет». */}
            {onlyRange && rangeCount > 0 && (
              <span className="ab-tab-badge ab-tab-badge-amber">
                {t("ab.rangeBadge", { from: batchFrom, to: batchTo })}
              </span>
            )}
            {busy && (
              <div className="ab-run-status">
                <div className="muted-sm" style={{ marginBottom: 6 }}>
                  {t("ab.chunkProgress", {
                    i: (job?.chunkIndex || 0) + 1,
                    n: job?.chunksTotal || 0,
                  })}
                </div>
                <ProgressBar value={job?.progress || 0} />
              </div>
            )}
            {job?.stage === "error" && (
              <div className="ab-run-status muted-sm" style={{ color: "var(--coral)" }}>
                {t("ab.renderError")}: {jobErrorText(t, job)}
                {/* Команда установки — тут же, чтобы не искать её в настройках. */}
                {!!job.envError?.installHint && (
                  <pre
                    style={{
                      margin: "6px 0 0",
                      padding: "6px 8px",
                      background: "var(--track)",
                      borderRadius: 4,
                      fontSize: 11.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {job.envError.installHint}
                  </pre>
                )}
              </div>
            )}
            {job?.done && (
              <span className="ab-tab-badge">
                {t("ab.statusDone")} · {(job.outSize / 1048576).toFixed(1)} MB
              </span>
            )}
          </Glass>

          <Glass className="split-pane ab-workspace">
            {/* Вкладки и кнопка сворачивания остаются на виду, даже когда
                список глав/батчей сложен. */}
            <div className="ab-tabs">
              <button
                className={`ab-tab ${centerTab === "book" ? "is-active" : ""}`}
                onClick={() => setCenterTab("book")}
              >
                <FileText size={13} /> {t("ab.tabBook")}
              </button>
              <button
                className={`ab-tab ${centerTab === "batch" ? "is-active" : ""}`}
                onClick={() => setCenterTab("batch")}
              >
                <Layers size={13} /> {t("ab.tabBatch")}{" "}
                {chunks.length > 0 && <span className="ab-tab-count">{chunks.length}</span>}
              </button>
              <IconBtn
                icon={wsIsOpen ? ChevronUp : ChevronDown}
                title={wsIsOpen ? t("ab.collapse") : t("ab.expand")}
                onClick={toggleWs}
              />
            </div>

            <div className={`ab-acc-collapse ${wsIsOpen ? "is-open" : ""}`}>
              <div className="ab-acc-body">
                {centerTab === "book" ? (
                  book ? (
                    <div className="ab-chapters">
                      {book.chapters.map((ch: TtsBookChapter, i: number) => (
                        <div
                          key={i}
                          className={`ab-chapter ${i === chapterIdx ? "is-active" : ""}`}
                          onClick={() => setChapterIdx(i)}
                          onContextMenu={(e) =>
                            menu.open(e, [
                              {
                                label: t("ctx.copyName"),
                                icon: Copy,
                                onClick: () => copyToClipboard(ch.title),
                              },
                            ])
                          }
                        >
                          <b>
                            {i + 1}. {ch.title}
                          </b>
                          <span className="muted-sm">
                            {ch.text.length} {t("ab.charsUnit")}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyHint icon={BookOpen} text={t("ab.noBook")} />
                  )
                ) : (
                  <div className="ab-batch">
                    <div className="ab-ref-row">
                      <Btn icon={RefreshCw} onClick={rebuildChunks} disabled={chunksLoading}>
                        {chunksLoading ? t("ab.rebuilding") : t("ab.rebuildChunks")}
                      </Btn>
                      <span className="muted-sm">
                        {chunks.length > 0
                          ? t("ab.chunkHint", {
                              n: chunks.length,
                              limit: engine === "xtts" ? 220 : 380,
                            })
                          : t("ab.batchEmpty")}
                      </span>
                    </div>

                    {/* Диапазон «с какого по какой батч»: массовые операции и,
                      при включённой галочке, рендер только этой части книги. */}
                    <div className="ab-range">
                      <span className="field-label">{t("ab.batchRange")}</span>
                      <input
                        className="ab-range-num"
                        type="number"
                        min={1}
                        max={Math.max(1, chunks.length)}
                        value={batchFrom}
                        onChange={(e) => setRangeFrom(Number(e.target.value))}
                      />
                      <span className="muted-sm">—</span>
                      <input
                        className="ab-range-num"
                        type="number"
                        min={1}
                        max={Math.max(1, chunks.length)}
                        value={batchTo}
                        onChange={(e) => setRangeTo(Number(e.target.value))}
                      />
                      <span className="muted-sm">
                        {t("ab.rangeInfo", { count: rangeCount, chars: rangeChars })}
                      </span>
                      <div className="ab-range-actions">
                        <Checkbox checked={onlyRange} onClick={() => setOnlyRange((v) => !v)} />
                        <span
                          className="muted-sm ab-range-only"
                          onClick={() => setOnlyRange((v) => !v)}
                        >
                          {t("ab.onlyRange")}
                        </span>
                        <IconBtn
                          icon={Trash2}
                          title={t("ab.deleteRange")}
                          onClick={deleteRange}
                          disabled={!chunks.length}
                        />
                      </div>
                    </div>

                    <div className="ab-chunks">
                      {chunks.map((c, i) =>
                        c.pauseMs && !c.text ? (
                          <div
                            key={i}
                            className={`ab-chunk ab-chunk-pause ${i + 1 >= batchFrom && i + 1 <= batchTo ? "is-in-range" : ""}`}
                            onContextMenu={(e) =>
                              menu.open(e, [
                                { separator: true },
                                {
                                  label: t("ctx.del"),
                                  icon: Trash2,
                                  danger: true,
                                  onClick: () => setChunks((cs) => cs.filter((_, k) => k !== i)),
                                },
                              ])
                            }
                          >
                            <Pause size={12} /> {t("ab.pauseMarker", { ms: c.pauseMs })}
                          </div>
                        ) : (
                          <div
                            key={i}
                            className={`ab-chunk ${i + 1 >= batchFrom && i + 1 <= batchTo ? "is-in-range" : ""}`}
                            onContextMenu={(e) =>
                              menu.open(e, [
                                {
                                  label: t("ab.rerenderChunk"),
                                  icon: Wand2,
                                  onClick: () => setP("chunkLimit", params.chunkLimit),
                                },
                                {
                                  label: t("ab.splitChunk"),
                                  icon: SplitSquareHorizontal,
                                  onClick: () => splitChunk(i),
                                },
                                {
                                  label: t("ab.mergeChunk"),
                                  icon: Merge,
                                  onClick: () => mergeWithNext(i),
                                },
                                {
                                  label: t("ab.addPause"),
                                  icon: Pause,
                                  onClick: () => addPause(i),
                                },
                                { separator: true },
                                {
                                  label: t("ab.rangeStart"),
                                  icon: ArrowUp,
                                  onClick: () => setRangeFrom(i + 1),
                                },
                                {
                                  label: t("ab.rangeEnd"),
                                  icon: ArrowDown,
                                  onClick: () => setRangeTo(i + 1),
                                },
                                { separator: true },
                                {
                                  label: t("ab.exportChunkWav"),
                                  icon: Download,
                                  onClick: () => {},
                                },
                                {
                                  label: t("ctx.copy"),
                                  icon: Copy,
                                  onClick: () => copyToClipboard(c.text || ""),
                                },
                              ] as any)
                            }
                          >
                            <div className="ab-chunk-head">
                              <span className="muted-sm">
                                #{i + 1} · {c.text?.length || 0}
                              </span>
                              <div style={{ display: "flex", gap: 2 }}>
                                <IconBtn
                                  icon={ArrowUp}
                                  size={11}
                                  title={t("ab.moveUp")}
                                  onClick={() => moveChunk(i, -1)}
                                />
                                <IconBtn
                                  icon={ArrowDown}
                                  size={11}
                                  title={t("ab.moveDown")}
                                  onClick={() => moveChunk(i, 1)}
                                />
                                <IconBtn
                                  icon={SplitSquareHorizontal}
                                  size={11}
                                  title={t("ab.splitChunk")}
                                  onClick={() => splitChunk(i)}
                                />
                                <IconBtn
                                  icon={Merge}
                                  size={11}
                                  title={t("ab.mergeChunk")}
                                  onClick={() => mergeWithNext(i)}
                                />
                                <IconBtn
                                  icon={Pause}
                                  size={11}
                                  title={t("ab.addPause")}
                                  onClick={() => addPause(i)}
                                />
                                <IconBtn
                                  icon={Trash2}
                                  size={11}
                                  title={t("ctx.del")}
                                  onClick={() => setChunks((cs) => cs.filter((_, k) => k !== i))}
                                />
                              </div>
                            </div>
                            <textarea
                              className="ab-chunk-text"
                              value={c.text || ""}
                              onChange={(e) => editChunkText(i, e.target.value)}
                              rows={2}
                            />
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Glass>
        </div>
      </div>
    </div>
  );
}

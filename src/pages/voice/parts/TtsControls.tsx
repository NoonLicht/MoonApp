/**
 * Выделено из AudiobookTTSPage.tsx при разбиении крупного файла (поведение не менялось).
 */
import { ChevronDown } from "lucide-react";
import { ParamField } from "@/pages/voice/parts/ParamField";
import { Select, Checkbox } from "@/components/ui";
import type { TranslateFn } from "@/app/i18n";
import type { TtsJob } from "@/api/client";

/**
 * AudiobookTTSPage: полная студия аудиокниг на двух движках (F5-TTS и
 * Coqui XTTS v2) с универсальным импортом книг (epub/fb2/pdf/mobi/rtf/txt),
 * русским NLP (ёфикация, числа, ударения), интерактивным Batch-редактором,
 * аппаратно-адаптивными бейджами [Optimal] и тултипами (i) у каждого параметра,
 * VRAM-монитором в реальном времени и M4B/MP3-экспортом с главами.
 */

export type EngineId = "f5" | "xtts" | "llama";
export type Params = Record<string, any>;

export const DEFAULT_PARAMS: Params = {
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

export const ACCEPT = ".epub,.fb2,.zip,.pdf,.mobi,.azw3,.rtf,.txt,.md";

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
export function Accordion({
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
export function ProSlider({
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
export function ProSelect({
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
export function ProToggle({
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
export function jobErrorText(t: TranslateFn, job: TtsJob): string {
  const env = job.envError;
  if (!env) return job.error;
  if (env.code === "python_not_found") return t("ab.envNotFound", { cmd: env.cmd });
  if (env.code === "python_env_missing")
    return t("ab.envMissing", { modules: (env.missing || []).join(", ") });
  if (env.code === "probe_failed") return t("ab.envProbeFailed", { detail: env.detail || "" });
  return job.error;
}

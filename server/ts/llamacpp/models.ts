/**
 * GGUF-модели для llama.cpp: каталог, свои файлы по ссылке Hugging Face, загрузка с докачкой.
 * Файлы лежат плоско в storage/models/llama; установленными считаются все *.gguf в папке.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import logger from "../logger";
import { removePath } from "../fsUtil";
import { modelsDir } from "./engine";

const HF = "https://huggingface.co";

export type ModelKind = "translate" | "chat" | "tts" | "ocr" | "embed" | "image";

/** Раздел списка моделей: Qwen, Gemma, «прочие» (узкие и сторонние) и генерация картинок. */
export type Section = "qwen" | "gemma" | "other" | "image";
export const SECTIONS: Section[] = ["qwen", "gemma", "other", "image"];

/** Куда ложится файл: GGUF для llama.cpp или файлы для stable-diffusion.cpp. */
export type Dir = "llama" | "sd";

/** Раздел по ID семейства: translategemma/chandra/gpt-oss/glm/granite попадают в «прочие». */
export function sectionOf(group: string): Section {
  if (/^qwen-image/i.test(group)) return "image";
  if (/^(translategemma|chandra)/i.test(group)) return "other";
  if (/^(gemma|embeddinggemma)/i.test(group)) return "gemma";
  if (/^qwen/i.test(group)) return "qwen";
  return "other";
}

export interface CatalogModel {
  id: string;
  kind: ModelKind;
  repo: string;
  /** Файл в репозитории. */
  file: string;
  sizeMb: number;
  /** Квант (q4km…): показывается в UI. */
  note: string;
  /** Семейство модели: все кванты одной модели сворачиваются в одну группу. */
  group: string;
  /** Название семейства для заголовка группы. */
  title: string;
  /** Понимает картинки (есть проектор). */
  vision?: boolean;
  /** Раздел списка в интерфейсе. */
  section: Section;
  /** Папка основного файла. */
  dir: Dir;
  /**
   * Дополнительные файлы: проектор того же репозитория или (у картинок) VAE и текстовый
   * энкодер из других репозиториев; `as` — имя на диске.
   */
  extra?: { file: string; sizeMb: number; as?: string; repo?: string; dir?: Dir }[];
}

interface Quant {
  q: string;
  file: string;
  mb: number;
}

const quantKey = (q: string): string =>
  q
    .toLowerCase()
    .replace(/_0$/, "")
    .replace(/[^a-z0-9]/g, "");

/** Семейство → набор квантов с общим проектором: ID вида `<group>-<квант>`. */
function family(o: {
  group: string;
  title: string;
  kind: ModelKind;
  repo: string;
  quants: Quant[];
  mmproj?: { file: string; mb: number };
  /** Локальное имя проектора (в плоской папке имена `mmproj-F16.gguf` разных моделей совпали бы). */
  stem?: string;
  /** Файлы из других репозиториев (VAE и энкодер картинок). */
  companions?: { repo: string; file: string; mb: number; as?: string; dir?: Dir }[];
  dir?: Dir;
}): CatalogModel[] {
  return o.quants.map((x) => ({
    id: `${o.group}-${quantKey(x.q)}`,
    kind: o.kind,
    repo: o.repo,
    file: x.file,
    sizeMb: x.mb,
    note: quantKey(x.q),
    group: o.group,
    title: o.title,
    section: sectionOf(o.group),
    dir: o.dir ?? "llama",
    ...(o.mmproj || o.companions
      ? {
          ...(o.mmproj ? { vision: true } : {}),
          extra: [
            ...(o.mmproj
              ? [
                  {
                    file: o.mmproj.file,
                    sizeMb: o.mmproj.mb,
                    // Общие имена `mmproj-F16.gguf` в плоской папке разных моделей совпали бы.
                    ...(/^mmproj-(?:f16|bf16|f32|q8_0)\.gguf$/i.test(o.mmproj.file)
                      ? { as: `${o.stem ?? o.group}.${o.mmproj.file}` }
                      : {}),
                  },
                ]
              : []),
            ...(o.companions ?? []).map((c) => ({
              file: c.file,
              sizeMb: c.mb,
              repo: c.repo,
              dir: c.dir ?? ("llama" as Dir),
              ...(c.as ? { as: c.as } : {}),
            })),
          ],
        }
      : {}),
  }));
}

const Q3 = "Q3_K_M";
const Q4 = "Q4_K_M";
const Q5 = "Q5_K_M";
const Q6 = "Q6_K";

/** VAE и текстовый энкодер Qwen-Image 2.1 (общие для обычной и Turbo-версии). */
export const IMAGE_COMPANIONS = [
  {
    repo: "unsloth/Qwen-Image-2.1-FP8",
    file: "vae/qwen_image_2.1_vae_bf16.safetensors",
    mb: 644,
    as: "qwen_image_2.1_vae_bf16.safetensors",
    dir: "sd" as Dir,
  },
  {
    repo: "unsloth/Qwen3-VL-8B-Instruct-GGUF",
    file: "Qwen3-VL-8B-Instruct-Q4_K_M.gguf",
    mb: 4795,
    dir: "llama" as Dir,
  },
];

export const CATALOG: CatalogModel[] = [
  // Эмбеддинги: тут допустимы и Q6 — файлы крошечные, качество поиска растёт.
  ...family({
    group: "embeddinggemma2",
    title: "EmbeddingGemma 2",
    kind: "embed",
    repo: "unsloth/embeddinggemma-2-GGUF",
    quants: [
      { q: "Q4", file: "embeddinggemma-2-UD-Q4_K_XL.gguf", mb: 168 },
      { q: "Q5", file: "embeddinggemma-2-UD-Q5_K_XL.gguf", mb: 200 },
      { q: "Q6", file: "embeddinggemma-2-UD-Q6_K_XL.gguf", mb: 237 },
      { q: "Q8", file: "embeddinggemma-2-Q8_0.gguf", mb: 296 },
    ],
  }),
  ...family({
    group: "qwen35-08b",
    title: "Qwen3.5 0.8B",
    kind: "chat",
    repo: "unsloth/Qwen3.5-0.8B-GGUF",
    stem: "Qwen3.5-0.8B",
    quants: [
      { q: Q3, file: "Qwen3.5-0.8B-Q3_K_M.gguf", mb: 448 },
      { q: Q4, file: "Qwen3.5-0.8B-Q4_K_M.gguf", mb: 508 },
      { q: Q5, file: "Qwen3.5-0.8B-Q5_K_M.gguf", mb: 563 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 195 },
  }),
  ...family({
    group: "qwen35-2b",
    title: "Qwen3.5 2B",
    kind: "chat",
    repo: "unsloth/Qwen3.5-2B-GGUF",
    stem: "Qwen3.5-2B",
    quants: [
      { q: Q3, file: "Qwen3.5-2B-Q3_K_M.gguf", mb: 1056 },
      { q: Q4, file: "Qwen3.5-2B-Q4_K_M.gguf", mb: 1222 },
      { q: Q5, file: "Qwen3.5-2B-Q5_K_M.gguf", mb: 1369 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 637 },
  }),
  ...family({
    group: "qwen35-4b",
    title: "Qwen3.5 4B",
    kind: "chat",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    stem: "Qwen3.5-4B",
    quants: [
      { q: Q3, file: "Qwen3.5-4B-Q3_K_M.gguf", mb: 2187 },
      { q: Q4, file: "Qwen3.5-4B-Q4_K_M.gguf", mb: 2614 },
      { q: Q5, file: "Qwen3.5-4B-Q5_K_M.gguf", mb: 2998 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 641 },
  }),
  ...family({
    group: "qwen35-9b",
    title: "Qwen3.5 9B",
    kind: "chat",
    repo: "unsloth/Qwen3.5-9B-GGUF",
    stem: "Qwen3.5-9B",
    quants: [
      { q: Q3, file: "Qwen3.5-9B-Q3_K_M.gguf", mb: 4457 },
      { q: Q4, file: "Qwen3.5-9B-Q4_K_M.gguf", mb: 5417 },
      { q: Q5, file: "Qwen3.5-9B-Q5_K_M.gguf", mb: 6273 },
      { q: Q6, file: "Qwen3.5-9B-Q6_K.gguf", mb: 7113 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 876 },
  }),
  ...family({
    group: "gemma4-e2b",
    title: "Gemma 4 E2B",
    kind: "chat",
    repo: "unsloth/gemma-4-E2B-it-GGUF",
    stem: "gemma-4-E2B-it",
    quants: [
      { q: Q3, file: "gemma-4-E2B-it-Q3_K_M.gguf", mb: 2419 },
      { q: Q4, file: "gemma-4-E2B-it-Q4_K_M.gguf", mb: 2963 },
      { q: Q5, file: "gemma-4-E2B-it-Q5_K_M.gguf", mb: 3201 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 940 },
  }),
  ...family({
    group: "qwen3vl-2b-instruct",
    title: "Qwen3-VL 2B Instruct",
    kind: "chat",
    repo: "unsloth/Qwen3-VL-2B-Instruct-GGUF",
    stem: "Qwen3-VL-2B-Instruct",
    quants: [
      { q: Q3, file: "Qwen3-VL-2B-Instruct-Q3_K_M.gguf", mb: 896 },
      { q: Q4, file: "Qwen3-VL-2B-Instruct-Q4_K_M.gguf", mb: 1056 },
      { q: Q5, file: "Qwen3-VL-2B-Instruct-Q5_K_M.gguf", mb: 1200 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 781 },
  }),
  ...family({
    group: "qwen3vl-2b-thinking",
    title: "Qwen3-VL 2B Thinking",
    kind: "chat",
    repo: "unsloth/Qwen3-VL-2B-Thinking-GGUF",
    stem: "Qwen3-VL-2B-Thinking",
    quants: [
      { q: Q3, file: "Qwen3-VL-2B-Thinking-Q3_K_M.gguf", mb: 896 },
      { q: Q4, file: "Qwen3-VL-2B-Thinking-Q4_K_M.gguf", mb: 1056 },
      { q: Q5, file: "Qwen3-VL-2B-Thinking-Q5_K_M.gguf", mb: 1200 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 781 },
  }),
  ...family({
    group: "qwen3vl-8b-instruct",
    title: "Qwen3-VL 8B Instruct",
    kind: "chat",
    repo: "unsloth/Qwen3-VL-8B-Instruct-GGUF",
    stem: "Qwen3-VL-8B-Instruct",
    quants: [
      { q: Q3, file: "Qwen3-VL-8B-Instruct-Q3_K_M.gguf", mb: 3933 },
      { q: Q4, file: "Qwen3-VL-8B-Instruct-Q4_K_M.gguf", mb: 4795 },
      { q: Q5, file: "Qwen3-VL-8B-Instruct-Q5_K_M.gguf", mb: 5580 },
      { q: Q6, file: "Qwen3-VL-8B-Instruct-Q6_K.gguf", mb: 6414 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 1105 },
  }),
  ...family({
    group: "gemma4-e4b",
    title: "Gemma 4 E4B",
    kind: "chat",
    repo: "unsloth/gemma-4-E4B-it-GGUF",
    stem: "gemma-4-E4B-it",
    quants: [
      { q: Q3, file: "gemma-4-E4B-it-Q3_K_M.gguf", mb: 3870 },
      { q: Q4, file: "gemma-4-E4B-it-Q4_K_M.gguf", mb: 4747 },
      { q: Q5, file: "gemma-4-E4B-it-Q5_K_M.gguf", mb: 5228 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 944 },
  }),
  // MoE 21B/3.6B активных: тяжёлые слои идут в видеокарту, эксперты — в RAM (--fit).
  // У gpt-oss эксперты уже в MXFP4, поэтому кванты Q4/Q5 почти одного размера.
  ...family({
    group: "gpt-oss-20b",
    title: "gpt-oss 20B (MoE)",
    kind: "chat",
    repo: "unsloth/gpt-oss-20b-GGUF",
    quants: [
      { q: Q3, file: "gpt-oss-20b-Q3_K_M.gguf", mb: 10973 },
      { q: Q4, file: "gpt-oss-20b-Q4_K_M.gguf", mb: 11086 },
      { q: Q5, file: "gpt-oss-20b-Q5_K_M.gguf", mb: 11174 },
    ],
  }),
  // Остальные MoE-модели (3–4B активных параметров): на 8 ГБ видеокарте — слои на GPU,
  // эксперты в RAM. Размеры и имена файлов сверены с репозиториями unsloth / mradermacher.
  // Лёгкая MoE (7B / ~1B активных, гибрид Mamba): целиком помещается в 8 ГБ видеокарты.
  ...family({
    group: "granite40-h-tiny",
    title: "Granite 4.0 H-Tiny 7B-A1B (MoE, лёгкая)",
    kind: "chat",
    repo: "unsloth/granite-4.0-h-tiny-GGUF",
    quants: [
      { q: Q3, file: "granite-4.0-h-tiny-Q3_K_M.gguf", mb: 3228 },
      { q: Q4, file: "granite-4.0-h-tiny-Q4_K_M.gguf", mb: 4057 },
      { q: Q5, file: "granite-4.0-h-tiny-Q5_K_M.gguf", mb: 4739 },
    ],
  }),
  ...family({
    group: "qwen3-30b-a3b-instruct",
    title: "Qwen3 30B-A3B Instruct 2507 (MoE)",
    kind: "chat",
    repo: "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF",
    quants: [
      { q: Q3, file: "Qwen3-30B-A3B-Instruct-2507-Q3_K_M.gguf", mb: 14030 },
      { q: Q4, file: "Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf", mb: 17697 },
      { q: Q5, file: "Qwen3-30B-A3B-Instruct-2507-Q5_K_M.gguf", mb: 20719 },
    ],
  }),
  ...family({
    group: "qwen3-30b-a3b-thinking",
    title: "Qwen3 30B-A3B Thinking 2507 (MoE)",
    kind: "chat",
    repo: "unsloth/Qwen3-30B-A3B-Thinking-2507-GGUF",
    quants: [
      { q: Q3, file: "Qwen3-30B-A3B-Thinking-2507-Q3_K_M.gguf", mb: 14030 },
      { q: Q4, file: "Qwen3-30B-A3B-Thinking-2507-Q4_K_M.gguf", mb: 17697 },
      { q: Q5, file: "Qwen3-30B-A3B-Thinking-2507-Q5_K_M.gguf", mb: 20719 },
    ],
  }),
  ...family({
    group: "qwen36-35b-a3b",
    title: "Qwen3.6 35B-A3B (MoE)",
    kind: "chat",
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    stem: "Qwen3.6-35B-A3B",
    quants: [
      { q: Q3, file: "Qwen3.6-35B-A3B-UD-Q3_K_M.gguf", mb: 15831 },
      { q: Q4, file: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", mb: 21109 },
      { q: Q5, file: "Qwen3.6-35B-A3B-UD-Q5_K_M.gguf", mb: 25230 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 857 },
  }),
  ...family({
    group: "gemma4-26b-a4b",
    title: "Gemma 4 26B-A4B (MoE)",
    kind: "chat",
    repo: "unsloth/gemma-4-26B-A4B-it-GGUF",
    stem: "gemma-4-26B-A4B-it",
    quants: [
      { q: Q3, file: "gemma-4-26B-A4B-it-UD-Q3_K_M.gguf", mb: 12138 },
      { q: Q4, file: "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf", mb: 16162 },
      { q: Q5, file: "gemma-4-26B-A4B-it-UD-Q5_K_M.gguf", mb: 20170 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 1137 },
  }),
  ...family({
    group: "glm47-flash",
    title: "GLM-4.7 Flash 30B-A3B (MoE)",
    kind: "chat",
    repo: "unsloth/GLM-4.7-Flash-GGUF",
    quants: [
      { q: Q3, file: "GLM-4.7-Flash-Q3_K_M.gguf", mb: 13937 },
      { q: Q4, file: "GLM-4.7-Flash-Q4_K_M.gguf", mb: 17464 },
      { q: Q5, file: "GLM-4.7-Flash-Q5_K_M.gguf", mb: 20417 },
    ],
  }),
  ...family({
    group: "qwen3-coder-30b-a3b",
    title: "Qwen3-Coder 30B-A3B Instruct (MoE, код)",
    kind: "chat",
    repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    quants: [
      { q: Q3, file: "Qwen3-Coder-30B-A3B-Instruct-Q3_K_M.gguf", mb: 14030 },
      { q: Q4, file: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf", mb: 17697 },
      { q: Q5, file: "Qwen3-Coder-30B-A3B-Instruct-Q5_K_M.gguf", mb: 20719 },
    ],
  }),
  ...family({
    group: "glm47-flash-reap",
    title: "GLM-4.7 Flash REAP 23B-A3B (MoE, урезанная)",
    kind: "chat",
    repo: "unsloth/GLM-4.7-Flash-REAP-23B-A3B-GGUF",
    quants: [
      { q: Q3, file: "GLM-4.7-Flash-REAP-23B-A3B-Q3_K_M.gguf", mb: 10751 },
      { q: Q4, file: "GLM-4.7-Flash-REAP-23B-A3B-Q4_K_M.gguf", mb: 13460 },
      { q: Q5, file: "GLM-4.7-Flash-REAP-23B-A3B-Q5_K_M.gguf", mb: 15717 },
    ],
  }),
  // Не MoE: обычная модель 9B с картинками, из-за этого помещается в 8 ГБ видеокарты целиком.
  ...family({
    group: "glm46v-flash",
    title: "GLM-4.6V Flash 9B (картинки)",
    kind: "chat",
    repo: "unsloth/GLM-4.6V-Flash-GGUF",
    stem: "GLM-4.6V-Flash",
    quants: [
      { q: Q3, file: "GLM-4.6V-Flash-Q3_K_M.gguf", mb: 4744 },
      { q: Q4, file: "GLM-4.6V-Flash-Q4_K_M.gguf", mb: 5880 },
      { q: Q5, file: "GLM-4.6V-Flash-Q5_K_M.gguf", mb: 6724 },
    ],
    mmproj: { file: "mmproj-F16.gguf", mb: 1704 },
  }),
  ...family({
    group: "gemma3-4b",
    title: "Gemma 3 4B",
    kind: "chat",
    repo: "unsloth/gemma-3-4b-it-GGUF",
    quants: [
      { q: Q3, file: "gemma-3-4b-it-Q3_K_M.gguf", mb: 2001 },
      { q: Q4, file: "gemma-3-4b-it-Q4_K_M.gguf", mb: 2375 },
      { q: Q5, file: "gemma-3-4b-it-Q5_K_M.gguf", mb: 2699 },
    ],
  }),
  ...family({
    group: "qwen3-4b",
    title: "Qwen3 4B Instruct",
    kind: "chat",
    repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    quants: [
      { q: Q3, file: "Qwen3-4B-Instruct-2507-Q3_K_M.gguf", mb: 1979 },
      { q: Q4, file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", mb: 2382 },
      { q: Q5, file: "Qwen3-4B-Instruct-2507-Q5_K_M.gguf", mb: 2756 },
    ],
  }),
  ...family({
    group: "translategemma-4b",
    title: "TranslateGemma 4B",
    kind: "translate",
    repo: "bullerwins/translategemma-4b-it-GGUF",
    quants: [
      { q: "Q3_K_L", file: "translategemma-4b-it-Q3_K_L.gguf", mb: 2133 },
      { q: Q4, file: "translategemma-4b-it-Q4_K_M.gguf", mb: 2375 },
      { q: Q5, file: "translategemma-4b-it-Q5_K_M.gguf", mb: 2699 },
      { q: "Q6_K", file: "translategemma-4b-it-Q6_K.gguf", mb: 3191 },
      { q: "Q8_0", file: "translategemma-4b-it-Q8_0.gguf", mb: 4130 },
    ],
  }),
  ...family({
    group: "chandra2",
    title: "Chandra OCR 2",
    kind: "ocr",
    repo: "prithivMLmods/chandra-ocr-2-GGUF",
    stem: "chandra-ocr-2",
    quants: [
      { q: "Q3_K_M", file: "chandra-ocr-2.Q3_K_M.gguf", mb: 2418 },
      { q: Q4, file: "chandra-ocr-2.Q4_K_M.gguf", mb: 2924 },
      { q: Q5, file: "chandra-ocr-2.Q5_K_M.gguf", mb: 3349 },
      { q: "Q6_K", file: "chandra-ocr-2.Q6_K.gguf", mb: 4090 },
      { q: "Q8_0", file: "chandra-ocr-2.Q8_0.gguf", mb: 5280 },
    ],
    mmproj: { file: "chandra-ocr-2.mmproj-q8_0.gguf", mb: 350 },
  }),
  ...family({
    group: "qwen3tts",
    title: "Qwen3-TTS 1.7B",
    kind: "tts",
    repo: "ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF",
    quants: [{ q: Q4, file: "Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf", mb: 1036 }],
    mmproj: { file: "mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf", mb: 446 },
  }),
  // Генерация картинок (stable-diffusion.cpp): GGUF — только «денойзер», рядом нужны VAE и текстовый
  // энкодер Qwen3-VL 8B. Энкодер — тот же файл, что и у чат-модели Qwen3-VL 8B Q4, и качается один раз.
  ...family({
    group: "qwen-image-21",
    title: "Qwen-Image 2.1",
    kind: "image",
    repo: "unsloth/Qwen-Image-2.1-GGUF",
    dir: "sd",
    quants: [
      { q: Q3, file: "qwen-image-2.1-Q3_K_M.gguf", mb: 3022 },
      { q: Q4, file: "qwen-image-2.1-Q4_K_M.gguf", mb: 4005 },
      { q: Q5, file: "qwen-image-2.1-Q5_K_M.gguf", mb: 5141 },
      { q: Q6, file: "qwen-image-2.1-Q6_K.gguf", mb: 5981 },
    ],
    companions: IMAGE_COMPANIONS,
  }),
  ...family({
    group: "qwen-image-21-turbo",
    title: "Qwen-Image 2.1 Turbo (8 шагов)",
    kind: "image",
    repo: "unsloth/Qwen-Image-2.1-Turbo-GGUF",
    dir: "sd",
    quants: [
      { q: Q3, file: "qwen-image-2.1-turbo-Q3_K_M.gguf", mb: 3022 },
      { q: Q4, file: "qwen-image-2.1-turbo-Q4_K_M.gguf", mb: 4005 },
      { q: Q5, file: "qwen-image-2.1-turbo-Q5_K_M.gguf", mb: 5141 },
      { q: Q6, file: "qwen-image-2.1-turbo-Q6_K.gguf", mb: 5981 },
    ],
    companions: IMAGE_COMPANIONS,
  }),
];

export interface InstalledModel {
  file: string;
  sizeMb: number;
}

/** Файлы для stable-diffusion.cpp: диффузионные GGUF и VAE. */
export const sdModelsDir = (): string => path.join(path.dirname(modelsDir()), "sd");
const customFile = (): string => path.join(path.dirname(modelsDir()), "custom.json");

function list(dir: string, ext: RegExp): InstalledModel[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => ext.test(f))
      .map((f) => ({ file: f, sizeMb: Math.round(fs.statSync(path.join(dir, f)).size / 1048576) }));
  } catch {
    return [];
  }
}

export const installed = (): InstalledModel[] => list(modelsDir(), /\.gguf$/i);
export const installedSd = (): InstalledModel[] => list(sdModelsDir(), /\.(gguf|safetensors)$/i);

/** Проектор изображений рядом с моделью (`<имя>.mmproj-*.gguf`), если он скачан. */
export function siblingMmproj(file: string): string | null {
  const stem = path
    .basename(file)
    .replace(/[-.](?:UD-)?(?:I?Q\d\w*|F16|BF16)\.gguf$/i, "")
    .toLowerCase();
  const all = installed().map((m) => m.file);
  return all.find((f) => f.toLowerCase().startsWith(`${stem}.mmproj`)) ?? null;
}

export const modelPath = (file: string): string => path.join(modelsDir(), path.basename(file));
export const sdPath = (file: string): string => path.join(sdModelsDir(), path.basename(file));
export const hasModel = (file: string): boolean => fs.existsSync(modelPath(file));
const dirPath = (dir: Dir, file: string): string => (dir === "sd" ? sdPath(file) : modelPath(file));

// ───────────────────────── свои модели: к какому разделу относятся ─────────────────────────

export interface CustomEntry {
  section: Section;
  repo: string;
  dir: Dir;
  /** Что это за файл: основная модель, проектор, VAE или текстовый энкодер. */
  role: "model" | "mmproj" | "vae" | "encoder";
}

export function customModels(): Record<string, CustomEntry> {
  try {
    return JSON.parse(fs.readFileSync(customFile(), "utf8")) as Record<string, CustomEntry>;
  } catch {
    return {};
  }
}

function saveCustom(all: Record<string, CustomEntry>): void {
  fs.mkdirSync(path.dirname(customFile()), { recursive: true });
  fs.writeFileSync(customFile(), JSON.stringify(all, null, 1), "utf8");
}

function noteCustom(file: string, e: CustomEntry): void {
  const all = customModels();
  all[file] = e;
  saveCustom(all);
}

export function removeModel(file: string): void {
  const name = path.basename(file);
  for (const p of [modelPath(name), sdPath(name)]) {
    removePath(p);
    removePath(`${p}.part`);
  }
  const all = customModels();
  if (all[name]) {
    delete all[name];
    saveCustom(all);
  }
  pruneProjectors();
  pruneVae();
}

/** Проектор без единой модели своего семейства занимает место зря — удаляем. */
function pruneProjectors(): void {
  const all = installed().map((m) => m.file);
  for (const f of all) {
    const m = /^(.+?)\.mmproj-.+\.gguf$/i.exec(f);
    if (!m) continue;
    const stem = m[1].toLowerCase();
    const owned = all.some(
      (x) => x !== f && !/mmproj/i.test(x) && x.toLowerCase().startsWith(stem),
    );
    if (!owned) removePath(modelPath(f));
  }
}

/** VAE нужен, пока есть хоть одна диффузионная модель; без неё — удаляем. */
function pruneVae(): void {
  const have = installedSd();
  if (have.some((m) => /\.gguf$/i.test(m.file))) return;
  for (const m of have) removePath(sdPath(m.file));
}

export interface DownloadState {
  file: string;
  status: "downloading" | "done" | "error" | "cancelled";
  bytes: number;
  total: number;
  error: string;
}

let current: DownloadState | null = null;
let abort: AbortController | null = null;
export const downloadState = (): DownloadState | null => current;
export const cancelDownload = (): void => abort?.abort();

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/**
 * Разбор ссылки на Hugging Face: файл (`…/resolve|blob/<rev>/<файл>`) или страница репозитория
 * (`https://huggingface.co/<owner>/<repo>`, можно с `/tree/<rev>`).
 */
export function parseHfUrl(url: string): { repo: string; rev: string; file?: string } | null {
  const u = url.trim();
  const f =
    /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(?:resolve|blob)\/([^/]+)\/(.+\.(?:gguf|safetensors))(?:\?.*)?$/i.exec(
      u,
    );
  if (f) return { repo: f[1], rev: f[2], file: f[3] };
  const r = /^https:\/\/huggingface\.co\/([\w.-]+\/[\w.-]+)(?:\/tree\/([^/?#]+))?\/?(?:[?#].*)?$/i.exec(
    u,
  );
  return r ? { repo: r[1], rev: r[2] ?? "main" } : null;
}

export interface RepoFile {
  file: string;
  sizeMb: number;
  role: CustomEntry["role"];
}

interface HfSibling {
  rfilename: string;
  size?: number;
  lfs?: { sha256?: string; size?: number };
}

async function hfSiblings(repo: string, rev: string): Promise<HfSibling[]> {
  const r = await fetch(`${HF}/api/models/${repo}/revision/${encodeURIComponent(rev)}?blobs=true`, {
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`hf_list_${r.status}`);
  return ((await r.json()) as { siblings?: HfSibling[] }).siblings ?? [];
}

/** Файлы репозитория, которые можно скачать: модели, проекторы и (у картинок) VAE. */
export async function repoFiles(repo: string, rev: string): Promise<RepoFile[]> {
  const out: RepoFile[] = [];
  for (const x of await hfSiblings(repo, rev)) {
    const name = x.rfilename;
    const isVae = /vae.*\.safetensors$/i.test(name);
    if (!/\.gguf$/i.test(name) && !isVae) continue;
    out.push({
      file: name,
      sizeMb: Math.round((x.lfs?.size ?? x.size ?? 0) / 1048576),
      role: isVae ? "vae" : /mmproj/i.test(name) ? "mmproj" : "model",
    });
  }
  return out;
}

async function remoteInfo(
  repo: string,
  rev: string,
  file: string,
): Promise<{ size: number; sha256: string }> {
  const s = (await hfSiblings(repo, rev)).find((x) => x.rfilename === file);
  if (!s) throw new Error("hf_file_missing");
  return { size: s.lfs?.size ?? s.size ?? 0, sha256: s.lfs?.sha256 ?? "" };
}

/** Один файл очереди загрузки: репозиторий, имя в нём, имя и папка на диске. */
export interface DlItem {
  repo: string;
  rev?: string;
  remote: string;
  as?: string;
  dir?: Dir;
  /** Для «своих» моделей: к какому разделу отнести файл. */
  custom?: { section: Section; role: CustomEntry["role"] };
}

export function startDownload(items: DlItem[]): DownloadState {
  if (current?.status === "downloading") return current;
  fs.mkdirSync(modelsDir(), { recursive: true });
  const queue = items.map((i) => ({
    ...i,
    rev: i.rev ?? "main",
    dir: i.dir ?? ("llama" as Dir),
    name: path.basename(i.as || i.remote),
  }));
  if (queue.some((i) => i.dir === "sd")) fs.mkdirSync(sdModelsDir(), { recursive: true });
  const st: DownloadState = {
    file: queue[0].name,
    status: "downloading",
    bytes: 0,
    total: 0,
    error: "",
  };
  current = st;
  abort = new AbortController();
  const signal = abort.signal;
  void (async () => {
    let name = st.file;
    try {
      for (const it of queue) {
        name = it.name;
        const dest = dirPath(it.dir, name);
        const part = `${dest}.part`;
        // Прогресс — по текущему файлу.
        st.file = name;
        st.bytes = 0;
        st.total = 0;
        const info = await remoteInfo(it.repo, it.rev, it.remote);
        st.total = info.size;
        const note = (): void => {
          if (it.custom) noteCustom(name, { ...it.custom, repo: it.repo, dir: it.dir });
        };
        // Общий файл (проектор, VAE, энкодер для нескольких моделей) уже скачан — повторно не тянем.
        if (info.size && fs.existsSync(dest) && fs.statSync(dest).size === info.size) {
          note();
          continue;
        }
        let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (have > info.size) {
          removePath(part);
          have = 0;
        }
        if (have < info.size) {
          const res = await fetch(
            `${HF}/${it.repo}/resolve/${encodeURIComponent(it.rev)}/${it.remote}`,
            {
              redirect: "follow",
              signal,
              headers: have ? { Range: `bytes=${have}-` } : {},
            },
          );
          if (!(res.status === 200 || res.status === 206) || !res.body)
            throw new Error(`hf_download_${res.status}`);
          const append = res.status === 206;
          if (append) st.bytes += have;
          const ws = fs.createWriteStream(part, { flags: append ? "a" : "w" });
          const reader = res.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!ws.write(value)) await new Promise<void>((r) => ws.once("drain", () => r()));
              st.bytes += value.length;
            }
          } finally {
            await new Promise<void>((r) => ws.end(() => r()));
          }
        }
        if (info.size && fs.statSync(part).size !== info.size) throw new Error("size_mismatch");
        if (info.sha256 && (await sha256File(part)) !== info.sha256) {
          removePath(part);
          throw new Error("sha256_mismatch");
        }
        fs.renameSync(part, dest);
        note();
      }
      st.status = "done";
      logger.info("llamacpp.model_downloaded", { file: name, bytes: st.bytes });
    } catch (e) {
      st.status = signal.aborted ? "cancelled" : "error";
      st.error = signal.aborted ? "" : String((e as Error).message || e).slice(0, 200);
      logger.warn("llamacpp.model_download_failed", { file: name, error: st.error });
    }
  })();
  return st;
}

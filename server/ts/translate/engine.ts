/**
 * Движок перевода: TranslateGemma 4B (Gemma 3, decoder-only) поверх onnxruntime-node.
 *
 * Провайдеры (auto / cpu / dml / cuda), рантайм и GPU-пак те же, что у
 * апскейла (см. upscale/runtime.ts) — выбор делает providerOrder(). Генерация
 * написана вручную: префилл подсказки пачками и посимвольный (по токенам) жадный
 * декодинг с KV-кэшем, который переиспользуется как есть — present.* текущего шага
 * подаётся как past_key_values.* следующего без копирования.
 */
import fs from "fs";
import path from "path";
import logger from "../logger";
import { loadOrt, providerOrder } from "../upscale/runtime";
import { LANGUAGES } from "./languages";
import { KV_STATIC, PREFILL_BATCH } from "./limits";
import { graphFile, installedVariants, modelDir } from "./model";
import type { Variant } from "./model";

/** Нужная нам часть Tokenizer из @huggingface/tokenizers (пакет — ESM, типы не подключаем). */
interface Tokenizer {
  encode(text: string, o?: { add_special_tokens?: boolean }): { ids: number[] };
  decode(ids: number[], o?: { skip_special_tokens?: boolean }): string;
}

type Data = ArrayLike<number> | ArrayLike<bigint>;
interface Tensor {
  data: Data;
  dims: readonly number[];
}
interface Session {
  inputNames: readonly string[];
  outputNames: readonly string[];
  inputMetadata?: unknown;
  run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>;
  release?: () => Promise<void>;
}
interface Ort {
  InferenceSession: { create(p: string, o?: Record<string, unknown>): Promise<Session> };
  Tensor: new (type: string, data: unknown, dims: number[]) => Tensor;
}

export interface ModelConfig {
  layers: number;
  kvHeads: number;
  headDim: number;
  eos: number[];
}

interface Loaded {
  key: string;
  provider: string;
  variant: Variant;
  session: Session;
  ort: Ort;
  cfg: ModelConfig;
  /** Тип KV-кэша графа: float16 (q4f16) или float32 (q4). */
  kvType: "float16" | "float32";
  tok: Tokenizer;
  busy: number;
  idleTimer: NodeJS.Timeout | null;
}

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
/** Пары «вариант|провайдер», на которых модель уже падала: повторно не пробуем. */
const failed = new Set<string>();

const IDLE_UNLOAD_MS = 10 * 60 * 1000;

function readConfig(): ModelConfig {
  const dir = modelDir();
  const c = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) as {
    num_hidden_layers: number;
    num_key_value_heads: number;
    head_dim: number;
  };
  let eos = [1, 106];
  try {
    const g = JSON.parse(fs.readFileSync(path.join(dir, "generation_config.json"), "utf8")) as {
      eos_token_id?: number | number[];
    };
    if (g.eos_token_id !== undefined) eos = ([] as number[]).concat(g.eos_token_id);
  } catch {
    /* значения по умолчанию */
  }
  return {
    layers: c.num_hidden_layers,
    kvHeads: c.num_key_value_heads,
    headDim: c.head_dim,
    eos,
  };
}

// @huggingface/tokenizers — чистый ESM, а сервер компилируется в CommonJS: настоящий
// динамический import() через Function, иначе TypeScript превратит его в require().
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<{
  Tokenizer: new (tokenizer: unknown, config: unknown) => Tokenizer;
}>;

async function readTokenizer(): Promise<Tokenizer> {
  const { Tokenizer: Tok } = await esmImport("@huggingface/tokenizers");
  const dir = modelDir();
  const tj = JSON.parse(fs.readFileSync(path.join(dir, "tokenizer.json"), "utf8"));
  const tc = JSON.parse(fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf8"));
  return new Tok(tj, tc);
}

function kvTypeOf(session: Session): "float16" | "float32" {
  const meta = session.inputMetadata;
  if (Array.isArray(meta)) {
    const hit = (meta as { name?: string; type?: string }[]).find((m) =>
      String(m?.name).startsWith("past_key_values."),
    );
    if (hit?.type === "float16") return "float16";
  }
  return "float32";
}

/**
 * Порядок провайдеров для переводчика. TensorRT здесь не используется: ключевые операции
 * модели (MatMulNBits, GroupQueryAttention, SimplifiedLayerNormalization) он не умеет, ORT
 * оставил бы их на CUDA, а строил бы пустые движки. Выбор «tensorrt» работает как CUDA.
 */
export function providers(pref: string): string[] {
  const list = providerOrder(pref === "tensorrt" ? "cuda" : pref, null);
  return [...new Set(list)];
}

/**
 * Варианты, пригодные для провайдера. Gemma 3 в fp16 переполняется на GPU (NaN, пустой вывод),
 * поэтому CUDA/TensorRT работают только с q4 (fp32-активации); q4f16 — лишь на CPU. DirectML — только
 * «dml» (обычные q4/q4f16 на нём дают мусор).
 */
const ALLOWED: Record<string, Variant[]> = {
  cpu: ["q4", "q4f16"],
  dml: ["dml"],
  cuda: ["q4"],
};

export function variantFor(provider: string, wanted: string): Variant | null {
  const have = installedVariants();
  const allowed = (ALLOWED[provider] ?? ["q4", "q4f16"]).filter((v) => have.includes(v));
  if (wanted === "auto") return allowed[0] ?? null;
  return allowed.includes(wanted as Variant) ? (wanted as Variant) : null;
}

function sessionOptions(provider: string): Record<string, unknown> {
  const o: Record<string, unknown> = {
    // TensorRT берёт то, что умеет, остальное (GQA, MatMulNBits) уходит на CUDA.
    executionProviders: [provider],
    graphOptimizationLevel: "all",
    logSeverityLevel: 3,
  };
  // DirectML требует последовательного исполнения и отключённого пула памяти.
  if (provider === "dml") {
    o.enableMemPattern = false;
    o.executionMode = "sequential";
  }
  return o;
}

async function create(pref: string, wanted: string): Promise<Loaded> {
  const ort = loadOrt() as unknown as Ort | null;
  if (!ort) throw new Error("runtime_missing");
  if (!installedVariants().length) throw new Error("model_missing");
  let lastErr: unknown = null;
  for (const provider of providers(pref)) {
    const variant = variantFor(provider, wanted);
    if (!variant) continue;
    const key = `${variant}|${provider}`;
    if (failed.has(key)) continue;
    try {
      const cfg = readConfig();
      const session = await ort.InferenceSession.create(
        graphFile(variant),
        sessionOptions(provider),
      );
      const l: Loaded = {
        key,
        provider,
        variant,
        session,
        ort,
        cfg,
        kvType: kvTypeOf(session),
        tok: await readTokenizer(),
        busy: 0,
        idleTimer: null,
      };
      if (provider !== "cpu" && !process.env.MOONAPP_TR_NOCHECK && !(await selfCheck(l))) {
        // Некоторые драйверы/провайдеры (например DirectML на ряде видеокарт) отдают
        // мусор вместо перевода, не падая. Такой провайдер отбрасываем.
        void Promise.resolve(session.release?.()).catch(() => {});
        failed.add(key);
        logger.warn("translate.selfcheck_failed", { variant, provider });
        lastErr = new Error(`selfcheck_failed:${provider}`);
        continue;
      }
      logger.info("translate.session", { variant, provider, kv: l.kvType });
      return l;
    } catch (e) {
      lastErr = e;
      failed.add(key);
      logger.warn("translate.session_fallback", {
        variant,
        provider,
        error: String((e as Error).message).slice(0, 200),
      });
    }
  }
  throw new Error(
    `session_create_failed: ${String((lastErr as Error)?.message || lastErr).slice(0, 200)}`,
  );
}

/**
 * Проверка корректности вычислений на аппаратном провайдере: короткий перевод en→fr
 * должен дать непустой латинский текст. Мусор (чужие алфавиты, �) — провал.
 */
async function selfCheck(l: Loaded): Promise<boolean> {
  try {
    const ids = l.tok.encode(buildPrompt("Good morning.", "en", "fr"), {
      add_special_tokens: false,
    }).ids;
    const out = await generateIds(l, ids, { maxNew: 8 });
    const text = l.tok.decode(out, { skip_special_tokens: true }).trim();
    const ok = text.length >= 3 && /^[\p{Script=Latin}\s.,!?'’-]+$/u.test(text);
    if (!ok)
      logger.warn("translate.selfcheck_output", { provider: l.provider, text: text.slice(0, 80) });
    return ok;
  } catch (e) {
    logger.warn("translate.selfcheck_error", {
      provider: l.provider,
      error: String((e as Error).message || e).slice(0, 300),
    });
    return false;
  }
}

/** Провайдеры, не прошедшие запуск или проверку («вариант|провайдер»). */
export const failedList = (): string[] => [...failed];

export function loadedInfo(): { provider: string; variant: Variant } | null {
  return loaded ? { provider: loaded.provider, variant: loaded.variant } : null;
}

export function unload(): void {
  const l = loaded;
  if (!l || l.busy > 0) return;
  if (l.idleTimer) clearTimeout(l.idleTimer);
  loaded = null;
  void Promise.resolve(l.session.release?.()).catch(() => {});
  logger.info("translate.session_released", { provider: l.provider });
}

function touch(l: Loaded): void {
  if (l.idleTimer) clearTimeout(l.idleTimer);
  l.idleTimer = setTimeout(unload, IDLE_UNLOAD_MS);
  l.idleTimer.unref?.();
}

/** Загрузить модель (или взять готовую). Смена провайдера/варианта пересоздаёт сессию. */
export async function ensureLoaded(pref: string, wanted: string): Promise<Loaded> {
  if (loaded) {
    // Первый ещё не упавший провайдер из порядка предпочтений — то, что должно быть загружено.
    const want = providers(pref).find((p) => {
      const v = variantFor(p, wanted);
      return v && !failed.has(`${v}|${p}`);
    });
    const ok = loaded.provider === want && (wanted === "auto" || loaded.variant === wanted);
    if (ok || loaded.busy > 0) return loaded;
    unload();
  }
  if (!loading) {
    loading = create(pref, wanted)
      .then((l) => {
        loaded = l;
        touch(l);
        return l;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

// ───────────────────────────────── генерация ─────────────────────────────────

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

function lastRowArgmax(t: Tensor): number {
  const dims = t.dims;
  const vocab = dims[dims.length - 1];
  const rows = dims.length >= 2 ? dims[dims.length - 2] : 1;
  const base = (rows - 1) * vocab;
  const d = t.data as unknown as ArrayLike<number> & { constructor: { name: string } };
  const isRawHalf = d.constructor.name === "Uint16Array";
  let best = 0;
  let bestV = -Infinity;
  for (let i = 0; i < vocab; i++) {
    const raw = d[base + i];
    const v = isRawHalf ? halfToFloat(raw) : raw;
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

/**
 * fp16-тензоры и нативный биндинг ORT. onnxruntime-common превращает Uint16Array в
 * Float16Array (если он есть в Node/Electron), а нативный слой такой массив не принимает
 * («Tensor.data must be a typed array (4 or Float16Array)»). Поэтому на вход подаём
 * Uint16Array, подменяя cpuData готового тензора; выходные present.* (приходят как
 * Float16Array) пересобираем как uint16-вид на тот же буфер — без копирования.
 */
function halfFeed(ort: Ort, data: Uint16Array, dims: readonly number[]): Tensor {
  const t = new ort.Tensor("float16", data, [...dims]);
  (t as unknown as { cpuData: Uint16Array }).cpuData = data;
  return t;
}

function reuseAsFeed(ort: Ort, t: Tensor): Tensor {
  const d = t.data as unknown as { buffer: ArrayBuffer; byteOffset: number; length: number };
  const view = new Uint16Array(d.buffer, d.byteOffset, d.length);
  return halfFeed(ort, view, t.dims);
}

export interface GenStats {
  /** Сгенерировано токенов. */
  tokens: number;
  /** Время обработки подсказки (префилл), мс. */
  prefillMs: number;
  /** Время генерации токенов после префилла, мс — по нему считается ток/с. */
  genMs: number;
}

export interface GenOptions {
  maxNew: number;
  signal?: AbortSignal;
  /** Вызывается после каждого токена: все id на данный момент и накопленная статистика. */
  onToken?: (ids: number[], stats: GenStats) => void;
}

async function generateIds(l: Loaded, prompt: number[], opt: GenOptions): Promise<number[]> {
  const { ort, session, cfg } = l;
  const { layers, kvHeads, headDim } = cfg;
  const half = l.kvType === "float16";
  // DirectML GQA работает только с общим буфером past/present: тензор KV имеет фиксированную
  // длину STATIC, а число действительных токенов задаёт attention_mask (как в ORT GenAI).
  const STATIC = l.variant === "dml" ? KV_STATIC : 0;
  const empty = (): Tensor =>
    half
      ? halfFeed(ort, new Uint16Array(STATIC * kvHeads * headDim), [1, kvHeads, STATIC, headDim])
      : new ort.Tensor("float32", new Float32Array(STATIC * kvHeads * headDim), [
          1,
          kvHeads,
          STATIC,
          headDim,
        ]);
  let past: Record<string, Tensor> = {};
  for (let i = 0; i < layers; i++) {
    past[`past_key_values.${i}.key`] = empty();
    past[`past_key_values.${i}.value`] = empty();
  }
  let pastLen = 0;

  const step = async (ids: number[]): Promise<Tensor> => {
    const n = ids.length;
    const feeds: Record<string, unknown> = {
      input_ids: new ort.Tensor(
        "int64",
        BigInt64Array.from(ids, (x) => BigInt(x)),
        [1, n],
      ),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(pastLen + n).fill(1n), [
        1,
        pastLen + n,
      ]),
      position_ids: new ort.Tensor(
        "int64",
        BigInt64Array.from({ length: n }, (_, i) => BigInt(pastLen + i)),
        [1, n],
      ),
      ...past,
    };
    const out = await session.run(feeds);
    const next: Record<string, Tensor> = {};
    for (let i = 0; i < layers; i++) {
      const k = out[`present.${i}.key`];
      const v = out[`present.${i}.value`];
      next[`past_key_values.${i}.key`] = half ? reuseAsFeed(ort, k) : k;
      next[`past_key_values.${i}.value`] = half ? reuseAsFeed(ort, v) : v;
    }
    past = next;
    pastLen += n;
    return out.logits;
  };

  const t0 = Date.now();
  let logits: Tensor | null = null;
  for (let i = 0; i < prompt.length; i += PREFILL_BATCH) {
    if (opt.signal?.aborted) throw new Error("cancelled");
    logits = await step(prompt.slice(i, i + PREFILL_BATCH));
  }
  // Статический KV-буфер ограничивает суммарную длину: подсказка + перевод.
  const room = STATIC ? STATIC - prompt.length : Infinity;
  if (room <= 0) throw new Error("prompt_too_long");
  const maxNew = Math.min(opt.maxNew, room);
  const tPrefill = Date.now();
  const generated: number[] = [];
  while (logits && generated.length < maxNew) {
    if (opt.signal?.aborted) throw new Error("cancelled");
    const id = lastRowArgmax(logits);
    if (cfg.eos.includes(id)) break;
    generated.push(id);
    opt.onToken?.(generated, {
      tokens: generated.length,
      prefillMs: tPrefill - t0,
      genMs: Date.now() - tPrefill,
    });
    logits = await step([id]);
  }
  return generated;
}

// ───────────────────────────────── перевод ─────────────────────────────────

/** Подсказка в формате chat_template.jinja google/translategemma-4b-it (текстовый режим). */
export function buildPrompt(text: string, src: string, tgt: string): string {
  const S = LANGUAGES[src];
  const T = LANGUAGES[tgt];
  return (
    `<bos><start_of_turn>user\nYou are a professional ${S} (${src}) to ${T} (${tgt}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${S} text while ` +
    `adhering to ${T} grammar, vocabulary, and cultural sensitivities.\n` +
    `Produce only the ${T} translation, without any additional explanations or commentary. ` +
    `Please translate the following ${S} text into ${T}:\n\n\n${text.trim()}<end_of_turn>\n` +
    `<start_of_turn>model\n`
  );
}

export function countTokens(l: Loaded, text: string): number {
  return l.tok.encode(text, { add_special_tokens: false }).ids.length;
}

export interface ChunkResult extends GenStats {
  text: string;
}

export async function translateChunk(
  l: Loaded,
  text: string,
  src: string,
  tgt: string,
  opt: {
    signal?: AbortSignal;
    /** Живой перевод: текст куска на данный момент и статистика (после каждого токена). */
    onPartial?: (text: string, stats: GenStats) => void;
  },
): Promise<ChunkResult> {
  if (!text.trim()) return { text, tokens: 0, prefillMs: 0, genMs: 0 };
  const ids = l.tok.encode(buildPrompt(text, src, tgt), { add_special_tokens: false }).ids;
  const inputTokens = countTokens(l, text);
  const maxNew = Math.min(2048, Math.max(64, inputTokens * 3 + 32));
  l.busy++;
  const t0 = Date.now();
  let last: GenStats = { tokens: 0, prefillMs: 0, genMs: 0 };
  try {
    const out = await generateIds(l, ids, {
      maxNew,
      signal: opt.signal,
      onToken: (gen, st) => {
        last = st;
        // Декодируем целиком, а не по токену: байтовые токены собираются в символ только вместе.
        if (opt.onPartial) opt.onPartial(l.tok.decode(gen, { skip_special_tokens: true }), st);
      },
    });
    if (!last.tokens) last = { tokens: 0, prefillMs: Date.now() - t0, genMs: 0 };
    return { text: l.tok.decode(out, { skip_special_tokens: true }).trim(), ...last };
  } finally {
    l.busy--;
    touch(l);
  }
}

export type { Loaded };

/** Текущий провайдер не справился с запуском — запоминаем и выгружаем, чтобы взять следующий. */
export function failCurrent(): void {
  if (!loaded) return;
  failed.add(loaded.key);
  loaded.busy = 0;
  unload();
}

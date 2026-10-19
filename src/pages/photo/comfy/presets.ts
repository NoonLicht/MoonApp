/**
 * Пресеты ComfyUI: каждый собирает граф в API-формате из параметров формы. Имена файлов моделей
 * подставляются из списков установленного ComfyUI (object_info), а входы «нестабильных» узлов
 * (Qwen-Image 2.1) подбираются по их типам, чтобы пресет не ломался от переименования входов.
 */
import type { ComfyGraph, ComfyNodeInfo } from "@/api/apiComfy";

export type PresetId = "txt2img" | "img2img" | "qwen" | "qwenTurbo" | "upscale";

export interface PresetParams {
  prompt: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  sampler: string;
  scheduler: string;
  denoise: number;
  batch: number;
  /** Имя загруженного во вход ComfyUI файла (img2img, апскейл). */
  image: string;
  /** Выбранные файлы: ckpt — чекпоинт, unet — диффузионная модель, clip — энкодер, vae, upscaler, lora. */
  ckpt: string;
  unet: string;
  clip: string;
  vae: string;
  upscaler: string;
  lora: string;
  loraStrength: number;
}

export const DEFAULTS: PresetParams = {
  prompt: "",
  negative: "",
  width: 1024,
  height: 1024,
  steps: 25,
  cfg: 7,
  seed: -1,
  sampler: "euler",
  scheduler: "normal",
  denoise: 0.6,
  batch: 1,
  image: "",
  ckpt: "",
  unet: "",
  clip: "",
  vae: "",
  upscaler: "",
  lora: "",
  loraStrength: 1,
};

export interface PresetDef {
  id: PresetId;
  /** Какие поля формы показывать. */
  fields: (keyof PresetParams)[];
  /** Значения по умолчанию, отличающиеся от общих. */
  defaults?: Partial<PresetParams>;
  /** Узлы, без которых пресет не соберётся. */
  needs: string[];
  /** Какие модели нужны (для подсказки «чего не хватает»). */
  models: (keyof PresetParams)[];
}

export const PRESETS: PresetDef[] = [
  {
    id: "txt2img",
    fields: ["ckpt", "prompt", "negative", "width", "height", "steps", "cfg", "sampler", "scheduler", "seed", "batch", "lora", "loraStrength"],
    needs: ["CheckpointLoaderSimple", "KSampler"],
    models: ["ckpt"],
  },
  {
    id: "img2img",
    fields: ["ckpt", "image", "prompt", "negative", "steps", "cfg", "denoise", "sampler", "scheduler", "seed"],
    defaults: { steps: 25, cfg: 7, denoise: 0.6 },
    needs: ["CheckpointLoaderSimple", "KSampler", "LoadImage", "VAEEncode"],
    models: ["ckpt"],
  },
  {
    id: "qwen",
    fields: ["unet", "clip", "vae", "prompt", "negative", "width", "height", "steps", "cfg", "sampler", "seed"],
    defaults: { steps: 24, cfg: 4, width: 1024, height: 1024 },
    needs: ["UnetLoaderGGUF", "CLIPLoader", "VAELoader", "TextEncodeQwenImage21", "KSampler"],
    models: ["unet", "clip", "vae"],
  },
  {
    id: "qwenTurbo",
    fields: ["unet", "clip", "vae", "prompt", "width", "height", "seed"],
    defaults: { steps: 8, cfg: 1, width: 1024, height: 1024 },
    needs: ["UnetLoaderGGUF", "CLIPLoader", "VAELoader", "TextEncodeQwenImage21", "SamplerCustomAdvanced", "ManualSigmas"],
    models: ["unet", "clip", "vae"],
  },
  {
    id: "upscale",
    fields: ["image", "upscaler"],
    needs: ["UpscaleModelLoader", "ImageUpscaleWithModel", "LoadImage"],
    models: ["upscaler"],
  },
];

/** Официальные сигмы Qwen-Image 2.1 Turbo (8 шагов). */
export const TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0";

const newSeed = (): number => Math.floor(Math.random() * 2 ** 31);
const seedOf = (p: PresetParams): number => (p.seed < 0 ? newSeed() : p.seed);

type Inp = Record<string, unknown>;

/** Заполняет входы узла по типам из object_info: ссылки — из `links`, строки — по порядку из `texts`. */
function fillByType(
  info: ComfyNodeInfo | undefined,
  links: Record<string, [string, number]>,
  texts: string[],
  numbers: number[],
): Inp {
  const out: Inp = {};
  let ti = 0;
  let ni = 0;
  for (const [key, def] of Object.entries(info?.input?.required ?? {})) {
    const type = Array.isArray(def) ? def[0] : def;
    if (typeof type === "string" && links[type]) out[key] = links[type];
    else if (type === "STRING") out[key] = texts[ti++] ?? "";
    else if (type === "INT" || type === "FLOAT") out[key] = numbers[ni++] ?? (Array.isArray(def) && (def[1] as { default?: number })?.default) ?? 0;
    else if (Array.isArray(type)) out[key] = type[0];
    else if (Array.isArray(def) && (def[1] as { default?: unknown })?.default !== undefined) out[key] = (def[1] as { default: unknown }).default;
  }
  return out;
}

export function buildGraph(id: PresetId, p: PresetParams, info: Record<string, ComfyNodeInfo>): ComfyGraph {
  const seed = seedOf(p);
  const g: ComfyGraph = {};
  const add = (n: string, class_type: string, inputs: Inp): [string, number] => {
    g[n] = { class_type, inputs };
    return [n, 0];
  };

  if (id === "txt2img" || id === "img2img") {
    const ck = add("1", "CheckpointLoaderSimple", { ckpt_name: p.ckpt });
    let model: [string, number] = ck;
    let clip: [string, number] = ["1", 1];
    if (p.lora && info.LoraLoader) {
      add("10", "LoraLoader", { model: ck, clip: ["1", 1], lora_name: p.lora, strength_model: p.loraStrength, strength_clip: p.loraStrength });
      model = ["10", 0];
      clip = ["10", 1];
    }
    const pos = add("2", "CLIPTextEncode", { text: p.prompt, clip });
    const neg = add("3", "CLIPTextEncode", { text: p.negative, clip });
    let latent: [string, number];
    if (id === "txt2img") {
      latent = add("4", "EmptyLatentImage", { width: p.width, height: p.height, batch_size: p.batch });
    } else {
      const img = add("4", "LoadImage", { image: p.image });
      latent = add("5", "VAEEncode", { pixels: img, vae: ["1", 2] });
    }
    const ks = add("6", "KSampler", {
      model,
      positive: pos,
      negative: neg,
      latent_image: latent,
      seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      denoise: id === "txt2img" ? 1 : p.denoise,
    });
    const dec = add("7", "VAEDecode", { samples: ks, vae: ["1", 2] });
    add("8", "SaveImage", { images: dec, filename_prefix: "MoonApp" });
    return g;
  }

  if (id === "upscale") {
    const img = add("1", "LoadImage", { image: p.image });
    const up = add("2", "UpscaleModelLoader", { model_name: p.upscaler });
    const r = add("3", "ImageUpscaleWithModel", { upscale_model: up, image: img });
    add("4", "SaveImage", { images: r, filename_prefix: "MoonApp-up" });
    return g;
  }

  // Qwen-Image 2.1: GGUF-денойзер, энкодер Qwen3-VL (.gguf — через CLIPLoaderGGUF), VAE.
  const unet = add("1", "UnetLoaderGGUF", { unet_name: p.unet });
  const gguf = /\.gguf$/i.test(p.clip) && !!info.CLIPLoaderGGUF;
  const clipNode = gguf
    ? add("2", "CLIPLoaderGGUF", { clip_name: p.clip, type: "qwen_image" })
    : add("2", "CLIPLoader", { clip_name: p.clip, type: "qwen_image", device: "default" });
  const vae = add("3", "VAELoader", { vae_name: p.vae });
  const enc = (n: string, text: string): [string, number] =>
    add(n, "TextEncodeQwenImage21", fillByType(info.TextEncodeQwenImage21, { CLIP: clipNode }, [text, ""], []));
  const pos = enc("4", p.prompt);
  const latent = add("5", info.EmptySD3LatentImage ? "EmptySD3LatentImage" : "EmptyLatentImage", {
    width: p.width,
    height: p.height,
    batch_size: 1,
  });
  if (id === "qwen") {
    const neg = enc("6", p.negative);
    const ks = add("7", "KSampler", {
      model: unet,
      positive: pos,
      negative: neg,
      latent_image: latent,
      seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: "simple",
      denoise: 1,
    });
    const dec = add("8", "VAEDecode", { samples: ks, vae });
    add("9", "SaveImage", { images: dec, filename_prefix: "MoonApp-qwen" });
    return g;
  }
  // Turbo: 8 шагов с готовыми сигмами, CFG 1.
  const sig = add("6", "ManualSigmas", { sigmas: TURBO_SIGMAS });
  const sel = add("7", "KSamplerSelect", { sampler_name: "euler" });
  const noise = add("8", "RandomNoise", { noise_seed: seed });
  const guider = add("9", "CFGGuider", { model: unet, positive: pos, negative: pos, cfg: 1 });
  const sm = add("10", "SamplerCustomAdvanced", { noise, guider, sampler: sel, sigmas: sig, latent_image: latent });
  const dec = add("11", "VAEDecode", { samples: sm, vae });
  add("12", "SaveImage", { images: dec, filename_prefix: "MoonApp-turbo" });
  return g;
}

/** Список значений выпадающего входа узла (имена файлов моделей, сэмплеры). */
export function choices(info: Record<string, ComfyNodeInfo>, node: string, input: string): string[] {
  const def = info[node]?.input?.required?.[input] ?? info[node]?.input?.optional?.[input];
  const t = Array.isArray(def) ? def[0] : def;
  if (Array.isArray(t)) return t.map(String);
  // Новый (V3) вид выпадающего входа: ["COMBO", {options: [...]}]
  const o = t === "COMBO" && Array.isArray(def) ? (def[1] as { options?: unknown[] } | undefined)?.options : undefined;
  return Array.isArray(o) ? o.map(String) : [];
}

/** Узлов, которых нет в установленном ComfyUI, для пресета. */
export function missingNodes(def: PresetDef, info: Record<string, ComfyNodeInfo>): string[] {
  return def.needs.filter((n) => !info[n]);
}

/** Граф-формат ComfyUI (с полями nodes/links) — не API-формат: его надо превратить в редакторе. */
export const isApiGraph = (v: unknown): v is ComfyGraph =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).length > 0 &&
  Object.values(v as Record<string, unknown>).every(
    (n) => !!n && typeof n === "object" && typeof (n as { class_type?: unknown }).class_type === "string",
  );

export const isEditorGraph = (v: unknown): boolean =>
  !!v && typeof v === "object" && Array.isArray((v as { nodes?: unknown }).nodes);

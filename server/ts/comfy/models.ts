/**
 * Модели ComfyUI: что лежит в папках, рекомендуемый набор и скачивание с Hugging Face по ссылке.
 * GGUF-модели из панели llama.cpp (папки sd и models/llama) подключены к ComfyUI через
 * extra_model_paths.yaml и в этом списке отдельно не дублируются.
 */
import fs from "fs";
import path from "path";
import logger from "../logger";
import { downloadToFile } from "../download";
import { removePath } from "../fsUtil";
import { comfyModelsDir, isModelFolder, MODEL_FOLDERS, type ModelFolder } from "./engine";
import { parseHfUrl } from "../llamacpp/models";

const HF = "https://huggingface.co";
const UA = "MoonApp/1.0 (+ComfyUI)";
const EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i;

export interface ComfyModel {
  folder: ModelFolder;
  file: string;
  sizeMb: number;
}

export function listModels(): ComfyModel[] {
  const out: ComfyModel[] = [];
  for (const folder of MODEL_FOLDERS) {
    const base = path.join(comfyModelsDir(), folder);
    const walk = (dir: string, rel: string, depth: number): void => {
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory() && depth < 3) walk(path.join(dir, e.name), r, depth + 1);
        else if (e.isFile() && EXT.test(e.name))
          out.push({ folder, file: r, sizeMb: Math.round(fs.statSync(path.join(dir, e.name)).size / 1048576) });
      }
    };
    walk(base, "", 0);
  }
  return out;
}

export function removeModel(folder: string, file: string): boolean {
  if (!isModelFolder(folder)) return false;
  const base = path.join(comfyModelsDir(), folder);
  const target = path.resolve(base, file);
  if (!target.startsWith(base + path.sep) || !EXT.test(target)) return false;
  removePath(target);
  return true;
}

export interface Recommended {
  id: string;
  folder: ModelFolder;
  repo: string;
  file: string;
  /** Имя на диске (по умолчанию — последний сегмент файла). */
  as?: string;
  sizeMb: number;
  /** Для каких пресетов нужна. */
  for: string[];
}

export const RECOMMENDED: Recommended[] = [
  {
    id: "sdxl",
    folder: "checkpoints",
    repo: "stabilityai/stable-diffusion-xl-base-1.0",
    file: "sd_xl_base_1.0.safetensors",
    sizeMb: 6617,
    for: ["txt2img", "img2img"],
  },
  {
    id: "sd15",
    folder: "checkpoints",
    repo: "stable-diffusion-v1-5/stable-diffusion-v1-5",
    file: "v1-5-pruned-emaonly.safetensors",
    sizeMb: 4072,
    for: ["txt2img", "img2img"],
  },
  {
    id: "qwen-te",
    folder: "text_encoders",
    repo: "Comfy-Org/Qwen-Image-2.1",
    file: "text_encoders/qwen3vl_8b_w4a8.safetensors",
    as: "qwen3vl_8b_w4a8.safetensors",
    sizeMb: 6018,
    for: ["qwen-image"],
  },
  {
    id: "qwen-vae",
    folder: "vae",
    repo: "Comfy-Org/Qwen-Image-2.1",
    file: "vae/qwen_image_2.1_vae_bf16.safetensors",
    as: "qwen_image_2.1_vae_bf16.safetensors",
    sizeMb: 644,
    for: ["qwen-image"],
  },
];

export interface HfFile {
  file: string;
  sizeMb: number;
}

export async function repoModelFiles(repo: string, rev: string): Promise<HfFile[]> {
  const r = await fetch(`${HF}/api/models/${repo}/revision/${encodeURIComponent(rev)}?blobs=true`, {
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`hf_list_${r.status}`);
  const j = (await r.json()) as { siblings?: { rfilename: string; size?: number; lfs?: { size?: number } }[] };
  return (j.siblings ?? [])
    .filter((x) => EXT.test(x.rfilename))
    .map((x) => ({ file: x.rfilename, sizeMb: Math.round((x.lfs?.size ?? x.size ?? 0) / 1048576) }));
}

export { parseHfUrl };

// ───────────────────────────── скачивание ─────────────────────────────

export interface DlJob {
  repo: string;
  rev: string;
  file: string;
  folder: ModelFolder;
  as?: string;
}

export interface DlState {
  status: "idle" | "downloading" | "done" | "error";
  file: string;
  index: number;
  count: number;
  bytes: number;
  total: number;
  error: string;
}

let state: DlState = { status: "idle", file: "", index: 0, count: 0, bytes: 0, total: 0, error: "" };
let abort: AbortController | null = null;

export const downloadState = (): DlState => ({ ...state });
export const cancelDownload = (): void => abort?.abort();

export function startDownload(jobs: DlJob[]): { ok: boolean; error?: string } {
  if (state.status === "downloading") return { ok: false, error: "busy" };
  if (!jobs.length) return { ok: false, error: "empty" };
  for (const j of jobs) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(j.repo) || !EXT.test(j.file) || j.file.includes("..") || !isModelFolder(j.folder))
      return { ok: false, error: "bad_item" };
  }
  abort = new AbortController();
  const ac = abort;
  state = { status: "downloading", file: "", index: 0, count: jobs.length, bytes: 0, total: 0, error: "" };
  void (async () => {
    try {
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        const name = j.as ?? j.file.split("/").pop() ?? j.file;
        const dest = path.join(comfyModelsDir(), j.folder, name);
        state = { ...state, file: name, index: i, bytes: 0, total: 0 };
        if (fs.existsSync(dest)) continue;
        const part = `${dest}.part`;
        await downloadToFile(
          `${HF}/${j.repo}/resolve/${encodeURIComponent(j.rev)}/${j.file.split("/").map(encodeURIComponent).join("/")}`,
          part,
          {
            userAgent: UA,
            timeoutMs: 4 * 60 * 60 * 1000,
            shouldCancel: () => ac.signal.aborted,
            onProgress: (p) => {
              state = { ...state, bytes: p.received, total: p.total };
            },
          },
        );
        fs.renameSync(part, dest);
      }
      state = { ...state, status: "done" };
      logger.info("comfy.models_downloaded", { count: jobs.length });
    } catch (e) {
      state = { ...state, status: "error", error: ac.signal.aborted ? "cancelled" : (e as Error).message };
    }
  })();
  return { ok: true };
}

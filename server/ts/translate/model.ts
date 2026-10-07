/**
 * Файлы модели TranslateGemma (4B) в формате ONNX и их загрузка.
 *
 * Берём text-only экспорт onnx-community/translategemma-text-4b-it-ONNX (веса
 * google/translategemma-4b-it без зрительной башни, без gated-доступа). Две
 * квантизации: q4 (fp32-активации — для CPU) и q4f16 (fp16 — для GPU).
 * Загрузка возобновляемая: докачивает .part по Range и сверяет размер и sha256.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "../config";
import logger from "../logger";
import { removePath } from "../fsUtil";

const { DIRS } = config;

const REPO = "onnx-community/translategemma-text-4b-it-ONNX";
const HF = "https://huggingface.co";
const COMMON = [
  "tokenizer.json",
  "tokenizer_config.json",
  "config.json",
  "generation_config.json",
  "chat_template.jinja",
];

export type Variant = "q4" | "q4f16" | "dml";
export const VARIANTS: Variant[] = ["q4", "q4f16", "dml"];

/**
 * Откуда берётся граф варианта. «dml» — сборка ORT GenAI model builder под DirectML
 * (Menterium): обычные q4/q4f16 на DirectML отдают мусор, а эта работает.
 */
const SOURCES: Record<Variant, { repo: string; graph: string; prefix: string }> = {
  q4: { repo: REPO, graph: "model_q4.onnx", prefix: "onnx/model_q4.onnx" },
  q4f16: { repo: REPO, graph: "model_q4f16.onnx", prefix: "onnx/model_q4f16.onnx" },
  dml: {
    repo: "Menterium/translategemma-4b-it-onnx-int4-dml",
    graph: "model.onnx",
    prefix: "model.onnx",
  },
};
export const isVariant = (v: string): v is Variant => (VARIANTS as string[]).includes(v);

export interface FileSpec {
  /** Репозиторий Hugging Face. */
  repo: string;
  /** Путь в репозитории (onnx/…); на диске лежит плоско, под именем файла. */
  remote: string;
  name: string;
  size: number;
  sha256: string;
}

interface InstalledManifest {
  variant: Variant;
  files: { name: string; size: number }[];
}

export function modelDir(): string {
  return path.join(DIRS.translateModels, "translategemma-4b");
}

const manifestFile = (v: Variant): string => path.join(modelDir(), `installed-${v}.json`);

/** Файл графа для варианта (внешние данные лежат рядом под именами model_<v>.onnx_data*). */
export const graphFile = (v: Variant): string => path.join(modelDir(), SOURCES[v].graph);

export function installedVariants(): Variant[] {
  return VARIANTS.filter((v) => {
    try {
      const m = JSON.parse(fs.readFileSync(manifestFile(v), "utf8")) as InstalledManifest;
      return m.files.every((f) => {
        try {
          return fs.statSync(path.join(modelDir(), f.name)).size === f.size;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  });
}

export interface DownloadState {
  variant: Variant;
  status: "downloading" | "done" | "error" | "cancelled";
  bytes: number;
  total: number;
  file: string;
  error: string;
}

let current: DownloadState | null = null;
let abort: AbortController | null = null;

export const downloadState = (): DownloadState | null => current;

async function repoFiles(
  repo: string,
): Promise<{ rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }[]> {
  const res = await fetch(`${HF}/api/models/${repo}?blobs=true`, { redirect: "follow" });
  if (!res.ok) throw new Error(`hf_list_${res.status}`);
  return ((await res.json()) as { siblings: never[] }).siblings;
}

async function listFiles(v: Variant): Promise<FileSpec[]> {
  const src = SOURCES[v];
  const out: FileSpec[] = [];
  const add = (
    repo: string,
    s: { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } },
  ): void => {
    out.push({
      repo,
      remote: s.rfilename,
      name: path.basename(s.rfilename),
      size: s.lfs?.size ?? s.size ?? 0,
      sha256: s.lfs?.sha256 ?? "",
    });
  };
  // Токенайзер и конфиги общие для всех вариантов — всегда из основного репозитория.
  const main = await repoFiles(REPO);
  for (const s of main) if (COMMON.includes(s.rfilename)) add(REPO, s);
  for (const s of src.repo === REPO ? main : await repoFiles(src.repo))
    if (s.rfilename.startsWith(src.prefix)) add(src.repo, s);
  if (!out.some((f) => f.name === src.graph)) throw new Error("hf_variant_missing");
  return out;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

async function fetchFile(spec: FileSpec, st: DownloadState, signal: AbortSignal): Promise<void> {
  const dest = path.join(modelDir(), spec.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size === spec.size) {
    st.bytes += spec.size;
    return;
  }
  const part = `${dest}.part`;
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (have > spec.size) {
    removePath(part);
    have = 0;
  }
  st.file = spec.name;
  if (have < spec.size) {
    const res = await fetch(`${HF}/${spec.repo}/resolve/main/${spec.remote}`, {
      redirect: "follow",
      signal,
      headers: have ? { Range: `bytes=${have}-` } : {},
    });
    if (!(res.status === 200 || res.status === 206) || !res.body)
      throw new Error(`hf_download_${res.status}`);
    // Сервер мог проигнорировать Range и отдать файл целиком — тогда пишем с нуля.
    const append = res.status === 206;
    // Уже лежащая часть засчитывается в прогресс только при докачке.
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
  } else {
    st.bytes += have;
  }
  if (fs.statSync(part).size !== spec.size) throw new Error(`size_mismatch_${spec.name}`);
  if (spec.sha256) {
    st.file = `${spec.name} (sha256)`;
    if ((await sha256File(part)) !== spec.sha256) {
      removePath(part);
      throw new Error(`sha256_mismatch_${spec.name}`);
    }
  }
  fs.renameSync(part, dest);
}

/** Запускает загрузку варианта в фоне; состояние — через downloadState(). */
export function startDownload(v: Variant): DownloadState {
  if (current?.status === "downloading") return current;
  fs.mkdirSync(modelDir(), { recursive: true });
  const st: DownloadState = {
    variant: v,
    status: "downloading",
    bytes: 0,
    total: 0,
    file: "",
    error: "",
  };
  current = st;
  abort = new AbortController();
  const signal = abort.signal;
  void (async () => {
    try {
      const files = await listFiles(v);
      // Общие файлы могут быть уже скачаны для другого варианта — их байты не пересчитываем зря.
      st.total = files.reduce((n, f) => n + f.size, 0);
      for (const f of files) await fetchFile(f, st, signal);
      const m: InstalledManifest = {
        variant: v,
        files: files.map((f) => ({ name: f.name, size: f.size })),
      };
      fs.writeFileSync(manifestFile(v), JSON.stringify(m, null, 2), "utf8");
      st.status = "done";
      logger.info("translate.model_downloaded", { variant: v, bytes: st.bytes });
    } catch (e) {
      st.status = signal.aborted ? "cancelled" : "error";
      st.error = signal.aborted ? "" : String((e as Error).message || e).slice(0, 200);
      logger.warn("translate.model_download_failed", { variant: v, error: st.error });
    }
  })();
  return st;
}

export function cancelDownload(): void {
  abort?.abort();
}

/** Удалить вариант. Общие файлы (токенайзер) остаются, пока установлен хоть один вариант. */
export function removeVariant(v: Variant): void {
  const dir = modelDir();
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(SOURCES[v].graph) || f === `installed-${v}.json`)
      removePath(path.join(dir, f));
  }
  if (!installedVariants().length) removePath(dir);
}

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

export type ModelKind = "translate" | "chat" | "tts";

export interface CatalogModel {
  id: string;
  kind: ModelKind;
  repo: string;
  file: string;
  sizeMb: number;
  /** Какое качество/скорость; показывается в UI. */
  note: string;
  /** Дополнительные файлы того же репозитория (например mmproj для озвучки). */
  extra?: { file: string; sizeMb: number }[];
}

export const CATALOG: CatalogModel[] = [
  {
    id: "qwen3tts-q4km",
    kind: "tts",
    repo: "ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF",
    file: "Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf",
    sizeMb: 1036,
    note: "q4km",
    extra: [{ file: "mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf", sizeMb: 446 }],
  },
  {
    id: "translategemma-4b-q4km",
    kind: "translate",
    repo: "bullerwins/translategemma-4b-it-GGUF",
    file: "translategemma-4b-it-Q4_K_M.gguf",
    sizeMb: 2490,
    note: "q4km",
  },
  {
    id: "translategemma-4b-q6k",
    kind: "translate",
    repo: "bullerwins/translategemma-4b-it-GGUF",
    file: "translategemma-4b-it-Q6_K.gguf",
    sizeMb: 3191,
    note: "q6k",
  },
  {
    id: "translategemma-4b-q8",
    kind: "translate",
    repo: "bullerwins/translategemma-4b-it-GGUF",
    file: "translategemma-4b-it-Q8_0.gguf",
    sizeMb: 4130,
    note: "q8",
  },
  {
    id: "gemma3-4b-q4km",
    kind: "chat",
    repo: "unsloth/gemma-3-4b-it-GGUF",
    file: "gemma-3-4b-it-Q4_K_M.gguf",
    sizeMb: 2490,
    note: "gemma",
  },
  {
    id: "qwen3-4b-q4km",
    kind: "chat",
    repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    sizeMb: 2497,
    note: "qwen",
  },
];

export interface InstalledModel {
  file: string;
  sizeMb: number;
}

export function installed(): InstalledModel[] {
  try {
    return fs
      .readdirSync(modelsDir())
      .filter((f) => f.toLowerCase().endsWith(".gguf"))
      .map((f) => ({
        file: f,
        sizeMb: Math.round(fs.statSync(path.join(modelsDir(), f)).size / 1048576),
      }));
  } catch {
    return [];
  }
}

export const modelPath = (file: string): string => path.join(modelsDir(), path.basename(file));
export const hasModel = (file: string): boolean => fs.existsSync(modelPath(file));

export function removeModel(file: string): void {
  const p = modelPath(file);
  removePath(p);
  removePath(`${p}.part`);
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

/** Разбор ссылки вида https://huggingface.co/<owner>/<repo>/resolve/<rev>/<file>.gguf. */
export function parseHfUrl(url: string): { repo: string; rev: string; file: string } | null {
  const m =
    /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(?:resolve|blob)\/([^/]+)\/(.+\.gguf)(?:\?.*)?$/i.exec(
      url.trim(),
    );
  return m ? { repo: m[1], rev: m[2], file: m[3] } : null;
}

async function remoteInfo(
  repo: string,
  rev: string,
  file: string,
): Promise<{ size: number; sha256: string }> {
  const r = await fetch(`${HF}/api/models/${repo}/revision/${rev}?blobs=true`, {
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`hf_list_${r.status}`);
  const j = (await r.json()) as {
    siblings: { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }[];
  };
  const s = j.siblings.find((x) => x.rfilename === file);
  if (!s) throw new Error("hf_file_missing");
  return { size: s.lfs?.size ?? s.size ?? 0, sha256: s.lfs?.sha256 ?? "" };
}

export function startDownload(
  repo: string,
  rev: string,
  remotes: string | string[],
): DownloadState {
  if (current?.status === "downloading") return current;
  fs.mkdirSync(modelsDir(), { recursive: true });
  const list = ([] as string[]).concat(remotes);
  const st: DownloadState = {
    file: path.basename(list[0]),
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
      for (const remote of list) {
        name = path.basename(remote);
        const dest = modelPath(name);
        const part = `${dest}.part`;
        // Прогресс — по текущему файлу.
        st.file = name;
        st.bytes = 0;
        st.total = 0;
        const info = await remoteInfo(repo, rev, remote);
        st.total = info.size;
        let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (have > info.size) {
          removePath(part);
          have = 0;
        }
        if (have < info.size) {
          const res = await fetch(`${HF}/${repo}/resolve/${rev}/${remote}`, {
            redirect: "follow",
            signal,
            headers: have ? { Range: `bytes=${have}-` } : {},
          });
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

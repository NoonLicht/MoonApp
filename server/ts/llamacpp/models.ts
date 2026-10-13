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

export type ModelKind = "translate" | "chat" | "tts" | "ocr" | "embed";

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
  /** Дополнительные файлы того же репозитория (проектор); `as` — имя на диске. */
  extra?: { file: string; sizeMb: number; as?: string }[];
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
    ...(o.mmproj
      ? {
          vision: true,
          extra: [
            {
              file: o.mmproj.file,
              sizeMb: o.mmproj.mb,
              // Общие имена `mmproj-F16.gguf` в плоской папке разных моделей совпали бы.
              ...(/^mmproj-(?:f16|bf16|f32|q8_0)\.gguf$/i.test(o.mmproj.file)
                ? { as: `${o.stem ?? o.group}.${o.mmproj.file}` }
                : {}),
            },
          ],
        }
      : {}),
  }));
}

const Q3 = "Q3_K_M";
const Q4 = "Q4_K_M";
const Q5 = "Q5_K_M";

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
export const hasModel = (file: string): boolean => fs.existsSync(modelPath(file));

export function removeModel(file: string): void {
  const p = modelPath(file);
  removePath(p);
  removePath(`${p}.part`);
  pruneProjectors();
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

/** Файл репозитория и (необязательно) имя, под которым он ляжет на диск. */
export type Remote = string | { remote: string; as?: string };

export function startDownload(
  repo: string,
  rev: string,
  remotes: Remote | Remote[],
): DownloadState {
  if (current?.status === "downloading") return current;
  fs.mkdirSync(modelsDir(), { recursive: true });
  const list = ([] as Remote[])
    .concat(remotes)
    .map((r) =>
      typeof r === "string" ? { remote: r, as: "" } : { remote: r.remote, as: r.as ?? "" },
    );
  const st: DownloadState = {
    file: path.basename(list[0].as || list[0].remote),
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
      for (const { remote, as } of list) {
        name = path.basename(as || remote);
        const dest = modelPath(name);
        const part = `${dest}.part`;
        // Прогресс — по текущему файлу.
        st.file = name;
        st.bytes = 0;
        st.total = 0;
        const info = await remoteInfo(repo, rev, remote);
        st.total = info.size;
        // Общий файл (проектор для нескольких квантов) уже скачан — повторно не тянем.
        if (info.size && fs.existsSync(dest) && fs.statSync(dest).size === info.size) continue;
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

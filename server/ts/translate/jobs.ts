/**
 * Задания перевода: текст, файлы, изображения. Модель одна, поэтому задания идут
 * по очереди. Клиент опрашивает состояние: у текстового задания в `partial`
 * копится уже готовая часть перевода — длинный текст виден по мере готовности,
 * а лимита на длину нет: документ режется на куски (см. segment.ts).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import config from "../config";
import logger from "../logger";
import { removePath } from "../fsUtil";
import { extractText } from "../pdfTools";
import { detectLanguage, isLang } from "./languages";
import { ensureLoaded, failCurrent, translateChunk } from "./engine";
import { ensureLlama, isLlama, translateLlama } from "./llama";
import { recognizeBlocks } from "./ocr";
import type { OcrBlock } from "./ocr";
import {
  docxParagraphs,
  docxReplace,
  hasLetters,
  joinParts,
  splitHtml,
  splitMarkdown,
  splitPlain,
  splitSubtitles,
} from "./segment";
import type { Part } from "./segment";

const { DIRS } = config;

export type JobKind = "text" | "file" | "image";
export type JobStatus = "queued" | "loading" | "running" | "done" | "error" | "cancelled";

export interface ImageBlock extends OcrBlock {
  dst: string;
}

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  src: string;
  tgt: string;
  done: number;
  total: number;
  /** Готовая часть текстового перевода. */
  partial: string;
  error: string;
  /** Для файла: имя результата. */
  outName: string;
  /** Для изображения: распознанные и переведённые абзацы. */
  blocks: ImageBlock[];
  provider: string;
  variant: string;
  tokens: number;
  /** Время генерации токенов (без префилла и загрузки), мс. */
  genMs: number;
  /** Время обработки подсказок (префилл), мс. */
  prefillMs: number;
  /** Время загрузки модели и самопроверки, мс. */
  loadMs: number;
  /** Скорость генерации, токенов в секунду. */
  tps: number;
  createdAt: number;
}

export interface Req {
  src: string;
  tgt: string;
  provider: string;
  variant: string;
}

interface Internal {
  job: Job;
  ctrl: AbortController;
  outPath: string;
}

const jobs = new Map<string, Internal>();
let chain: Promise<void> = Promise.resolve();
const KEEP_MS = 2 * 60 * 60 * 1000;

const PROVIDERS = ["auto", "cpu", "dml", "cuda", "tensorrt", "llamacpp"];
export const normProvider = (p: unknown): string =>
  PROVIDERS.includes(String(p)) ? String(p) : "auto";
export const normVariant = (v: unknown): string =>
  v === "q4" || v === "q4f16" || v === "dml" || /^[\w.-]+\.gguf$/i.test(String(v))
    ? String(v)
    : "auto";

function sweep(): void {
  const now = Date.now();
  for (const [id, it] of jobs) {
    if (now - it.job.createdAt > KEEP_MS && it.job.status !== "running") {
      if (it.outPath) removePath(it.outPath);
      jobs.delete(id);
    }
  }
}

const view = (it: Internal): Job => it.job;
export const getJob = (id: string): Job | null =>
  jobs.has(id) ? view(jobs.get(id) as Internal) : null;
export const jobOutput = (id: string): { path: string; name: string } | null => {
  const it = jobs.get(id);
  return it && it.outPath && fs.existsSync(it.outPath)
    ? { path: it.outPath, name: it.job.outName }
    : null;
};

export function cancelJob(id: string): void {
  jobs.get(id)?.ctrl.abort();
}

export function deleteJob(id: string): void {
  const it = jobs.get(id);
  if (!it) return;
  it.ctrl.abort();
  if (it.outPath) removePath(it.outPath);
  jobs.delete(id);
}

function newJob(kind: JobKind, src: string, tgt: string): Internal {
  sweep();
  const job: Job = {
    id: crypto.randomBytes(6).toString("hex"),
    kind,
    status: "queued",
    src,
    tgt,
    done: 0,
    total: 0,
    partial: "",
    error: "",
    outName: "",
    blocks: [],
    provider: "",
    variant: "",
    tokens: 0,
    genMs: 0,
    prefillMs: 0,
    loadMs: 0,
    tps: 0,
    createdAt: Date.now(),
  };
  const it: Internal = { job, ctrl: new AbortController(), outPath: "" };
  jobs.set(job.id, it);
  return it;
}

function enqueue(it: Internal, work: () => Promise<void>): Job {
  chain = chain.then(async () => {
    if (it.ctrl.signal.aborted) {
      it.job.status = "cancelled";
      return;
    }
    try {
      await work();
      if (it.job.status === "running" || it.job.status === "loading") it.job.status = "done";
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg === "cancelled" || it.ctrl.signal.aborted) it.job.status = "cancelled";
      else {
        it.job.status = "error";
        it.job.error = msg.slice(0, 300);
        logger.warn("translate.job_failed", { id: it.job.id, error: it.job.error });
      }
    }
  });
  return it.job;
}

// ───────────────────────────── перевод кусков ─────────────────────────────

/** Кусок через llama.cpp: тот же учёт токенов и живого текста, что у ONNX-движка. */
async function runChunkLlama(
  it: Internal,
  req: Req,
  text: string,
  onLive?: (text: string) => void,
): Promise<string> {
  const tLoad = Date.now();
  const { server, file } = await ensureLlama(req.variant);
  it.job.loadMs += Date.now() - tLoad;
  it.job.provider = `llama.cpp/${server.build}${server.gpu ? "" : " (CPU)"}`;
  it.job.variant = file;
  it.job.status = "running";
  const base = { tokens: it.job.tokens, genMs: it.job.genMs, prefillMs: it.job.prefillMs };
  const apply = (st: { tokens: number; genMs: number; prefillMs: number }): void => {
    it.job.tokens = base.tokens + st.tokens;
    it.job.genMs = base.genMs + st.genMs;
    it.job.prefillMs = base.prefillMs + st.prefillMs;
    it.job.tps = it.job.genMs > 0 ? (it.job.tokens / it.job.genMs) * 1000 : 0;
  };
  const out = await translateLlama(file, text, it.job.src, it.job.tgt, {
    signal: it.ctrl.signal,
    onPartial: (partial, st) => {
      apply(st);
      onLive?.(partial);
    },
  });
  apply(out);
  return out.text;
}

/** Перевести один кусок; если GPU-провайдер упал при запуске — повторить на следующем. */
async function runChunk(
  it: Internal,
  req: Req,
  text: string,
  onLive?: (text: string) => void,
): Promise<string> {
  if (isLlama(req.provider)) return runChunkLlama(it, req, text, onLive);
  for (let attempt = 0; ; attempt++) {
    const tLoad = Date.now();
    const l = await ensureLoaded(req.provider, req.variant);
    it.job.loadMs += Date.now() - tLoad;
    it.job.provider = l.provider;
    it.job.variant = l.variant;
    it.job.status = "running";
    // Итоги уже готовых кусков + текущий кусок, считаемый «вживую».
    const base = { tokens: it.job.tokens, genMs: it.job.genMs, prefillMs: it.job.prefillMs };
    try {
      const out = await translateChunk(l, text, it.job.src, it.job.tgt, {
        signal: it.ctrl.signal,
        onPartial: (partial, st) => {
          it.job.tokens = base.tokens + st.tokens;
          it.job.genMs = base.genMs + st.genMs;
          it.job.prefillMs = base.prefillMs + st.prefillMs;
          it.job.tps = it.job.genMs > 0 ? (it.job.tokens / it.job.genMs) * 1000 : 0;
          onLive?.(partial);
        },
      });
      it.job.tokens = base.tokens + out.tokens;
      it.job.genMs = base.genMs + out.genMs;
      it.job.prefillMs = base.prefillMs + out.prefillMs;
      it.job.tps = it.job.genMs > 0 ? (it.job.tokens / it.job.genMs) * 1000 : 0;
      return out.text;
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg === "cancelled" || it.ctrl.signal.aborted) throw e;
      if (l.provider === "cpu" || attempt >= 2) throw e;
      logger.warn("translate.provider_failed", { provider: l.provider, error: msg.slice(0, 160) });
      failCurrent();
    }
  }
}

async function translateParts(
  it: Internal,
  req: Req,
  parts: Part[],
  live: boolean,
  track = true,
): Promise<string> {
  const translated = new Map<number, string>();
  if (track) it.job.total += parts.filter((p) => p.tr).length;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].tr) continue;
    if (it.ctrl.signal.aborted) throw new Error("cancelled");
    // Готовая часть до текущего куска: во время перевода куска к ней дописывается живой текст.
    const prefix = live ? joinParts(parts.slice(0, i), translated) : "";
    translated.set(
      i,
      await runChunk(
        it,
        req,
        parts[i].text,
        live ? (txt) => (it.job.partial = prefix + txt) : undefined,
      ),
    );
    if (track) it.job.done++;
    if (live) it.job.partial = joinParts(parts.slice(0, i + 1), translated);
  }
  return joinParts(parts, translated);
}

/** Небольшой текст (абзац документа, блок картинки) целиком. */
const translateText = (it: Internal, req: Req, text: string): Promise<string> =>
  translateParts(it, req, splitPlain(text), false, false);

function resolveLangs(src: string, tgt: string, sample: string): { src: string; tgt: string } {
  const s = src === "auto" || !isLang(src) ? detectLanguage(sample) : src;
  if (!isLang(tgt)) throw new Error("bad_language");
  return { src: s, tgt };
}

// ───────────────────────────────── текст ─────────────────────────────────

export function startText(text: string, req: Req): Job {
  const langs = resolveLangs(req.src, req.tgt, text);
  const it = newJob("text", langs.src, langs.tgt);
  const r = { ...req, ...langs };
  return enqueue(it, async () => {
    it.job.status = "loading";
    await translateParts(it, r, splitPlain(text), true);
  });
}

// ───────────────────────────────── файлы ─────────────────────────────────

const TEXT_EXT = new Set([
  ".txt",
  ".log",
  ".md",
  ".markdown",
  ".srt",
  ".vtt",
  ".html",
  ".htm",
  ".xhtml",
]);
export const FILE_EXT = [...TEXT_EXT, ".docx", ".epub", ".pdf"];

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function writeOut(it: Internal, ext: string, data: Buffer | string): void {
  const stem = path.basename(it.job.outName || "result", path.extname(it.job.outName || ""));
  it.job.outName = `${stem}${ext}`;
  it.outPath = path.join(DIRS.translateTmp, `${it.job.id}${ext}`);
  fs.writeFileSync(it.outPath, data);
}

function zipTranslate(
  it: Internal,
  r: Req,
  buf: Buffer,
  pick: (name: string) => boolean,
  mode: "docx" | "html",
): Promise<Buffer> {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && pick(e.entryName));
  return (async () => {
    // Сначала считаем объём, чтобы прогресс был честным.
    const work = entries.map((e) => {
      const xml = e.getData().toString("utf8");
      if (mode === "docx") {
        const paras = docxParagraphs(xml).filter((p) => hasLetters(p.text));
        it.job.total += paras.length;
        return { e, xml, paras, parts: [] as Part[] };
      }
      const parts = splitHtml(xml);
      return { e, xml, paras: [], parts };
    });
    for (const w of work) {
      if (mode === "docx") {
        let xml = w.xml;
        for (const p of w.paras) {
          if (it.ctrl.signal.aborted) throw new Error("cancelled");
          const tr = (await translateText(it, r, p.text)).trim();
          xml = xml.replace(p.xml, docxReplace(p.xml, tr));
          it.job.done++;
        }
        zip.updateFile(w.e.entryName, Buffer.from(xml, "utf8"));
      } else {
        const out = await translateParts(it, r, w.parts, false);
        zip.updateFile(w.e.entryName, Buffer.from(out, "utf8"));
      }
    }
    return zip.toBuffer();
  })();
}

export function startFile(filePath: string, origName: string, req: Req): Job {
  const ext = path.extname(origName).toLowerCase();
  const it = newJob("file", req.src, req.tgt);
  it.job.outName = origName;
  return enqueue(it, async () => {
    try {
      it.job.status = "loading";
      if (!FILE_EXT.includes(ext)) throw new Error("unsupported_file");
      const buf = fs.readFileSync(filePath);
      const stem = path.basename(origName, ext);
      let sample = "";
      if (TEXT_EXT.has(ext)) sample = stripBom(buf.toString("utf8"));
      else if (ext === ".pdf") sample = (await extractText(buf)).text;
      else {
        const zip = new AdmZip(buf);
        const first = zip
          .getEntries()
          .find((e) => /document\.xml$|\.x?html?$/i.test(e.entryName) && !e.isDirectory);
        sample = first
          ? first
              .getData()
              .toString("utf8")
              .replace(/<[^>]+>/g, " ")
          : "";
      }
      const langs = resolveLangs(req.src, req.tgt, sample);
      it.job.src = langs.src;
      it.job.tgt = langs.tgt;
      const r: Req = { ...req, ...langs };
      it.job.outName = `${stem}.${langs.tgt}${ext === ".pdf" ? ".txt" : ext}`;
      const keepName = it.job.outName;
      const finish = (data: Buffer | string): void => {
        const e = path.extname(keepName);
        writeOut(it, e, data);
        it.job.outName = keepName;
      };

      if (TEXT_EXT.has(ext)) {
        const parts =
          ext === ".md" || ext === ".markdown"
            ? splitMarkdown(sample)
            : ext === ".srt" || ext === ".vtt"
              ? splitSubtitles(sample)
              : ext === ".html" || ext === ".htm" || ext === ".xhtml"
                ? splitHtml(sample)
                : splitPlain(sample);
        finish(await translateParts(it, r, parts, false));
      } else if (ext === ".pdf") {
        // Текст PDF разбит на строки по ширине страницы — склеиваем их внутри абзацев.
        const flat = sample.replace(/(?<![.!?:;。！？])\n(?!\n)/g, " ");
        finish(await translateParts(it, r, splitPlain(flat), false));
      } else if (ext === ".docx") {
        finish(
          await zipTranslate(
            it,
            r,
            buf,
            (n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n),
            "docx",
          ),
        );
      } else {
        finish(await zipTranslate(it, r, buf, (n) => /\.(x?html?)$/i.test(n), "html"));
      }
    } finally {
      removePath(filePath);
    }
  });
}

// ─────────────────────────────── изображения ───────────────────────────────

export function startImage(filePath: string, req: Req): Job {
  // Для картинки язык оригинала нужен ДО распознавания (языковые данные Tesseract).
  const src = req.src === "auto" || !isLang(req.src) ? "en" : req.src;
  const it = newJob("image", src, req.tgt);
  return enqueue(it, async () => {
    try {
      it.job.status = "loading";
      if (!isLang(req.tgt)) throw new Error("bad_language");
      const blocks = await recognizeBlocks(fs.readFileSync(filePath), src);
      it.job.total = blocks.length;
      const r: Req = { ...req, src, tgt: req.tgt };
      for (const b of blocks) {
        if (it.ctrl.signal.aborted) throw new Error("cancelled");
        const dst = await translateText(it, r, b.text);
        it.job.blocks.push({ ...b, dst });
        it.job.done = it.job.blocks.length;
      }
    } finally {
      removePath(filePath);
    }
  });
}

/**
 * Перевод через встроенный llama.cpp (GGUF-версия TranslateGemma). Тот же шаблон подсказки,
 * что у ONNX-движка; генерация идёт потоком через /completion, скорость берётся из счётчиков
 * llama-server (timings) — они же питают «токены в секунду» на странице.
 */
import path from "path";
import { consumeSSE } from "../providers/stream";
import { withServer } from "../llamacpp/engine";
import type { ServerInfo } from "../llamacpp/engine";
import { installed, modelPath } from "../llamacpp/models";
import { buildPrompt } from "./engine";
import type { ChunkResult, GenStats } from "./engine";

export const isLlama = (provider: string): boolean => provider === "llamacpp";
const CTX = 4096;

/** Какой GGUF использовать: выбранный или первый установленный TranslateGemma. */
export function pickModel(wanted: string): string {
  const all = installed().map((m) => m.file);
  if (wanted.toLowerCase().endsWith(".gguf") && all.includes(wanted)) return wanted;
  const tg = all.find((f) => /translategemma/i.test(f));
  if (!tg) throw new Error("model_missing");
  return tg;
}

export interface LlamaRun extends ChunkResult {
  server: ServerInfo;
  file: string;
}

export async function ensureLlama(wanted: string): Promise<{ server: ServerInfo; file: string }> {
  const file = pickModel(wanted);
  const server = await withServer({ model: modelPath(file), ctx: CTX, raw: true }, async (s) => s);
  return { server, file };
}

export async function translateLlama(
  wanted: string,
  text: string,
  src: string,
  tgt: string,
  opt: { signal?: AbortSignal; onPartial?: (text: string, stats: GenStats) => void },
): Promise<LlamaRun> {
  const file = pickModel(wanted);
  const prompt = buildPrompt(text, src, tgt).replace(/^<bos>/, ""); // BOS добавит сам сервер
  return withServer({ model: modelPath(file), ctx: CTX, raw: true }, async (server) => {
    const nPredict = Math.min(2048, Math.max(64, Math.ceil(text.length / 2) + 64));
    const res = await fetch(`${server.baseUrl}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opt.signal,
      body: JSON.stringify({
        prompt,
        n_predict: nPredict,
        temperature: 0,
        top_k: 1,
        stream: true,
        cache_prompt: true,
      }),
    });
    if (!res.ok) throw new Error(`llamacpp_${res.status}: ${(await res.text()).slice(0, 200)}`);
    let out = "";
    let n = 0;
    let t0 = 0;
    const tStart = Date.now();
    let timings: { prompt_ms?: number; predicted_ms?: number; predicted_n?: number } | null = null;
    await consumeSSE(
      res.body,
      (j: { content?: string; timings?: typeof timings; tokens_predicted?: number }) => {
        if (j.content) {
          if (!t0) t0 = Date.now();
          out += j.content;
          n++;
          opt.onPartial?.(out.trim(), {
            tokens: n,
            prefillMs: t0 - tStart,
            genMs: Date.now() - t0,
          });
        }
        if (j.timings) timings = j.timings;
      },
    );
    if (opt.signal?.aborted) throw new Error("cancelled");
    const t = timings as { prompt_ms?: number; predicted_ms?: number; predicted_n?: number } | null;
    const stats: GenStats = t
      ? {
          tokens: t.predicted_n ?? n,
          prefillMs: Math.round(t.prompt_ms ?? 0),
          genMs: Math.round(t.predicted_ms ?? 0),
        }
      : { tokens: n, prefillMs: t0 ? t0 - tStart : 0, genMs: t0 ? Date.now() - t0 : 0 };
    return { text: out.trim(), ...stats, server, file: path.basename(file) };
  });
}

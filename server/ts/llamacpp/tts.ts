/**
 * Озвучка через встроенный llama.cpp: `llama-tts` из установленной сборки + Qwen3-TTS (GGUF).
 * Модель понимает русский и клонирует голос по образцу (wav/mp3). Это дополнительный движок
 * к F5-TTS и XTTS: не требует Python и torch, работает на видеокарте любого производителя
 * (Vulkan) и на процессоре, но медленнее F5 на видеокарте NVIDIA.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import logger from "../logger";
import { buildOrder, exePath, type BuildId } from "./engine";
import { installed, modelPath } from "./models";

export interface TtsFiles {
  model: string;
  mmproj: string;
}

/** Установленная пара «основная модель + mmproj» Qwen3-TTS. */
export function ttsFiles(): TtsFiles | null {
  const all = installed().map((m) => m.file);
  const mmproj = all.find((f) => /^mmproj-.*qwen3-tts/i.test(f));
  const model = all.find((f) => /qwen3-tts/i.test(f) && !/^mmproj-/i.test(f));
  return model && mmproj ? { model: modelPath(model), mmproj: modelPath(mmproj) } : null;
}

/** Готов ли движок: пустая строка — да, иначе код причины. */
export function ttsProblem(): string {
  if (!buildOrder("auto").length) return "llama_build_missing";
  if (!ttsFiles()) return "llama_tts_model_missing";
  return "";
}

const ttsExe = (build: BuildId): string | null => {
  const server = exePath(build);
  if (!server) return null;
  const exe = path.join(
    path.dirname(server),
    process.platform === "win32" ? "llama-tts.exe" : "llama-tts",
  );
  return fs.existsSync(exe) ? exe : null;
};

export interface SynthOptions {
  text: string;
  /** Образец голоса (wav/mp3); пусто — голос по умолчанию. */
  ref?: string;
  out: string;
  /** Код языка ISO 639-1; по умолчанию определяется по тексту. */
  lang?: string;
  signal?: AbortSignal;
}

const guessLang = (text: string): string => (/[Ѐ-ӿ]/.test(text) ? "ru" : "en");

function run(exe: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
    let tail = "";
    const add = (d: Buffer): void => {
      tail = (tail + d.toString()).slice(-3000);
    };
    proc.stdout?.on("data", add);
    proc.stderr?.on("data", add);
    const stop = (): void => {
      proc.kill();
    };
    signal?.addEventListener("abort", stop, { once: true });
    proc.once("error", reject);
    proc.once("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(new Error("cancelled"));
      if (code === 0) return resolve();
      reject(new Error(`llama_tts_exit_${code}: ${tail.slice(-300)}`));
    });
  });
}

/** Синтез одного фрагмента в wav. При сбое сборки пробует следующую установленную. */
export async function synth(o: SynthOptions): Promise<void> {
  const files = ttsFiles();
  if (!files) throw new Error("llama_tts_model_missing");
  const builds = buildOrder("auto");
  if (!builds.length) throw new Error("llama_build_missing");
  // Лимит кадров: ~12,5 кадра в секунду речи, ~0,8 кадра на символ; запас против зацикливания.
  const maxFrames = Math.min(4000, Math.ceil(o.text.length * 3) + 100);
  let last: unknown = null;
  for (const build of builds) {
    const exe = ttsExe(build);
    if (!exe) continue;
    const args = [
      "-m",
      files.model,
      "-mm",
      files.mmproj,
      "-p",
      o.text,
      "--tts-lang",
      o.lang || guessLang(o.text),
      "-o",
      o.out,
      "-ngl",
      build === "cpu" ? "0" : "99",
      "-n",
      String(maxFrames),
      "-t",
      String(Math.max(1, Math.floor(os.cpus().length / 2))),
    ];
    if (o.ref) args.push("--tts-speaker-file", o.ref);
    try {
      await run(exe, args, o.signal);
      if (!fs.existsSync(o.out)) throw new Error("llama_tts_no_output");
      return;
    } catch (e) {
      if (String((e as Error).message) === "cancelled") throw e;
      last = e;
      logger.warn("llamacpp.tts_failed", {
        build,
        error: String((e as Error).message).slice(0, 300),
      });
    }
  }
  throw new Error(String((last as Error)?.message || "llama_tts_failed"));
}

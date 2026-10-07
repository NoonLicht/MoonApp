/**
 * Выделено из lecture.ts при разбиении крупного файла (поведение не менялось).
 */
import fs from "fs";
import { spawn } from "child_process";
import path from "path";
import settings from "./settings";
import * as whisperEngine from "./whisperEngine";
import logger from "./logger";

/** Типовые галлюцинации Whisper на тишине/шуме — вырезаем из результата. */
const HALLUCINATION_RE = [
  /^спасибо за просмотр[!.]?$/i,
  /^подпиш(ись|итесь)[!.]?$/i,
  /^amara\.org$/i,
  /^продолжение следует/i,
  /^до новых встреч[!.]?$/i,
  // ВАЖНО: именно пропуски/пунктуация/символы БЕЗ букв. Обычный \W — это
  // [^A-Za-z0-9_], а кириллица для него тоже «не-слово», поэтому прежний
  // /^\W*$/ отбрасывал ЛЮБУЮ русскую расшифровку как «пустую».
  /^[\p{P}\p{S}\s]*$/u,
];
const HALLUCINATION_CONTAINS = [
  "subtitles by",
  "amara.org",
  "спасибо за просмотр",
  "подписывайтесь на канал",
];

/**
 * Один прогон whisper-cli: запуск, ожидание, разбор результата.
 *
 * Перед запуском удаляем прошлый .srt: whisper создаёт файл только когда нашёл
 * текст, поэтому иначе можно прочитать огрызок ПРЕДЫДУЩЕГО прогона (или пустой
 * файл) и решить, что расшифровывать нечего.
 */
export function runWhisper(bin: any, args: any, outBase: any, timeoutMs = 120000) {
  return new Promise<any>((resolve, reject) => {
    const srtPath = outBase + ".srt";
    try {
      fs.rmSync(srtPath, { force: true });
    } catch {
      /* ignore */
    }
    const proc = spawn(bin, args, { windowsHide: true });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      reject(new Error("whisper_timeout"));
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim())
        return reject(new Error(`whisper_exit_${code}: ${stderr.slice(-300)}`));
      resolve(readChunkResult(outBase, stdout));
    });
  });
}

/**
 * Разбор результата прогона: сегменты из SRT, иначе текст из stdout, затем
 * вырезание галлюцинаций. Возвращает { text, segments }.
 */
export function readChunkResult(outBase: any, stdout = "") {
  let text = "";
  let segments: any[] = [];
  try {
    const srtPath = outBase + ".srt";
    if (fs.existsSync(srtPath)) {
      segments = parseSrt(fs.readFileSync(srtPath, "utf8"));
      text = segments
        .map((x) => x.text)
        .join(" ")
        .trim();
    }
  } catch {
    /* ignore */
  }
  if (!text)
    text = String(stdout || "")
      .replace(/\s+/g, " ")
      .trim();
  text = sanitizeText(text);
  segments = segments.map((x) => ({ ...x, text: sanitizeText(x.text) })).filter((x) => x.text);
  return { text, segments };
}

/**
 * HTTP-клиент резидентного whisper-server.exe: POST /inference с multipart
 * (file=WAV, response_format=srt, опционально language/prompt). Используем
 * глобальные fetch/FormData/Blob — есть в Node без зависимостей начиная с
 * версии, на которой собран проект (в package.json запрещённые движки не
 * заданы, а Electron/Node здесь современные).
 */
export async function httpInference(port: any, wavPath: any, opts: Record<string, any> = {}) {
  const buf = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), path.basename(wavPath));
  form.append("response_format", "srt");
  if (opts.language) form.append("language", String(opts.language));
  if (opts.prompt) form.append("prompt", String(opts.prompt));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/inference`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
  } catch (e: any) {
    throw new Error(`whisper_server_request_failed: ${String(e.message || e)}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`whisper_server_http_${res.status}`);
  const body = await res.text();
  return resultFromSrtText(body);
}

/** Разбор ответа резидента (SRT-текст, не файл) — та же логика, что readChunkResult. */
export function resultFromSrtText(srtText: any) {
  let segments: any[] = [];
  let text = "";
  try {
    segments = parseSrt(srtText);
    text = segments
      .map((x) => x.text)
      .join(" ")
      .trim();
  } catch {
    /* ignore */
  }
  if (!text)
    text = String(srtText || "")
      .replace(/\s+/g, " ")
      .trim();
  text = sanitizeText(text);
  segments = segments.map((x) => ({ ...x, text: sanitizeText(x.text) })).filter((x) => x.text);
  return { text, segments };
}

/**
 * Прогон чанка через резидентный whisper-server (модель уже в памяти).
 * Тот же откат без --prompt, что и в CLI-пути. Если сервер не отвечает —
 * ОДНА попытка перезапуска, иначе исключение уходит наверх, и transcribeFile
 * откатывается на обычный whisper-cli для этого чанка (очередь не рвётся).
 */
export async function transcribeViaServer(
  model: any,
  wavPath: any,
  meta: any,
  skipHint: any,
  allowRetry = true,
) {
  const lc = settings.get("lecture");
  const language = String(lc.language || "ru");
  const hint = skipHint ? "" : whisperEngine.initialPrompt();

  const request = async (withPrompt: any) => {
    const handle = await whisperEngine.startWhisperServer(model);
    return httpInference(handle.port, wavPath, { language, prompt: withPrompt ? hint : "" });
  };

  let result;
  try {
    result = await request(!!hint);
  } catch (e: any) {
    // Сервер мог упасть между чанками (или это первый запрос после сбоя) —
    // одна попытка перезапустить и повторить именно этот чанк.
    logger.warn("lecture.chunk.resident_restart", {
      id: meta.id ?? null,
      file: meta.file ?? path.basename(wavPath),
      error: String(e.message || e),
    });
    whisperEngine.stopWhisperServer();
    result = await request(!!hint);
  }

  if (!allowRetry || !whisperEngine.needsPromptlessRetry(result.text, hint))
    return { ...result, promptless: skipHint };
  logger.info("lecture.chunk.retry_no_prompt", {
    id: meta.id ?? null,
    file: meta.file ?? path.basename(wavPath),
    source: meta.source ?? null,
  });
  result = await request(false);
  return { ...result, promptless: true };
}

/**
 * Прогон чанка с откатом: сначала штатно (с подсказкой из настроек), а если
 * движок не нашёл текст — ещё раз БЕЗ --prompt (см. whisperEngine.
 * needsPromptlessRetry). Возвращает { text, segments, promptless }.
 *
 * Зачем отдельной функцией: откат — это правило, а не деталь очереди, и оно
 * проверяется тестом с подставным runner (без реального whisper-cli).
 * Аргументы собирает whisperEngine.transcribeArgs — там же флаги GPU (-ng для
 * CPU-сборки/выключенной видеокарты, -dev N для выбора устройства).
 *
 * Резидентный whisper-server — ОПЦИОНАЛЬНЫЙ путь (настройка useResidentWhisper +
 * whisperEngine.whisperServerAvailable()): если он выключен, недоступен или упал
 * даже после перезапуска — этот чанк уходит по обычному CLI-пути ниже, очередь
 * не останавливается и поведение идентично тому, что было до этой функции.
 *
 * allowRetry=false (черновой прогон streaming-режима, см. draftTranscribe):
 * откат без --prompt намеренно пропускается — черновик и так пересчитывается
 * каждые DRAFT_INTERVAL_MS, второй полный прогон модели на каждый тик удвоил
 * бы нагрузку CPU/GPU ради текста, который через пару секунд всё равно
 * перезапишется свежим тиком (а на закрытии сегмента финальный чанк идёт
 * с allowRetry=true как раньше).
 */
export async function transcribeFile(
  bin: any,
  model: any,
  wavPath: any,
  outBase: any,
  meta: Record<string, any> = {},
  runner = runWhisper,
  allowRetry = true,
) {
  // Если на этой модели подсказка уже выбила пустой ответ, дальше идём сразу без
  // неё: повтор стоит полной загрузки модели, а чанков в лекции сотни.
  const skipHint = whisperEngine.promptUnusableFor(model);

  const lc = settings.get("lecture");
  if (lc.useResidentWhisper === true && whisperEngine.whisperServerAvailable()) {
    try {
      return await transcribeViaServer(model, wavPath, meta, skipHint, allowRetry);
    } catch (e: any) {
      logger.warn("lecture.chunk.resident_fallback_cli", {
        id: meta.id ?? null,
        file: meta.file ?? path.basename(wavPath),
        error: String(e.message || e),
      });
      // падаем в обычный CLI-путь ниже для этого конкретного чанка
    }
  }

  const args = whisperEngine.transcribeArgs(
    model,
    wavPath,
    outBase,
    skipHint ? { prompt: null } : {},
  );
  const result = await runner(bin, args, outBase);
  const hint = skipHint ? "" : whisperEngine.initialPrompt();
  if (!allowRetry || !whisperEngine.needsPromptlessRetry(result.text, hint))
    return { ...result, promptless: skipHint };
  // ОТКАТ БЕЗ ПОДСКАЗКИ. large-v3-turbo на длинную русскую подсказку отвечает
  // пустым SRT: движок грузит модель и через пару секунд молча завершается, а
  // пользователь видит «нечего расшифровывать». Повтор без --prompt даёт текст.
  logger.info("lecture.chunk.retry_no_prompt", {
    id: meta.id ?? null,
    file: meta.file ?? path.basename(wavPath),
    source: meta.source ?? null,
  });
  const retryArgs = whisperEngine.transcribeArgs(model, wavPath, outBase, { prompt: null });
  return { ...(await runner(bin, retryArgs, outBase)), promptless: true };
}

/** Вырезание галлюцинаций и схлопывание зацикленных повторов. */
export function sanitizeText(text: any) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  for (const re of HALLUCINATION_RE) if (re.test(t)) return "";
  const low = t.toLowerCase();
  for (const h of HALLUCINATION_CONTAINS) if (low.includes(h)) return "";
  // Схлопывание циклов: "а б а б а б" → "а б" для окна любой длины (1..6).
  // ВАЖНО: после каждой правки скан перезапускается с n=1. Прежний вариант
  // прекращал работу, если самое короткое окно не дало совпадений, поэтому
  // повтор из двух и более слов («вот так вот так вот так») не находился.
  const words = t.split(" ");
  let changedAny = true;
  let guard = 0;
  while (changedAny && guard++ < 200) {
    changedAny = false;
    for (let n = 1; n <= 6 && !changedAny; n++) {
      for (let i = 0; i + 2 * n <= words.length; i++) {
        const a = words
          .slice(i, i + n)
          .join(" ")
          .toLowerCase();
        let j = i + n;
        while (
          j + n <= words.length &&
          words
            .slice(j, j + n)
            .join(" ")
            .toLowerCase() === a
        )
          j += n;
        if (j > i + n) {
          words.splice(i + n, j - (i + n));
          changedAny = true;
          break;
        }
      }
    }
  }
  return words.join(" ").trim();
}

export function parseSrt(srt: any) {
  const out = [];
  for (const block of String(srt).replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const m = lines.find((l) => l.includes("-->"));
    if (!m) continue;
    // Берём время ЦЕЛИКОМ (с миллисекундами после запятой): раньше
    // split(",")[0] отбрасывал доли секунды, и все сегменты «округлялись» до
    // целой секунды. Хвостовые настройки (position:…) отсекаются.
    const parts = m.split("-->").map((x) => x.trim().split(/\s+/)[0]);
    const a = parts[0],
      b = parts[1];
    const text = lines
      .slice(lines.indexOf(m) + 1)
      .join(" ")
      .trim();
    out.push({ start: srtTimeToSec(a), end: srtTimeToSec(b), text });
  }
  return out;
}

/** "00:00:02,500" / "00:00:02.500" → секунды (с миллисекундами). */
function srtTimeToSec(t: any) {
  const m = /(\d+):(\d+):(\d+)[,.](\d{1,3})/.exec(String(t));
  if (m) {
    const ms = Number(m[4].padEnd(3, "0"));
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
  }
  // Фолбэк для времени без долей секунды.
  const [h, min, s] = String(t)
    .split(":")
    .map((x) => parseFloat(x) || 0);
  return h * 3600 + min * 60 + s;
}

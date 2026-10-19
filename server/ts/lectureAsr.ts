/**
 * Общая точка расшифровки для лекций и быстрых заметок: GigaAM v3 (ONNX) или
 * Whisper GGUF (transcribe.cpp, см. asrGguf.ts) плюс чистка результата.
 */
import path from "path";
import settings from "./settings";
import * as asrGguf from "./asrGguf";
import * as gigaam from "./gigaamEngine";
import logger from "./logger";

/**
 * Каким движком расшифровывать: GigaAM v3 или Whisper GGUF.
 * GigaAM — если модель скачана и (выбрана по умолчанию и язык русский) либо
 * Whisper-модели нет: пользователь без Whisper не остаётся без речи.
 */
export function useGigaam(): boolean {
  if (!gigaam.isInstalled() || !gigaam.runtimeAvailable()) return false;
  if (!asrGguf.isInstalled()) return true;
  return gigaam.preferred() === "gigaam" && gigaam.languageSupported();
}

/** Есть ли чем расшифровывать: скачанный GigaAM или Whisper GGUF. */
export function asrReady(): boolean {
  return (
    (gigaam.isInstalled() && gigaam.runtimeAvailable()) ||
    (asrGguf.isInstalled() && asrGguf.runtimeAvailable())
  );
}

/** Какой движок расшифрует следующий чанк. */
export function activeAsr(): "gigaam" | "whisper" | null {
  if (!asrReady()) return null;
  if (useGigaam()) return "gigaam";
  return asrGguf.isInstalled() ? "whisper" : null;
}

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
 * Расшифровка WAV: GigaAM или Whisper GGUF. Для Whisper подсказка из настроек
 * (академический словарь) идёт в initial prompt; если с ней текст пустой, один
 * раз повторяем без неё (на длинную подсказку часть моделей отвечает пустотой).
 * Возвращает { text, segments, promptless }.
 */
export async function transcribeFile(
  wavPath: string,
  meta: Record<string, any> = {},
  allowRetry = true,
) {
  if (useGigaam()) {
    try {
      const r = await gigaam.transcribeWav(wavPath);
      return { text: sanitizeText(r.text), segments: r.segments, promptless: true };
    } catch (e: any) {
      if (!asrGguf.isInstalled()) throw e;
      logger.warn("lecture.chunk.gigaam_fallback_whisper", {
        id: meta.id ?? null,
        file: meta.file ?? path.basename(wavPath),
        error: String(e.message || e),
      });
    }
  }
  const lc = settings.get("lecture");
  const language = String(lc.language || "ru");
  const hint = String(lc.initialPrompt || "");
  const clean = (r: { text: string; segments: any[] }) => ({
    text: sanitizeText(r.text),
    segments: r.segments.map((x) => ({ ...x, text: sanitizeText(x.text) })).filter((x) => x.text),
  });
  let res = clean(await asrGguf.transcribeWav(wavPath, { language, prompt: hint }));
  if (res.text || !hint || !allowRetry) return { ...res, promptless: !hint };
  logger.info("lecture.chunk.retry_no_prompt", {
    id: meta.id ?? null,
    file: meta.file ?? path.basename(wavPath),
    source: meta.source ?? null,
  });
  res = clean(await asrGguf.transcribeWav(wavPath, { language }));
  return { ...res, promptless: true };
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

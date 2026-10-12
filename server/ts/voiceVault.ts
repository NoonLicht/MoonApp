/**
 * Voice Vault: поиск по всем голосовым записям (лекции, быстрые заметки) с
 * воспроизведением нужного отрезка. Поиск — общий семантический индекс; здесь
 * только привязка найденного места к аудиофрагментам.
 */

export interface VaultChunk {
  id: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface VaultSegment {
  /** Чанки по порядку: проигрываются подряд. */
  chunkIds: number[];
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Отрезок вокруг момента atMs: чанк, содержащий момент (или ближайший
 * следующий), и следующие за ним, пока суммарный текст не превысит maxChars.
 */
export function segmentFor(chunks: VaultChunk[], atMs: number, maxChars = 700): VaultSegment | null {
  const sorted = chunks
    .filter((c) => String(c.text ?? "").trim())
    .sort((a, b) => a.start_ms - b.start_ms);
  if (!sorted.length) return null;
  let i = sorted.findIndex((c) => c.start_ms <= atMs && atMs < c.end_ms);
  if (i < 0) i = sorted.findIndex((c) => c.start_ms >= atMs);
  if (i < 0) i = sorted.length - 1;
  const picked: VaultChunk[] = [];
  let len = 0;
  for (let k = i; k < sorted.length; k++) {
    const t = String(sorted[k].text).trim();
    if (picked.length && len + t.length > maxChars) break;
    picked.push(sorted[k]);
    len += t.length + 1;
  }
  return {
    chunkIds: picked.map((c) => c.id),
    startMs: picked[0].start_ms,
    endMs: picked[picked.length - 1].end_ms,
    text: picked.map((c) => String(c.text).trim()).join(" "),
  };
}

export interface VaultHit {
  kind: "lecture" | "quick";
  ref: string;
  title: string;
  /** Фрагмент текста (из индекса или из отрезка). */
  snippet: string;
  score: number;
  startMs: number;
  endMs: number;
  /** Для лекции — чанки для последовательного воспроизведения. */
  chunkIds: number[];
  /** Для быстрой заметки — готовая ссылка на аудио, если оно сохранено. */
  audioUrl: string | null;
}

/** Подсветка запроса в тексте: возвращает окно вокруг первого найденного слова. */
export function excerpt(text: string, query: string, width = 220): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= width) return t;
  const words = String(query ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  const low = t.toLowerCase();
  let pos = -1;
  for (const w of words) {
    const stem = w.length > 5 ? w.slice(0, w.length - 2) : w;
    const p = low.indexOf(stem);
    if (p >= 0 && (pos < 0 || p < pos)) pos = p;
  }
  if (pos < 0) return t.slice(0, width) + "…";
  const from = Math.max(0, pos - Math.floor(width / 3));
  return (from > 0 ? "…" : "") + t.slice(from, from + width) + (from + width < t.length ? "…" : "");
}

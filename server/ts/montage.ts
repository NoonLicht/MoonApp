/**
 * «Сшивка по смыслу»: по запросу («собери всё, где мы обсуждали бюджет»)
 * находит отрезки записей и склеивает их в один аудиофайл с паузами и
 * списком «что откуда». Поиск — общий (Voice Vault); здесь план монтажа и
 * аргументы ffmpeg. Монтируется звук записей лекций и голосовых заметок.
 */

export interface Clip {
  title: string;
  /** Откуда: ключ записи (id лекции). */
  ref: string;
  startMs: number;
  endMs: number;
  chunkIds: number[];
  snippet: string;
  score: number;
  /** Пути к WAV чанков в порядке воспроизведения. */
  files?: string[];
}

export type Order = "relevance" | "chronological";

/** Выбирает клипы до лимита длительности; дубли и пересечения внутри записи отбрасываются. */
export function planMontage(clips: Clip[], o: { maxSeconds?: number; order?: Order; maxClips?: number } = {}): Clip[] {
  const budget = (o.maxSeconds ?? 600) * 1000;
  const maxClips = o.maxClips ?? 24;
  const taken: Clip[] = [];
  let total = 0;
  const byScore = [...clips].sort((a, b) => b.score - a.score);
  for (const c of byScore) {
    if (taken.length >= maxClips) break;
    if (c.endMs <= c.startMs || !c.chunkIds.length) continue;
    const overlap = taken.some((t) => t.ref === c.ref && c.startMs < t.endMs && c.endMs > t.startMs);
    if (overlap) continue;
    const dur = c.endMs - c.startMs;
    if (total + dur > budget && taken.length > 0) continue;
    taken.push(c);
    total += dur;
  }
  if ((o.order ?? "relevance") === "chronological") {
    taken.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }) || a.startMs - b.startMs);
  }
  return taken;
}

export function totalSeconds(clips: Clip[]): number {
  return Math.round(clips.reduce((s, c) => s + (c.endMs - c.startMs), 0) / 1000);
}

/** Аргументы ffmpeg: все файлы → один моно-поток 16 кГц, пауза gapSec после каждого клипа. */
export function ffmpegArgs(inputs: string[], output: string, gapSec = 0.8): string[] {
  if (!inputs.length) throw new Error("no_inputs");
  const args = ["-hide_banner", "-y"];
  for (const f of inputs) args.push("-i", f);
  const parts = inputs.map(
    (_, i) => `[${i}:a]aresample=16000,aformat=sample_fmts=fltp:channel_layouts=mono,apad=pad_dur=${gapSec}[a${i}]`,
  );
  const labels = inputs.map((_, i) => `[a${i}]`).join("");
  args.push("-filter_complex", `${parts.join(";")};${labels}concat=n=${inputs.length}:v=0:a=1[out]`);
  args.push("-map", "[out]");
  if (/\.mp3$/i.test(output)) args.push("-c:a", "libmp3lame", "-q:a", "3");
  else args.push("-c:a", "pcm_s16le");
  args.push(output);
  return args;
}

const stamp = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/** Список «что откуда» с позициями в итоговом файле (паузы учитываются). */
export function captions(clips: Clip[], gapSec = 0.8): { at: string; title: string; from: string; snippet: string }[] {
  let t = 0;
  return clips.map((c) => {
    const row = { at: stamp(t * 1000), title: c.title, from: stamp(c.startMs), snippet: c.snippet };
    t += (c.endMs - c.startMs) / 1000 + gapSec;
    return row;
  });
}

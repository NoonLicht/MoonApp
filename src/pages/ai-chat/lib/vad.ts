/**
 * Простой детектор речи по уровню громкости для голосового режима чата.
 *
 * На вход — уровень (RMS, 0..1) кадров с отметкой времени, на выходе события:
 *  - "start"   — речь началась (громко подряд не меньше startFrames кадров);
 *  - "end"     — пауза не короче silenceMs, фраза закончилась и была не короче minSpeechMs;
 *  - "discard" — всплеск короче minSpeechMs (щелчок, кашель) — запись выбросить.
 *
 * Порог адаптивный: оценка шума подстраивается под тихие кадры, чтобы
 * вентилятор или фоновый гул не считались речью.
 */
export interface VadOptions {
  /** Во сколько раз громче шума считается речью. */
  ratio?: number;
  /** Нижняя граница порога (абсолютная), чтобы тишина не считалась речью. */
  floor?: number;
  startFrames?: number;
  silenceMs?: number;
  minSpeechMs?: number;
}

export type VadEvent = "start" | "end" | "discard" | null;

export class VadTracker {
  private noise = 0.005;
  private loudRun = 0;
  private speaking = false;
  private speechStart = 0;
  private lastLoud = 0;
  private o: Required<VadOptions>;

  constructor(opts: VadOptions = {}) {
    this.o = {
      ratio: opts.ratio ?? 3,
      floor: opts.floor ?? 0.02,
      startFrames: opts.startFrames ?? 3,
      silenceMs: opts.silenceMs ?? 900,
      minSpeechMs: opts.minSpeechMs ?? 350,
    };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get threshold(): number {
    return Math.max(this.o.floor, this.noise * this.o.ratio);
  }

  push(level: number, t: number): VadEvent {
    const loud = level >= this.threshold;
    if (!loud && !this.speaking) {
      // Оценка шума: плавное скользящее среднее по тихим кадрам.
      this.noise = this.noise * 0.95 + level * 0.05;
    }
    if (loud) {
      this.loudRun++;
      this.lastLoud = t;
    } else if (!this.speaking) {
      this.loudRun = 0;
    }

    if (!this.speaking) {
      if (this.loudRun >= this.o.startFrames) {
        this.speaking = true;
        this.speechStart = t;
        return "start";
      }
      return null;
    }

    if (!loud && t - this.lastLoud >= this.o.silenceMs) {
      const length = this.lastLoud - this.speechStart;
      this.speaking = false;
      this.loudRun = 0;
      return length >= this.o.minSpeechMs ? "end" : "discard";
    }
    return null;
  }

  reset(): void {
    this.speaking = false;
    this.loudRun = 0;
  }
}

/** Делит текст на предложения для озвучки кусками (так прерывание срабатывает быстро). */
export function splitForSpeech(text: string, maxLen = 220, codeLabel = ""): string[] {
  const plain = text
    .replace(/```[\s\S]*?```/g, ` ${codeLabel} `)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/[*_~>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const out: string[] = [];
  for (const sentence of plain.split(/(?<=[.!?…])\s+/)) {
    let s = sentence.trim();
    while (s.length > maxLen) {
      const cut = s.lastIndexOf(" ", maxLen);
      const at = cut > maxLen / 2 ? cut : maxLen;
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

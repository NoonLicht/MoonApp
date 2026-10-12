import { describe, it, expect } from "vitest";
import { VadTracker, splitForSpeech } from "../src/pages/ai-chat/lib/vad";

/** Детектор речи и нарезка текста для озвучки (src/pages/ai-chat/lib/vad.ts). */
function run(vad: VadTracker, frames: number[], stepMs = 50, from = 0) {
  const events: [string, number][] = [];
  frames.forEach((lvl, i) => {
    const t = from + i * stepMs;
    const e = vad.push(lvl, t);
    if (e) events.push([e, t]);
  });
  return events;
}
const rep = (v: number, n: number) => Array(n).fill(v);

describe("VadTracker", () => {
  it("речь → пауза даёт start и end", () => {
    const vad = new VadTracker();
    const ev = run(vad, [...rep(0.003, 10), ...rep(0.2, 20), ...rep(0.003, 30)]);
    expect(ev.map((e) => e[0])).toEqual(["start", "end"]);
    // конец — не раньше, чем через silenceMs после последнего громкого кадра
    expect(ev[1][1] - (10 + 19) * 50).toBeGreaterThanOrEqual(900);
  });

  it("короткий щелчок выбрасывается", () => {
    const vad = new VadTracker({ startFrames: 2, minSpeechMs: 400 });
    const ev = run(vad, [...rep(0.003, 5), ...rep(0.3, 3), ...rep(0.003, 30)]);
    expect(ev.map((e) => e[0])).toEqual(["start", "discard"]);
  });

  it("стабильный шум не считается речью (порог подстраивается)", () => {
    const vad = new VadTracker();
    const ev = run(vad, rep(0.015, 200));
    expect(ev).toEqual([]);
  });

  it("одиночный громкий кадр не запускает речь", () => {
    const vad = new VadTracker();
    expect(run(vad, [0.003, 0.3, 0.003, 0.003, 0.3, 0.003])).toEqual([]);
  });

  it("короткие паузы внутри фразы не обрывают её", () => {
    const vad = new VadTracker();
    const ev = run(vad, [
      ...rep(0.003, 5),
      ...rep(0.2, 10),
      ...rep(0.003, 6), // 300 мс паузы
      ...rep(0.2, 10),
      ...rep(0.003, 30),
    ]);
    expect(ev.map((e) => e[0])).toEqual(["start", "end"]);
  });
});

describe("splitForSpeech", () => {
  it("режет по предложениям, убирает разметку и код", () => {
    const text = "# Заголовок\nПервое предложение. Второе **важное**!\n```js\nx=1\n```\nТретье?";
    expect(splitForSpeech(text, 220, "[код]")).toEqual([
      "Заголовок Первое предложение.",
      "Второе важное!",
      "[код] Третье?",
    ]);
    // без подписи блок кода просто пропускается
    expect(splitForSpeech(text)).toEqual(["Заголовок Первое предложение.", "Второе важное!", "Третье?"]);
  });

  it("длинное предложение делится по пробелу не длиннее лимита", () => {
    const long = Array(60).fill("слово").join(" ");
    const parts = splitForSpeech(long, 100);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(" ")).toBe(long);
  });
});

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { tNow } from "@/app/i18n";
import { VadTracker, splitForSpeech } from "@/pages/ai-chat/lib/vad";

export type VoiceState = "off" | "listening" | "hearing" | "thinking" | "speaking" | "error";

/**
 * Голосовой режим чата: микрофон слушает постоянно, фраза определяется по
 * паузе, уходит на локальное распознавание (whisper) и отправляется в чат;
 * ответ озвучивается кусками. Если пользователь начинает говорить, пока идёт
 * озвучка, она сразу прерывается — можно перебивать ассистента.
 *
 * Эхо: включено шумоподавление/эхоподавление браузера, а пока ассистент
 * говорит, порог речи поднят — иначе озвучка «слышала бы» сама себя.
 */
export function useVoiceMode(opts: {
  messages: { role: "user" | "assistant"; text: string }[];
  sending: boolean;
  lang: string;
  onUtterance: (text: string) => void;
}): { state: VoiceState; error: string; toggle: () => void; interrupt: () => void } {
  const [state, setState] = useState<VoiceState>("off");
  const [error, setError] = useState("");
  const on = state !== "off" && state !== "error";

  const o = useRef(opts);
  o.current = opts;
  const speakingRef = useRef(false);
  const spokenFor = useRef(0);
  const stateRef = useRef<VoiceState>("off");
  const set = (s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  };

  const interrupt = useCallback(() => {
    speechSynthesis.cancel();
    speakingRef.current = false;
    if (stateRef.current === "speaking") set("listening");
  }, []);

  // --- микрофон + детектор речи + запись фраз ---
  const stop = useRef<(() => void) | null>(null);
  const start = useCallback(async () => {
    setError("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      setError((e as Error).message || "mic_denied");
      set("error");
      return;
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const vad = new VadTracker();
    let rec: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let alive = true;

    const finishUtterance = async (blob: Blob) => {
      set("thinking");
      try {
        const { text } = await api.quickNotesTranscribe(blob);
        if (text.trim()) o.current.onUtterance(text.trim());
        if (stateRef.current === "thinking") set("listening");
      } catch (e) {
        setError((e as Error).message);
        if (stateRef.current === "thinking") set("listening");
      }
    };

    const tick = window.setInterval(() => {
      if (!alive) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      let level = Math.sqrt(sum / buf.length);
      // Пока ассистент говорит, считаем только заметно громкую речь.
      if (speakingRef.current) level *= 0.5;
      const ev = vad.push(level, performance.now());
      if (ev === "start") {
        if (speakingRef.current) interrupt(); // перебили ассистента
        chunks = [];
        rec = new MediaRecorder(stream);
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.start();
        set("hearing");
      } else if (ev === "end" && rec) {
        const r = rec;
        rec = null;
        r.onstop = () => void finishUtterance(new Blob(chunks, { type: r.mimeType || "audio/webm" }));
        r.stop();
      } else if (ev === "discard" && rec) {
        const r = rec;
        rec = null;
        r.onstop = () => undefined;
        r.stop();
        set("listening");
      }
    }, 50);

    stop.current = () => {
      alive = false;
      window.clearInterval(tick);
      try {
        rec?.stop();
      } catch {
        /* уже остановлен */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      speechSynthesis.cancel();
      speakingRef.current = false;
    };
    // Старые ответы не озвучиваем — только те, что придут после включения.
    spokenFor.current = o.current.messages.length;
    set("listening");
  }, [interrupt]);

  const toggle = useCallback(() => {
    if (stateRef.current === "off" || stateRef.current === "error") void start();
    else {
      stop.current?.();
      stop.current = null;
      set("off");
    }
  }, [start]);

  useEffect(
    () => () => {
      stop.current?.();
    },
    [],
  );

  // --- озвучка нового ответа ---
  useEffect(() => {
    if (!on || opts.sending) return;
    const msgs = opts.messages;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant" || !last.text.trim()) return;
    if (spokenFor.current === msgs.length) return;
    spokenFor.current = msgs.length;
    const parts = splitForSpeech(last.text, 220, tNow("aichat.voiceCodeSkipped"));
    if (!parts.length) return;
    speechSynthesis.cancel();
    speakingRef.current = true;
    set("speaking");
    const lang = o.current.lang === "ru" ? "ru-RU" : "en-US";
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      u.lang = lang;
      if (i === parts.length - 1) {
        u.onend = () => {
          speakingRef.current = false;
          if (stateRef.current === "speaking") set("listening");
        };
      }
      speechSynthesis.speak(u);
    });
  }, [on, opts.sending, opts.messages]);

  return { state, error, toggle, interrupt };
}

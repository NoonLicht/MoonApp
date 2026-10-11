/**
 * Мост между окном приложения и веб-компаньоном (телефон).
 *
 * Плееры живут в окне (HTML-элементы audio/video), поэтому сервер не может ими
 * управлять напрямую: окно периодически сообщает серверу, что играет, и забирает
 * очередь команд («пауза», «перемотать на 10 с», «громче»…), которые прислал телефон.
 *
 * Пока компаньон выключен, мост делает лишь редкий запрос статуса (раз в 5 секунд) —
 * частый опрос включается только когда сервер компаньона запущен.
 */
import { api } from "@/api/client";
import type { CompanionCommand, CompanionPlayerState } from "@/api/apiCompanion";

let lastMedia: HTMLMediaElement | null = null;

/** Какой элемент считаем «текущим»: играющий, иначе последний, с которым что-то делали. */
function currentMedia(): HTMLMediaElement | null {
  const all = Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio"));
  const playing = all.find((m) => !m.paused && !m.ended && m.readyState > 0);
  if (playing) return playing;
  return lastMedia && document.contains(lastMedia) ? lastMedia : null;
}

function titleOf(m: HTMLMediaElement): string {
  const meta = navigator.mediaSession?.metadata;
  if (meta?.title) return [meta.title, meta.artist].filter(Boolean).join(" — ");
  const marked = m.closest("[data-media-title]")?.getAttribute("data-media-title");
  return marked || document.querySelector(".tb-title")?.textContent?.trim() || "";
}

export function readState(m: HTMLMediaElement): CompanionPlayerState {
  return {
    title: titleOf(m),
    paused: m.paused,
    position: Number.isFinite(m.currentTime) ? m.currentTime : 0,
    duration: Number.isFinite(m.duration) ? m.duration : 0,
    volume: m.volume,
    muted: m.muted,
  };
}

/** Выполнить команду телефона над элементом плеера. */
export function applyCommand(m: HTMLMediaElement, c: CompanionCommand): void {
  const v = c.value ?? 0;
  switch (c.cmd) {
    case "play":
      void m.play().catch(() => undefined);
      break;
    case "pause":
      m.pause();
      break;
    case "toggle":
      if (m.paused) void m.play().catch(() => undefined);
      else m.pause();
      break;
    case "seek":
      m.currentTime = Math.max(0, Math.min(Number.isFinite(m.duration) ? m.duration : Infinity, m.currentTime + v));
      break;
    case "volume":
      m.volume = Math.max(0, Math.min(1, m.volume + v));
      m.muted = false;
      break;
    case "mute":
      m.muted = !m.muted;
      break;
  }
}

/** Запускает мост; возвращает функцию остановки. */
export function startCompanionBridge(): () => void {
  let stopped = false;
  let running = false;
  let fast: number | null = null;
  let lastSent = "";
  let lastSentAt = 0;

  const remember = (e: Event) => {
    if (e.target instanceof HTMLMediaElement) lastMedia = e.target;
  };
  document.addEventListener("play", remember, true);

  const tick = async () => {
    if (stopped || !running) return;
    const m = currentMedia();
    try {
      const state = m ? readState(m) : null;
      // Позицию меняем постоянно — отправляем не чаще раза в 2 с, остальное — сразу.
      const key = JSON.stringify(state ? { ...state, position: 0 } : null);
      const now = Date.now();
      if (key !== lastSent || now - lastSentAt > 2000) {
        lastSent = key;
        lastSentAt = now;
        await api.companionPlayerState(state);
      }
      const cmds = await api.companionCommands();
      const target = currentMedia();
      if (target) cmds.forEach((c) => applyCommand(target, c));
    } catch {
      /* сервер перезапускается — следующий тик повторит */
    }
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const st = await api.companionStatus();
      if (st.running && !running) {
        running = true;
        fast = window.setInterval(() => void tick(), 1000);
      } else if (!st.running && running) {
        running = false;
        if (fast) window.clearInterval(fast);
        fast = null;
        lastSent = "";
      }
    } catch {
      /* сервер ещё поднимается */
    }
  };
  void poll();
  const slow = window.setInterval(() => void poll(), 5000);

  return () => {
    stopped = true;
    window.clearInterval(slow);
    if (fast) window.clearInterval(fast);
    document.removeEventListener("play", remember, true);
  };
}

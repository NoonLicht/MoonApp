/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { BASE, pageHeaders, tokenHeaders } from "@/api/apiHttp";

/** Событие стрима чата. */
export interface StreamEvent {
  type: "token" | "done" | "error" | "meta";
  text?: string;
  message?: string;
  side?: "a" | "b";
  model?: string;
  title?: string;
  stats?: { ms: number; chars: number; tokensApprox: number };
}

/**
 * Общий приём SSE-потока (POST + разбор событий «data: {...}» по разделителю \n\n).
 *
 * Раньше обычная отправка в чат и арена копировали этот блок один-в-один (~40 строк):
 * обработку 409/401, упаковку пакетов и пропуск битого JSON. Поведение обязано быть
 * общим: один неверный кадр не должен ронять весь ответ, а конфликт/неавторизация —
 * приходить понятным текстом, а не «HTTP 409».
 */
async function postStream(
  path: string,
  body: unknown,
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...tokenHeaders(), ...pageHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 409 || res.status === 401) {
    let msg = "Ошибка";
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* keep */
    }
    throw new Error(msg);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload) as StreamEvent);
      } catch {
        /* skip */
      }
    }
  }
}

/** Потоковая отправка в чат. onEvent({type:'token'|'done'|'error'|'meta'}). */
export function streamChatSend(
  conversationId: number,
  body: {
    text: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    images?: string[];
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    systemPrompt?: string;
  },
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return postStream(`/api/chat/${conversationId}/send`, body, onEvent, signal);
}

/** Arena: один вопрос двум моделям параллельно. События помечены side: "a"|"b". */
export function streamArena(
  conversationId: number,
  body: {
    text: string;
    models: [string, string];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    systemPrompt?: string;
    images?: string[];
    persist?: boolean;
  },
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return postStream(`/api/chat/${conversationId}/arena`, body, onEvent, signal);
}

/**
 * API помощника в «Документах» и «Таблицах» (server/ts/assistant): ход модели с инструментами
 * потоком NDJSON, поиск в интернете и чтение страниц.
 */
import { BASE, pageHeaders, req, tokenHeaders } from "@/api/apiHttp";

export interface AssistantToolCall {
  id: string;
  name: string;
  /** JSON-строка аргументов, как её выдала модель. */
  arguments: string;
  /** Номер вызова в ответе модели. */
  index?: number;
}

export interface AssistantMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: AssistantToolCall[];
  tool_call_id?: string;
  /** data:-ссылки картинок (только у user). */
  images?: string[];
}

export interface AssistantToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AssistantTurnResult {
  content: string;
  toolCalls: AssistantToolCall[];
  finish: string;
  model: string;
}

export interface AssistantTurnHandlers {
  onToken?: (d: string) => void;
  onThinking?: (d: string) => void;
  /** Аргументы вызова инструмента растут: очередной кусок JSON. */
  onToolArgs?: (index: number, name: string, args: string) => void;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSettings {
  searxng: string;
  hasBrave: boolean;
}

export const assistantApi = {
  /** Один ход модели. Текст приходит по мере генерации; итог — в возвращаемом значении. */
  assistantTurn: async (
    body: {
      model?: string;
      messages: AssistantMessage[];
      tools?: AssistantToolSpec[];
      maxTokens?: number;
      temperature?: number;
      think?: boolean;
    },
    h: AssistantTurnHandlers = {},
    signal?: AbortSignal,
  ): Promise<AssistantTurnResult> => {
    const res = await fetch(`${BASE}/api/llamacpp/assistant/turn`, {
      method: "POST",
      headers: { ...tokenHeaders(), ...pageHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error || msg;
      } catch {
        /* оставляем код */
      }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let result: AssistantTurnResult | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as {
          t: string;
          d?: string;
          i?: number;
          name?: string;
          error?: string;
        } & Partial<AssistantTurnResult>;
        if (e.t === "token" && e.d) h.onToken?.(e.d);
        else if (e.t === "thinking" && e.d) h.onThinking?.(e.d);
        else if (e.t === "toolArgs" && e.name && e.d) h.onToolArgs?.(e.i ?? 0, e.name, e.d ?? "");
        else if (e.t === "error") throw new Error(e.error || "assistant_error");
        else if (e.t === "done")
          result = {
            content: e.content ?? "",
            toolCalls: e.toolCalls ?? [],
            finish: e.finish ?? "",
            model: e.model ?? "",
          };
      }
    }
    if (!result) throw new Error("assistant_no_answer");
    return result;
  },
  /** Нарисовать картинку моделью Qwen-Image (минуты на 8 ГБ видеокарте); ответ — PNG. */
  assistantImage: async (
    body: { prompt: string; width?: number; height?: number; model?: string },
    signal?: AbortSignal,
  ): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/llamacpp/sd/generate`, {
      method: "POST",
      headers: { ...tokenHeaders(), ...pageHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error || msg;
      } catch {
        /* оставляем код */
      }
      throw new Error(msg);
    }
    return res.blob();
  },
  assistantWebSearch: (q: string, lang: string, limit = 6) =>
    req<{ provider: string; hits: WebSearchHit[] }>("POST", "/llamacpp/assistant/web/search", {
      q,
      lang,
      limit,
    }),
  assistantWebFetch: (url: string, offset = 0, maxChars = 9000) =>
    req<{ url: string; title: string; text: string; total: number; next: number | null }>(
      "POST",
      "/llamacpp/assistant/web/fetch",
      { url, offset, maxChars },
    ),
  assistantWebSettings: () => req<WebSettings>("GET", "/llamacpp/assistant/web/settings"),
  assistantSetWebSettings: (p: { searxng?: string; braveKey?: string }) =>
    req<WebSettings>("POST", "/llamacpp/assistant/web/settings", p),
};

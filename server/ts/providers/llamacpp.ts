import type { ChatParams, Provider } from "./types";
import { consumeSSE } from "./stream";
import { withServer } from "../llamacpp/engine";
import { chatModels, resolve, type Task } from "../llamacpp/router";
import { fitHistory } from "../llamacpp/fit";

/**
 * Локальные модели через встроенный llama.cpp (см. server/ts/llamacpp). Ключ не нужен: провайдер
 * всегда «настроен» (security.getSecret возвращает метку), а моделью служит имя .gguf-файла.
 * Запрос идёт напрямую на 127.0.0.1 — в обход прокси страницы.
 */
const CTX = 16384;

/** Для чата подходят только языковые модели: эмбеддинги, проекторы, OCR и озвучка — нет. */
const listChat = (): string[] => chatModels().map((m) => m.file);

const provider: Provider = {
  id: "llamacpp",
  label: "llama.cpp (локально)",
  models: [],
  local: true,
  async listModels() {
    return listChat();
  },
  async chat(p: ChatParams): Promise<string> {
    const wantImages = p.messages.some((m) => Array.isArray(m.images) && m.images.length > 0);
    // Пустая модель или "auto" — подбирает маршрутизатор под задачу из списка скачанных.
    const task = ((p as { task?: Task }).task ?? "chat") as Task;
    const r = resolve(task, p.model || "", wantImages);
    if (!r) throw new Error("llamacpp_model_missing");
    // Окно контекста — общее на промпт и ответ: просим не больше половины, а историю
    // подрезаем с начала, иначе llama-server отвечает ошибкой/пустотой, когда не влезает.
    const maxTokens = Math.max(64, Math.min(Number(p.maxTokens) || 1024, Math.floor(CTX / 2)));
    const messages = fitHistory(p.messages, CTX - maxTokens - 256);
    return withServer({ model: r.model, mmproj: r.mmproj, device: r.device, ctx: CTX, task }, async (s) => {
      const body: Record<string, unknown> = {
        messages: messages.map((m) => {
          const imgs = Array.isArray(m.images) ? m.images : [];
          if (!imgs.length) return { role: m.role, content: m.text };
          return {
            role: m.role,
            content: [
              ...imgs.map((url) => ({ type: "image_url", image_url: { url } })),
              { type: "text", text: m.text },
            ],
          };
        }),
        temperature: p.temperature,
        max_tokens: maxTokens,
        stream: true,
      };
      if (p.topP !== undefined) body.top_p = p.topP;
      if (p.frequencyPenalty !== undefined) body.frequency_penalty = p.frequencyPenalty;
      if (p.presencePenalty !== undefined) body.presence_penalty = p.presencePenalty;
      if (p.stop) body.stop = Array.isArray(p.stop) ? p.stop : [p.stop];
      const res = await fetch(`${s.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: p.signal,
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new Error(`llamacpp error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      let full = "";
      let thinking = "";
      let streamError = "";
      let finish = "";
      await consumeSSE(
        res.body,
        (j: {
          error?: { message?: string } | string;
          choices?: {
            finish_reason?: string | null;
            delta?: { content?: string; reasoning_content?: string };
          }[];
        }) => {
          // Ошибки llama-server в потоке приходят как {"error":…} — раньше они молча терялись.
          if (j.error) {
            streamError = typeof j.error === "string" ? j.error : (j.error.message ?? "error");
            return;
          }
          const c = j.choices?.[0];
          if (c?.finish_reason) finish = c.finish_reason;
          const d = c?.delta?.content;
          if (d) {
            full += d;
            if (p.stream) p.onToken?.(d);
          }
          if (c?.delta?.reasoning_content) thinking += c.delta.reasoning_content;
        },
      );
      if (streamError) throw new Error(`llamacpp error: ${streamError.slice(0, 300)}`);
      if (!full.trim()) {
        // Модель «думала» и упёрлась в лимит токенов: отдаём хотя бы рассуждение, а не пустоту.
        if (thinking.trim()) {
          if (p.stream) p.onToken?.(thinking);
          return thinking;
        }
        throw new Error(`llamacpp_empty_response${finish ? ` (${finish})` : ""}`);
      }
      return full;
    });
  },
};

export = provider;

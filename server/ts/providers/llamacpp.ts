import type { ChatParams, Provider } from "./types";
import { consumeSSE } from "./stream";
import { withServer } from "../llamacpp/engine";
import { hasModel, installed, modelPath } from "../llamacpp/models";

/**
 * Локальные модели через встроенный llama.cpp (см. server/ts/llamacpp). Ключ не нужен: провайдер
 * всегда «настроен» (security.getSecret возвращает метку), а моделью служит имя .gguf-файла.
 * Запрос идёт напрямую на 127.0.0.1 — в обход прокси страницы.
 */
const CTX = 8192;

const provider: Provider = {
  id: "llamacpp",
  label: "llama.cpp (локально)",
  models: [],
  local: true,
  async listModels() {
    return installed().map((m) => m.file);
  },
  async chat(p: ChatParams): Promise<string> {
    const file = p.model || installed()[0]?.file || "";
    if (!file || !hasModel(file)) throw new Error("llamacpp_model_missing");
    return withServer({ model: modelPath(file), ctx: CTX }, async (s) => {
      const body: Record<string, unknown> = {
        messages: p.messages.map((m) => {
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
        max_tokens: p.maxTokens,
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
      await consumeSSE(res.body, (j: { choices?: { delta?: { content?: string } }[] }) => {
        const d = j.choices?.[0]?.delta?.content;
        if (d) {
          full += d;
          if (p.stream) p.onToken?.(d);
        }
      });
      return full;
    });
  },
};

export = provider;

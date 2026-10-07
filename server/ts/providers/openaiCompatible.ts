import { consumeSSE } from "./stream";
import { pageFetch } from "../middleware/perPageProxy";

/**
 * Universal OpenAI-compatible API client.
 * options: { id, label, baseUrl, authType, secretHeader, models, extraHeaders }
 */
export interface CompatOptions {
  id: string;
  label: string;
  baseUrl: string;
  authType: "Bearer" | "Header";
  secretHeader?: string;
  models?: string[];
  extraHeaders?: Record<string, string>;
}

function makeOpenAICompatible(o: CompatOptions) {
  return {
    id: o.id,
    label: o.label,
    models: o.models || [],
    modelsUrl() {
      return `${o.baseUrl}/models`;
    },
    buildUrl() {
      return `${o.baseUrl}/chat/completions`;
    },
    headers(secret: any) {
      const h: Record<string, string> = { "Content-Type": "application/json" };
      if (o.authType === "Bearer") h.Authorization = `Bearer ${secret}`;
      else if (o.secretHeader) h[o.secretHeader] = secret;
      if (o.extraHeaders) Object.assign(h, o.extraHeaders);
      return h;
    },
    body({
      model,
      messages,
      temperature,
      maxTokens,
      stream,
      topP,
      frequencyPenalty,
      presencePenalty,
      stop,
    }: any) {
      const b: Record<string, unknown> = {
        model,
        messages: messages.map((m: any) => {
          const imgs = Array.isArray(m.images) ? m.images : [];
          if (imgs.length === 0) return { role: m.role, content: m.text };
          // Vision: контент как массив частей (текст + image_url data-URL).
          const parts = imgs.map((url: any) => ({ type: "image_url", image_url: { url } }));
          parts.push({ type: "text", text: m.text });
          return { role: m.role, content: parts };
        }),
        temperature,
        max_tokens: maxTokens,
        stream,
      };
      if (topP !== undefined) b.top_p = topP;
      if (frequencyPenalty !== undefined) b.frequency_penalty = frequencyPenalty;
      if (presencePenalty !== undefined) b.presence_penalty = presencePenalty;
      if (stop) b.stop = Array.isArray(stop) ? stop : [stop];
      return b;
    },
    async listModels(secret: any) {
      const res = await pageFetch(this.modelsUrl(), { headers: this.headers(secret) });
      if (!res.ok) throw new Error(`list models failed: ${res.status}`);
      const json = await res.json();
      return (json.data || []).map((m: any) => m.id);
    },
    async chat({
      secret,
      model,
      messages,
      temperature,
      maxTokens,
      stream,
      onToken,
      signal,
      topP,
      frequencyPenalty,
      presencePenalty,
    }: any) {
      const body = this.body({
        model,
        messages,
        temperature,
        maxTokens,
        stream: true,
        topP,
        frequencyPenalty,
        presencePenalty,
      });
      const res = await pageFetch(this.buildUrl(), {
        method: "POST",
        headers: this.headers(secret),
        signal,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`api error ${res.status}: ${await res.text()}`);
      if (stream) {
        let full = "";
        await consumeSSE(res.body, (j: any) => {
          const d = j.choices?.[0]?.delta?.content;
          if (d) {
            full += d;
            onToken?.(d);
          }
        });
        return full;
      }
      const json = await res.json();
      return json.choices?.[0]?.message?.content || "";
    },
  };
}

export { makeOpenAICompatible };

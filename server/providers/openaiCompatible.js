const { consumeSSE } = require("./stream");

/**
 * Универсальный клиент для OpenAI-совместимых API (OpenAI, Mistral, DeepSeek и др.).
 * options: { id, baseUrl, authType: 'Bearer'|'Key', secretHeader, apiKey }
 */
function makeOpenAICompatible(o) {
  return {
    id: o.id,
    label: o.label,
    models: o.models,
    buildUrl(model) {
      return `${o.baseUrl}/chat/completions`;
    },
    headers(secret) {
      const h = {
        "Content-Type": "application/json",
      };
      if (o.authType === "Bearer") h.Authorization = `Bearer ${secret}`;
      else h[o.secretHeader] = secret;
      return h;
    },
    body({ model, messages, temperature, maxTokens, stream }) {
      return { model, messages, temperature, max_tokens: maxTokens, stream };
    },
    async listModels(secret) {
      const res = await fetch(`${o.baseUrl}/models`, { headers: this.headers(secret) });
      if (!res.ok) throw new Error(`list models failed: ${res.status}`);
      const json = await res.json();
      return (json.data || []).map((m) => m.id);
    },
    async chat({ secret, model, messages, temperature, maxTokens, stream, onToken }) {
      if (stream) {
        const res = await fetch(this.buildUrl(model), {
          method: "POST",
          headers: this.headers(secret),
          body: JSON.stringify(this.body({ model, messages, temperature, maxTokens, stream: true })),
        });
        if (!res.ok) throw new Error(`api error ${res.status}: ${await res.text()}`);
        let full = "";
        await consumeSSE(res.body, (j) => {
          const d = j.choices?.[0]?.delta?.content;
          if (d) { full += d; onToken?.(d); }
        });
        return full;
      }
      const res = await fetch(this.buildUrl(model), {
        method: "POST",
        headers: this.headers(secret),
        body: JSON.stringify(this.body({ model, messages, temperature, maxTokens, stream: false })),
      });
      if (!res.ok) throw new Error(`api error ${res.status}: ${await res.text()}`);
      const json = await res.json();
      return json.choices?.[0]?.message?.content || "";
    },
  };
}

module.exports = { makeOpenAICompatible };
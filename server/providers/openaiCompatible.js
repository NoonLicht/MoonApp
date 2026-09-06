const { consumeSSE } = require("./stream");

/**
 * Universal OpenAI-compatible API client.
 * options: { id, label, baseUrl, authType, secretHeader, models, extraHeaders }
 */
function makeOpenAICompatible(o) {
  return {
    id: o.id,
    label: o.label,
    models: o.models || [],
    modelsUrl() { return `${o.baseUrl}/models`; },
    buildUrl() { return `${o.baseUrl}/chat/completions`; },
    headers(secret) {
      const h = { "Content-Type": "application/json" };
      if (o.authType === "Bearer") h.Authorization = `Bearer ${secret}`;
      else h[o.secretHeader] = secret;
      if (o.extraHeaders) Object.assign(h, o.extraHeaders);
      return h;
    },
    body({ model, messages, temperature, maxTokens, stream, topP, frequencyPenalty, presencePenalty, stop }) {
      const b = { model, messages, temperature, max_tokens: maxTokens, stream };
      if (topP !== undefined) b.top_p = topP;
      if (frequencyPenalty !== undefined) b.frequency_penalty = frequencyPenalty;
      if (presencePenalty !== undefined) b.presence_penalty = presencePenalty;
      if (stop) b.stop = Array.isArray(stop) ? stop : [stop];
      return b;
    },
    async listModels(secret) {
      const res = await fetch(this.modelsUrl(), { headers: this.headers(secret) });
      if (!res.ok) throw new Error(`list models failed: ${res.status}`);
      const json = await res.json();
      return (json.data || []).map((m) => m.id);
    },
    async chat({ secret, model, messages, temperature, maxTokens, stream, onToken, signal, topP, frequencyPenalty, presencePenalty }) {
      const body = this.body({ model, messages, temperature, maxTokens, stream: true, topP, frequencyPenalty, presencePenalty });
      const res = await fetch(this.buildUrl(), {
        method: "POST", headers: this.headers(secret), signal,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`api error ${res.status}: ${await res.text()}`);
      if (stream) {
        let full = "";
        await consumeSSE(res.body, (j) => {
          const d = j.choices?.[0]?.delta?.content;
          if (d) { full += d; onToken?.(d); }
        });
        return full;
      }
      const json = await res.json();
      return json.choices?.[0]?.message?.content || "";
    },
  };
}

module.exports = { makeOpenAICompatible };
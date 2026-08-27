const { consumeSSE } = require("./stream");

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS = ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"];

function mapMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "system") continue; // у Gemini нет системного в простом формате
    const role = m.role === "assistant" ? "model" : "user";
    out.push({ role, parts: [{ text: m.text }] });
  }
  return out;
}

module.exports = {
  id: "gemini",
  label: "Google Gemini",
  models: MODELS,
  mkUrl(model, key) {
    return `${BASE}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  },
  async chat({ secret, model, messages, temperature, maxTokens, stream, onToken }) {
    const body = {
      contents: mapMessages(messages),
      generationConfig: { temperature: temperature ?? 0.7, maxOutputTokens: maxTokens || 1024 },
    };
    const res = await fetch(this.mkUrl(model, secret), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`gemini error ${res.status}: ${await res.text()}`);

    if (stream) {
      let full = "";
      await consumeSSE(res.body, (j) => {
        const parts = j.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
          if (p.text) { full += p.text; onToken?.(p.text); }
        }
      });
      return full;
    }
    const json = await res.json();
    const parts = json.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || "").join("");
  },
};
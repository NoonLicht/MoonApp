const { consumeSSE } = require("./stream");

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"];

function mapMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "system") continue; // у Gemini нет системного в простом формате
    const role = m.role === "assistant" ? "model" : "user";
    const parts = [];
    const imgs = Array.isArray(m.images) ? m.images : [];
    for (const dataUrl of imgs) {
      const mm = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || "");
      if (mm) parts.push({ inline_data: { mime_type: mm[1], data: mm[2] } });
    }
    parts.push({ text: m.text });
    out.push({ role, parts });
  }
  return out;
}

// GET {BASE}?key=... → { models: [{ name: "models/gemini-2.5-pro", ... }] }
async function listModels(secret) {
  const res = await fetch(`${BASE}?pageSize=100&key=${encodeURIComponent(secret)}`);
  if (!res.ok) throw new Error(`list models failed: ${res.status}`);
  const json = await res.json();
  return (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name || "").replace(/^models\//, ""));
}

module.exports = {
  id: "gemini",
  label: "Google Gemini",
  models: MODELS,
  listModels,
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
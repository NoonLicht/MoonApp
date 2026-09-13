const { consumeSSE } = require("./stream");
const { pageFetch } = require("../middleware/perPageProxy");

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
const MODELS = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-opus-4", "claude-sonnet-4-0", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"];

function mapMessages(messages) {
  // Anthropic принимает только user/assistant; изображения — как content blocks.
  return messages
    .map(({ role, text, images }) => {
      const imgs = Array.isArray(images) ? images : [];
      if (imgs.length === 0) {
        return { role: role === "user" ? "user" : "assistant", content: text };
      }
      const content = [];
      for (const dataUrl of imgs) {
        const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || "");
        if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      }
      content.push({ type: "text", text });
      return { role: role === "user" ? "user" : "assistant", content };
    })
    .filter((m) => (typeof m.content === "string" ? m.content.trim() : m.content.length > 0));
}

// GET https://api.anthropic.com/v1/models
async function listModels(secret) {
  const res = await pageFetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": secret, "anthropic-version": VERSION },
  });
  if (!res.ok) throw new Error(`list models failed: ${res.status}`);
  const json = await res.json();
  return (json.data || []).map((m) => m.id);
}

module.exports = {
  id: "anthropic",
  label: "Anthropic (Claude)",
  models: MODELS,
  listModels,
  headers(secret) {
    return {
      "Content-Type": "application/json",
      "x-api-key": secret,
      "anthropic-version": VERSION,
    };
  },
  async chat({ secret, model, messages, temperature, maxTokens, stream, onToken }) {
    // Первое системное сообщение выносим в поле system.
    const sys = messages.find((m) => m.role === "system")?.text;
    const msgs = mapMessages(messages);

    const bodyObj = {
      model,
      max_tokens: maxTokens || 1024,
      temperature: temperature ?? 0.7,
      messages: msgs,
      stream,
    };
    if (sys) bodyObj.system = sys;

    const res = await pageFetch(API, {
      method: "POST",
      headers: this.headers(secret),
      body: JSON.stringify(bodyObj),
    });
    if (!res.ok) throw new Error(`anthropic error ${res.status}: ${await res.text()}`);

    if (stream) {
      let full = "";
      await consumeSSE(res.body, (j) => {
        if (j.type === "content_block_delta" && j.delta?.text) {
          full += j.delta.text;
          onToken?.(j.delta.text);
        }
      });
      return full;
    }
    const json = await res.json();
    return (json.content || []).map((c) => c.text || "").join("");
  },
};
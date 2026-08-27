const { consumeSSE } = require("./stream");

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
const MODELS = ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-latest", "claude-3-7-sonnet-latest"];

function mapMessages(messages) {
  // Anthropic принимает только user/assistant; last user-message может быть в content.
  return messages
    .map(({ role, text }) => ({ role: role === "user" ? "user" : "assistant", content: text }))
    .filter((m) => m.content && String(m.content).trim().length > 0);
}

module.exports = {
  id: "anthropic",
  label: "Anthropic (Claude)",
  models: MODELS,
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

    const res = await fetch(API, {
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
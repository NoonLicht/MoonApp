const { makeOpenAICompatible } = require("./openaiCompatible");

const FALLBACK = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o3",
  "o4-mini",
  "o3-mini",
  "gpt-4.5-preview",
];

module.exports = makeOpenAICompatible({
  id: "openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  authType: "Bearer",
  models: FALLBACK,
});

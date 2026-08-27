const { makeOpenAICompatible } = require("./openaiCompatible");

module.exports = makeOpenAICompatible({
  id: "openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  authType: "Bearer",
  models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o3-mini", "gpt-4.5-preview"],
});
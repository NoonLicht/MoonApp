const { makeOpenAICompatible } = require("./openaiCompatible");

module.exports = makeOpenAICompatible({
  id: "openrouter",
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  authType: "Bearer",
  models: [], // dynamic
  extraHeaders: {
    "HTTP-Referer": "https://github.com/NoonLicht/MoonApp",
    "X-Title": "MoonApp",
  },
});
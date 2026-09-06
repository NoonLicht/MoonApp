const { makeOpenAICompatible } = require("./openaiCompatible");

module.exports = makeOpenAICompatible({
  id: "mistral",
  label: "Mistral",
  baseUrl: "https://api.mistral.ai/v1",
  authType: "Bearer",
  models: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "codestral-latest", "magistral-medium-latest", "ministral-8b-latest"],
});
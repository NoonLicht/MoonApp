const { makeOpenAICompatible } = require("./openaiCompatible");

module.exports = makeOpenAICompatible({
  id: "perplexity",
  label: "Perplexity",
  baseUrl: "https://api.perplexity.ai",
  authType: "Bearer",
  models: [], // dynamic
});
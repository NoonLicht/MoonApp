const { makeOpenAICompatible } = require("./openaiCompatible");

module.exports = makeOpenAICompatible({
  id: "groq",
  label: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  authType: "Bearer",
  models: [], // dynamic
});

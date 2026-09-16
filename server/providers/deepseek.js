const { makeOpenAICompatible } = require("./openaiCompatible");

module.exports = makeOpenAICompatible({
  id: "deepseek",
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  authType: "Bearer",
  models: ["deepseek-chat", "deepseek-reasoner"],
});

import type { Provider } from "./types";
import { makeOpenAICompatible } from "./openaiCompatible";

const provider: Provider = makeOpenAICompatible({
  id: "deepseek",
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  authType: "Bearer",
  models: ["deepseek-chat", "deepseek-reasoner"],
});

export = provider;

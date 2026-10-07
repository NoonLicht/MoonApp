import type { Provider } from "./types";
import { makeOpenAICompatible } from "./openaiCompatible";

const provider: Provider = makeOpenAICompatible({
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

export = provider;

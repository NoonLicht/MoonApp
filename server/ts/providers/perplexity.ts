import type { Provider } from "./types";
import { makeOpenAICompatible } from "./openaiCompatible";

const provider: Provider = makeOpenAICompatible({
  id: "perplexity",
  label: "Perplexity",
  baseUrl: "https://api.perplexity.ai",
  authType: "Bearer",
  models: [], // dynamic
});

export = provider;

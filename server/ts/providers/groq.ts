import type { Provider } from "./types";
import { makeOpenAICompatible } from "./openaiCompatible";

const provider: Provider = makeOpenAICompatible({
  id: "groq",
  label: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  authType: "Bearer",
  models: [], // dynamic
});

export = provider;

import type { Provider } from "./types";
import openai from "./openai";
import anthropic from "./anthropic";
import gemini from "./gemini";
import mistral from "./mistral";
import deepseek from "./deepseek";
import ollama from "./ollama";
import openrouter from "./openrouter";
import groq from "./groq";
import perplexity from "./perplexity";
import llamacpp from "./llamacpp";

const PROVIDERS: Provider[] = [
  openai,
  anthropic,
  gemini,
  mistral,
  deepseek,
  ollama,
  openrouter,
  groq,
  perplexity,
  llamacpp,
];

function getProvider(id: string): Provider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

export { PROVIDERS, getProvider };

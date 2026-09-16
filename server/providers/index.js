const openai = require("./openai");
const anthropic = require("./anthropic");
const gemini = require("./gemini");
const mistral = require("./mistral");
const deepseek = require("./deepseek");
const ollama = require("./ollama");
const openrouter = require("./openrouter");
const groq = require("./groq");
const perplexity = require("./perplexity");

const PROVIDERS = [
  openai,
  anthropic,
  gemini,
  mistral,
  deepseek,
  ollama,
  openrouter,
  groq,
  perplexity,
];

function getProvider(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

module.exports = { PROVIDERS, getProvider };

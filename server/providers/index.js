const openai = require("./openai");
const anthropic = require("./anthropic");
const gemini = require("./gemini");
const mistral = require("./mistral");
const deepseek = require("./deepseek");
const ollama = require("./ollama");

const PROVIDERS = [openai, anthropic, gemini, mistral, deepseek, ollama];

function getProvider(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

module.exports = { PROVIDERS, getProvider };
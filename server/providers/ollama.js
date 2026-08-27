/**
 * Локальный запуск DeepSeek/др. через Ollama — ПОКА ЗАГЛУШКА.
 * Интерфейс такой же, как у облачных провайдеров, чтобы встроить позже.
 * Ollama: POST http://localhost:11434/v1/chat/completions (OpenAI-совместимо)
 */
module.exports = {
  id: "ollama",
  label: "Ollama (локально)",
  models: ["llama3.2:latest", "mistral:latest", "deepseek-r1:latest"],
  stub: true,
  async chat() {
    throw new Error("Локальный запуск через Ollama пока не реализован (заглушка).");
  },
  async listModels() {
    return [];
  },
};
/** Сообщение чата в формате, общем для всех провайдеров. */
export interface ChatMessage {
  role: string;
  text: string;
  images?: string[];
}

export interface ChatParams {
  secret: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string | string[];
}

/** Единый интерфейс провайдера ИИ (OpenAI-совместимые, Anthropic, Gemini, Ollama). */
export interface Provider {
  id: string;
  label: string;
  models: string[];
  stub?: boolean;
  modelsUrl?(): string;
  buildUrl?(model?: string, stream?: boolean): string;
  headers?(secret: string): Record<string, string>;
  body?(p: Omit<ChatParams, "secret" | "onToken" | "signal">): Record<string, unknown>;
  listModels(secret: string): Promise<string[]>;
  chat(params: ChatParams): Promise<string>;
}

/**
 * Оценка размера и стоимости запроса до отправки.
 *
 * Токены оцениваются по длине текста (кириллица «тяжелее» латиницы), цены —
 * ориентировочные, за 1 млн токенов, по шаблону имени модели. Это подсказка,
 * а не счёт: точные цифры знает только провайдер.
 */

export interface Price {
  /** USD за 1 млн входных токенов. */
  input: number;
  /** USD за 1 млн выходных токенов. */
  output: number;
}

const PRICES: [RegExp, Price][] = [
  [/deepseek.*(reasoner|r1)/i, { input: 0.55, output: 2.19 }],
  [/deepseek/i, { input: 0.27, output: 1.1 }],
  [/gpt-4o-mini/i, { input: 0.15, output: 0.6 }],
  [/gpt-4o|gpt-4\.1/i, { input: 2.5, output: 10 }],
  [/o1|o3/i, { input: 15, output: 60 }],
  [/claude.*haiku/i, { input: 0.8, output: 4 }],
  [/claude.*opus/i, { input: 15, output: 75 }],
  [/claude/i, { input: 3, output: 15 }],
  [/gemini.*flash/i, { input: 0.1, output: 0.4 }],
  [/gemini/i, { input: 1.25, output: 5 }],
  [/mistral.*(small|nemo)/i, { input: 0.2, output: 0.6 }],
  [/mistral|mixtral/i, { input: 2, output: 6 }],
  [/llama|qwen|gemma|phi/i, { input: 0, output: 0 }], // локальные модели
];

export function priceFor(model: string): Price | null {
  for (const [re, p] of PRICES) if (re.test(model)) return p;
  return null;
}

/** Грубая оценка числа токенов: ~4 символа латиницы или ~2,2 символа кириллицы/CJK на токен. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let heavy = 0;
  for (const ch of text) if (ch.charCodeAt(0) > 0x2ff) heavy++;
  const light = text.length - heavy;
  return Math.ceil(light / 4 + heavy / 2.2);
}

export interface CostEstimate {
  inputTokens: number;
  /** Ожидаемый ответ (по умолчанию — в полтора раза больше вопроса, но не меньше 150). */
  outputTokens: number;
  /** USD; null — цена модели неизвестна. */
  usd: number | null;
}

export function estimateCost(opts: {
  model: string;
  history: string[];
  prompt: string;
  expectedOutput?: number;
}): CostEstimate {
  const inputTokens = [...opts.history, opts.prompt].reduce((s, t) => s + estimateTokens(t), 0);
  const outputTokens = opts.expectedOutput ?? Math.max(150, Math.round(estimateTokens(opts.prompt) * 1.5));
  const p = priceFor(opts.model);
  const usd = p ? (inputTokens * p.input + outputTokens * p.output) / 1_000_000 : null;
  return { inputTokens, outputTokens, usd };
}

export function formatUsd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.0001) return "<$0.0001";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`;
}

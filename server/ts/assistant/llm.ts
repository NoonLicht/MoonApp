/**
 * Один ход помощника: сообщения + описания инструментов → ответ модели (текст и/или вызовы).
 * Модель — локальная llama.cpp; цикл «вызов → выполнение → следующий ход» ведёт клиент, потому что
 * документ открыт в странице и правки должны идти через неё (отмена, перерисовка).
 */
import { consumeSSE } from "../providers/stream";
import { withServer } from "../llamacpp/engine";
import { chatCtx, resolve } from "../llamacpp/router";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-строка аргументов, как её отдала модель. */
  arguments: string;
  /** Номер вызова в ответе модели (связывает потоковые аргументы с итоговым вызовом). */
  index?: number;
}

export interface TurnMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** data:-ссылки картинок (только у user). */
  images?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TurnResult {
  content: string;
  toolCalls: ToolCall[];
  finish: string;
  model: string;
}

const approx = (t: string): number => Math.ceil(t.length / 2.2) + 8;
const cost = (m: TurnMessage): number =>
  approx(m.content) + (m.tool_calls ?? []).reduce((n, c) => n + approx(c.name + c.arguments), 0);

/**
 * Историю подрезаем с начала, пока она не влезет в окно: system и последний запрос пользователя
 * остаются всегда (шаблоны Qwen/Gemma падают с «No user query found», если пользовательского
 * сообщения нет). Вызов инструмента и его результат уходят вместе. Если и после этого не влезает —
 * сжимаем самые длинные результаты инструментов текущего хода, а не выбрасываем сообщения.
 */
export function fit(msgs: TurnMessage[], budget: number): TurnMessage[] {
  const out = msgs.map((m) => ({ ...m }));
  let total = out.reduce((n, m) => n + cost(m), 0);
  const i = out[0]?.role === "system" ? 1 : 0;
  const lastUser = (): number => {
    for (let k = out.length - 1; k >= i; k--) if (out[k].role === "user") return k;
    return out.length - 1;
  };
  while (total > budget && lastUser() > i) {
    total -= cost(out[i]);
    out.splice(i, 1);
    while (lastUser() > i && out[i].role !== "user" && out[i].role !== "assistant") {
      total -= cost(out[i]);
      out.splice(i, 1);
    }
  }
  // Осталось: system, запрос пользователя и свежие вызовы с результатами. Сжимаем самые тяжёлые.
  for (let guard = 0; total > budget && guard < 200; guard++) {
    let big = -1;
    for (let k = lastUser() + 1; k < out.length; k++)
      if (
        out[k].role === "tool" &&
        out[k].content.length > 400 &&
        (big < 0 || out[k].content.length > out[big].content.length)
      )
        big = k;
    if (big < 0) break;
    const before = cost(out[big]);
    out[big].content =
      `${out[big].content.slice(0, Math.max(300, Math.floor(out[big].content.length / 2)))}
…[shortened]`;
    total -= before - cost(out[big]);
  }
  return out;
}

export async function runTurn(
  o: {
    model?: string;
    messages: TurnMessage[];
    tools?: ToolSpec[];
    maxTokens?: number;
    temperature?: number;
    think?: boolean;
    signal?: AbortSignal;
  },
  on: {
    token?: (d: string) => void;
    thinking?: (d: string) => void;
    /** Аргументы вызова растут: имя и очередной кусок JSON (для записи в документ по ходу набора). */
    toolArgs?: (index: number, name: string, args: string) => void;
  } = {},
): Promise<TurnResult> {
  const wantImages = o.messages.some((m) => m.images?.length);
  const r = resolve("chat", o.model || "", wantImages);
  if (!r) throw new Error("llamacpp_model_missing");
  const CTX = chatCtx();
  const maxTokens = Math.max(128, Math.min(o.maxTokens ?? 2048, Math.floor(CTX / 2)));
  const toolCost = o.tools?.length ? approx(JSON.stringify(o.tools)) : 0;
  const messages = fit(o.messages, CTX - maxTokens - toolCost - 256);
  return withServer(
    { model: r.model, mmproj: r.mmproj, device: r.device, ctx: CTX, task: "chat" },
    async (s) => {
      const body: Record<string, unknown> = {
        messages: messages.map((m) => {
          if (m.role === "tool")
            return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
          if (m.role === "assistant" && m.tool_calls?.length)
            return {
              role: "assistant",
              content: m.content || null,
              tool_calls: m.tool_calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            };
          if (m.images?.length)
            return {
              role: m.role,
              content: [
                ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
                { type: "text", text: m.content },
              ],
            };
          return { role: m.role, content: m.content };
        }),
        temperature: o.temperature ?? 0.4,
        max_tokens: maxTokens,
        stream: true,
        // Размышления Qwen/Gemma съедают токены и время: по умолчанию выключены.
        chat_template_kwargs: { enable_thinking: !!o.think },
      };
      if (o.tools?.length) {
        body.tools = o.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = "auto";
      }
      const res = await fetch(`${s.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: o.signal,
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new Error(`llamacpp error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      let content = "";
      let finish = "";
      let streamError = "";
      const calls = new Map<number, ToolCall>();
      await consumeSSE(
        res.body,
        (j: {
          error?: { message?: string } | string;
          choices?: {
            finish_reason?: string | null;
            delta?: {
              content?: string;
              reasoning_content?: string;
              tool_calls?: {
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
          }[];
        }) => {
          if (j.error) {
            streamError = typeof j.error === "string" ? j.error : (j.error.message ?? "error");
            return;
          }
          const c = j.choices?.[0];
          if (c?.finish_reason) finish = c.finish_reason;
          const d = c?.delta;
          if (d?.content) {
            content += d.content;
            on.token?.(d.content);
          }
          if (d?.reasoning_content) on.thinking?.(d.reasoning_content);
          for (const t of d?.tool_calls ?? []) {
            const i = t.index ?? 0;
            const cur = calls.get(i) ?? { id: "", name: "", arguments: "" };
            if (t.id) cur.id = t.id;
            if (t.function?.name) cur.name += t.function.name;
            if (t.function?.arguments) cur.arguments += t.function.arguments;
            calls.set(i, cur);
            if (cur.name && t.function?.arguments) on.toolArgs?.(i, cur.name, t.function.arguments);
          }
        },
      );
      if (streamError) throw new Error(`llamacpp error: ${streamError.slice(0, 300)}`);
      const toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}`, index: i }))
        .filter((c) => c.name);
      return { content, toolCalls, finish, model: r.file };
    },
  );
}

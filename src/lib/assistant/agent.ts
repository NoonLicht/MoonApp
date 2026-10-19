import { api } from "@/api/client";
import type { AssistantMessage, AssistantToolCall } from "@/api/apiAssistant";
import type { AssistantSettings, AssistantTool, ChatStep, DocAdapter } from "@/lib/assistant/types";

/** Сколько шагов «вызов → результат» помощник может сделать за один запрос пользователя. */
export const MAX_STEPS = 14;
/** Результат инструмента режется: иначе один прочитанный лист съест всё окно контекста. */
const MAX_RESULT = 10000;

/** Инструменты, разрешённые настройками. Без агентного режима инструментов нет вовсе. */
export function allowedTools(adapter: DocAdapter, s: AssistantSettings): AssistantTool[] {
  if (!s.agent) return [];
  return adapter.tools.filter(
    (t) =>
      t.group === "read" ||
      (t.group === "edit" && s.edit) ||
      (t.group === "commands" && s.commands) ||
      (t.group === "web" && s.web) ||
      (t.group === "images" && s.images),
  );
}

function systemPrompt(adapter: DocAdapter, s: AssistantSettings, tools: AssistantTool[]): string {
  const can: string[] = [];
  if (!s.agent) can.push("You cannot change the document yourself: answer in text, the user inserts it.");
  else {
    can.push("You may call tools. Think about which tool you need, call it, read the result, continue.");
    if (!s.edit && !s.commands)
      can.push("Editing is switched off: do not try to change the document, only read and answer.");
    if (!s.web) can.push("Internet access is switched off.");
  }
  return [
    adapter.system,
    "Always answer in the language the user writes in. Be concise; do not repeat the document back.",
    "Do exactly what the user asked and nothing more. Never sort, delete, move or reformat anything the user did not mention. Do not repeat an action that already succeeded: when a result must go into a cell or paragraph, write it once, then answer.",
    ...can,
    tools.length ? `Available tools: ${tools.map((t) => t.name).join(", ")}.` : "",
    "After finishing, say in one or two sentences what you did or found.",
  ]
    .filter(Boolean)
    .join("\n");
}

const trim = (t: string): string =>
  t.length > MAX_RESULT ? `${t.slice(0, MAX_RESULT)}\n…[truncated ${t.length - MAX_RESULT} chars]` : t;

/** Модели иногда присылают аргументы с хвостом или в кавычках — разбираем терпимо. */
export function parseArgs(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return {};
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      if (typeof v === "string") return tryParse(v);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  const m = /\{[\s\S]*\}/.exec(text);
  return m ? tryParse(m[0]) : null;
}

export interface AgentEvents {
  /** Новый кусок текста ответа. */
  onText: (delta: string) => void;
  /** Шаг агента начат/завершён (по `id`). */
  onStep: (step: ChatStep) => void;
}

export interface AgentRun {
  adapter: DocAdapter;
  settings: AssistantSettings;
  /** Прошлые реплики (только текст) — контекст беседы. */
  history: { role: "user" | "assistant"; text: string }[];
  user: string;
  images?: string[];
  /** Документ в виде текста для режима без агента (там модель сама не может его прочитать). */
  snapshot?: string;
  signal: AbortSignal;
  events: AgentEvents;
}

/**
 * Цикл помощника: ход модели → вызовы инструментов → следующий ход, пока модель не ответит текстом.
 * Все правки идут через страницу (adapter), поэтому работают отмена, перерисовка и автосохранение.
 */
export async function runAgent(run: AgentRun): Promise<string> {
  const { adapter, settings, events } = run;
  const tools = allowedTools(adapter, settings);
  const messages: AssistantMessage[] = [
    { role: "system", content: systemPrompt(adapter, settings, tools) },
    ...run.history.map((h) => ({ role: h.role, content: h.text }) as AssistantMessage),
  ];
  const ctx = adapter.context();
  const extra = [ctx, !settings.agent && run.snapshot ? `Document:\n${run.snapshot}` : ""]
    .filter(Boolean)
    .join("\n\n");
  messages.push({
    role: "user",
    content: extra ? `${run.user}\n\n[${adapter.kind === "word" ? "Document" : "Workbook"} state]\n${extra}` : run.user,
    ...(run.images?.length ? { images: run.images } : {}),
  });

  const spec = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  let answer = "";
  const seen = new Map<string, number>();
  const used = new Map<string, number>();
  for (let step = 0; step < MAX_STEPS; step++) {
    let turnText = "";
    const r = await api.assistantTurn(
      {
        model: settings.model || undefined,
        messages,
        tools: spec.length ? spec : undefined,
        think: settings.think,
        maxTokens: 2048,
      },
      {
        onToken: (d) => {
          turnText += d;
          events.onText(d);
        },
      },
      run.signal,
    );
    answer += turnText;
    if (!r.toolCalls.length) return answer.trim();
    // Текст перед вызовами остаётся в ответе: отделяем его от следующего хода.
    if (turnText.trim()) events.onText("\n\n");
    messages.push({ role: "assistant", content: r.content, tool_calls: r.toolCalls });
    for (const call of r.toolCalls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: await execCall(call, tools, seen, used, events),
      });
      if (run.signal.aborted) throw new DOMException("aborted", "AbortError");
    }
  }
  events.onText("\n\n");
  return answer.trim();
}

async function execCall(
  call: AssistantToolCall,
  tools: AssistantTool[],
  seen: Map<string, number>,
  used: Map<string, number>,
  events: AgentEvents,
): Promise<string> {
  const tool = tools.find((t) => t.name === call.name);
  const args = parseArgs(call.arguments);
  const step: ChatStep = {
    id: call.id,
    tool: call.name,
    label: tool && args ? tool.label(args) : call.name,
    state: "run",
  };
  events.onStep(step);
  const fail = (msg: string): string => {
    events.onStep({ ...step, state: "err", detail: msg });
    return `Error: ${msg}`;
  };
  if (!tool) return fail(`unknown tool "${call.name}"`);
  if (!args) return fail("arguments are not valid JSON");
  // Модель зациклилась на одном и том же вызове — прерываем, а не жжём шаги.
  const key = `${call.name}:${JSON.stringify(args)}`;
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  if (n > 2) return fail("this exact call was already made; try something different or answer");
  // Слабые модели иногда долбят один инструмент десятки раз: после лимита просим остановиться.
  const total = (used.get(tool.name) ?? 0) + 1;
  used.set(tool.name, total);
  if (total > (tool.group === "read" ? 10 : 8))
    return fail(`${tool.name} was called too many times in one request; stop and answer the user`);
  try {
    const out = trim(await tool.run(args));
    events.onStep({ ...step, state: "ok", detail: out.slice(0, 240) });
    return out;
  } catch (e) {
    return fail(String((e as Error).message || e));
  }
}

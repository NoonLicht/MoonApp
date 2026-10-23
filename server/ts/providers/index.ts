import type { Provider } from "./types";
import { shieldMessages, restoreText, makeEntry, appendAudit, parseNameList } from "../aiShield";
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
import { boundOf } from "../aiBindings";
import { loadedServers } from "../llamacpp/engine";
import { chatModels } from "../llamacpp/router";

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

/**
 * Имена людей через локальную модель (llama.cpp): текст не покидает компьютер.
 * Любая ошибка (нет модели, долго грузится) — тихо возвращаем пусто, щит
 * продолжает работать по шаблонам.
 */
async function localNames(texts: string[]): Promise<string[]> {
  const local = PROVIDERS.find((x) => x.id === "llamacpp");
  const rawChat = local ? RAW_CHAT.get(local) ?? local.chat.bind(local) : null;
  if (!local || !rawChat) return [];
  const sample = texts.join("\n").slice(0, 6000);
  if (sample.trim().length < 20) return [];
  // Модель для поиска имён никогда не загружается «сама» из-за обычного сообщения в чате:
  // либо она выбрана в Настройках → «Привязка моделей ИИ» → «Щит для ИИ», либо берётся
  // уже загруженная чатовая модель. Если ничего не загружено — имена ищутся по шаблонам.
  const bound = boundOf("shield");
  let model: string;
  if (bound && bound.provider === "llamacpp") {
    model = bound.model;
  } else {
    const chat = new Set(chatModels().map((m) => m.file));
    model = loadedServers().find((s) => chat.has(s.file))?.file ?? "";
    if (!model) return [];
  }
  try {
    const out = await Promise.race([
      rawChat({
        secret: "",
        model,
        stream: false,
        temperature: 0,
        maxTokens: 300,
        messages: [
          {
            role: "system",
            text: "Ты извлекаешь из текста имена людей. Отвечай только JSON-массивом строк, без пояснений.",
          },
          {
            role: "user",
            text: `Выпиши все имена, фамилии и ФИО людей из текста. Если их нет — [].

${sample}`,
          },
        ],
      }),
      new Promise<string>((_r, rej) => setTimeout(() => rej(new Error("local_names_timeout")), 25_000)),
    ]);
    return parseNameList(out);
  } catch {
    return [];
  }
}

interface ShieldCfg {
  enabled?: boolean;
  pii?: boolean;
  names?: boolean;
  localNames?: boolean;
  audit?: boolean;
  preview?: boolean;
}

/** Исходные chat() провайдеров — до установки щита (нужны для служебных локальных запросов). */
const RAW_CHAT = new WeakMap<Provider, Provider["chat"]>();
const INSTALLED = Symbol.for("moonapp.aiShield.installed");

/**
 * Ставит щит прямо в provider.chat: щит прячет секреты, журнал фиксирует, кто что
 * получил. Подмена на месте (а не обёртка) сохраняет тождество объектов провайдеров
 * между модулями и тестами; флаг на объекте защищает от двойной установки.
 */
function installShield(p: Provider): void {
  const holder = p as Provider & { [INSTALLED]?: boolean };
  if (holder[INSTALLED]) return;
  holder[INSTALLED] = true;
  const raw = p.chat.bind(p);
  RAW_CHAT.set(p, raw);
  p.chat = async (params) => {
    // Настройки читаем лениво: модуль провайдеров не должен тянуть их при загрузке.
    const cfg: ShieldCfg =
      (require("../settings") as { get(k: string): ShieldCfg | undefined }).get("aiShield") ?? {};
    const local = !!p.local || p.id === "ollama";
    const on = cfg.enabled !== false && !local;
    const extraNames =
      on && cfg.localNames === true ? await localNames(params.messages.map((m) => m.text)) : [];
    const shielded = on
      ? shieldMessages(params.messages, { pii: !!cfg.pii, names: cfg.names !== false, extraNames })
      : { messages: params.messages, found: {}, map: {} as Record<string, string> };
    if (cfg.audit !== false)
      appendAudit(
        makeEntry({
          provider: p.id,
          model: params.model,
          local,
          messages: shielded.messages,
          hidden: shielded.found,
          preview: cfg.preview !== false,
        }),
      );
    const answer = await raw(params.messages === shielded.messages ? params : { ...params, messages: shielded.messages });
    return Object.keys(shielded.map).length ? restoreText(answer, shielded.map) : answer;
  };
}

PROVIDERS.forEach(installShield);

function getProvider(id: string): Provider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

export { PROVIDERS, getProvider };

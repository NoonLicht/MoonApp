/**
 * Привязка модели к каждой ИИ-функции приложения.
 *
 * По умолчанию у функции стоит «авто»: модель выбирается как раньше (настройки функции или
 * маршрутизатор локальных моделей). Если снять «авто» и выбрать провайдера и модель, функция
 * всегда использует именно их. Хранится в storage/ai-bindings.json.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import { getProvider } from "./providers";
import { getSecret } from "./security";

export interface FeatureDef {
  id: string;
  group: "chat" | "notes" | "mail" | "lecture" | "translate";
  /** Задача для маршрутизатора локальных моделей (подпись в индикаторе). */
  task: "chat" | "command" | "summary" | "translate";
}

/** Все ИИ-функции, к которым можно привязать модель. Подписи — в i18n (aibind.f.<id>). */
export const FEATURES: FeatureDef[] = [
  { id: "chat", group: "chat", task: "chat" },
  { id: "chat.tools", group: "chat", task: "chat" },
  { id: "shield", group: "chat", task: "chat" },
  { id: "notes.commands", group: "notes", task: "command" },
  { id: "notes.ai", group: "notes", task: "chat" },
  { id: "notes.canvas", group: "notes", task: "chat" },
  { id: "notes.mind", group: "notes", task: "chat" },
  { id: "notes.gaps", group: "notes", task: "chat" },
  { id: "notes.attention", group: "notes", task: "chat" },
  { id: "ghost", group: "notes", task: "summary" },
  { id: "mail", group: "mail", task: "summary" },
  { id: "lecture.conspectus", group: "lecture", task: "summary" },
  { id: "lecture.ask", group: "lecture", task: "chat" },
  { id: "lecture.exam", group: "lecture", task: "chat" },
  { id: "translate", group: "translate", task: "translate" },
];

export interface Binding {
  /** false — функция выключена пользователем (см. SWITCHABLE). Нет поля = включена. */
  enabled?: boolean;
  /** true — модель выбирается автоматически (как раньше). */
  auto: boolean;
  provider: string;
  model: string;
}

const FILE = path.join(config.DIRS.storage, "ai-bindings.json");
let cache: Record<string, Binding> | null = null;

const known = (id: string): boolean => FEATURES.some((f) => f.id === id);

/**
 * Функции, которые можно выключить целиком. Основной чат, «Щит» (свой выключатель в его настройках)
 * и переводчик сюда не входят; эмбеддинги и голосовые модели вообще не относятся к этому списку.
 */
const NOT_SWITCHABLE = new Set(["chat", "shield", "translate"]);
export const switchable = (id: string): boolean => known(id) && !NOT_SWITCHABLE.has(id);

function clean(v: unknown): Record<string, Binding> {
  const out: Record<string, Binding> = {};
  if (!v || typeof v !== "object") return out;
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!known(id) || !raw || typeof raw !== "object") continue;
    const b = raw as Partial<Binding>;
    out[id] = {
      ...(b.enabled === false && switchable(id) ? { enabled: false } : {}),
      auto: b.auto !== false,
      provider: typeof b.provider === "string" ? b.provider.slice(0, 64) : "",
      model: typeof b.model === "string" ? b.model.slice(0, 256) : "",
    };
  }
  return out;
}

export function getBindings(): Record<string, Binding> {
  if (cache) return cache;
  try {
    cache = clean(JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch {
    cache = {};
  }
  return cache;
}

function save(next: Record<string, Binding>): void {
  cache = next;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), "utf8");
}

export function setBinding(id: string, b: Partial<Binding>): Binding {
  if (!known(id)) throw new Error("unknown_feature");
  const all = { ...getBindings() };
  const cur = all[id] ?? { auto: true, provider: "", model: "" };
  const enabled = typeof b.enabled === "boolean" && switchable(id) ? b.enabled : cur.enabled;
  all[id] = {
    ...(enabled === false ? { enabled: false } : {}),
    auto: typeof b.auto === "boolean" ? b.auto : cur.auto,
    provider: typeof b.provider === "string" ? b.provider.slice(0, 64) : cur.provider,
    model: typeof b.model === "string" ? b.model.slice(0, 256) : cur.model,
  };
  save(all);
  return all[id];
}

export function resetBindings(): void {
  save({});
}

/** Включена ли функция (по умолчанию — да). */
export function featureEnabled(feature?: string): boolean {
  if (!feature) return true;
  return getBindings()[feature]?.enabled !== false;
}

/** Бросает ошибку, если пользователь выключил эту ИИ-функцию (Настройки → «ИИ и модели»). */
export function assertFeature(feature?: string): void {
  if (!featureEnabled(feature)) throw new Error("ai_feature_disabled: " + feature);
}

/** Активная привязка функции: «авто» снято и выбраны провайдер с моделью; иначе null. */
export function boundOf(feature?: string): { provider: string; model: string } | null {
  if (!feature) return null;
  const b = getBindings()[feature];
  if (!b || b.auto || !b.provider || !b.model) return null;
  return { provider: b.provider, model: b.model };
}

export interface BoundTarget {
  provider: { id?: string; chat(o: Record<string, unknown>): Promise<string> };
  secret: string;
  model: string;
}

/**
 * Цель запроса (провайдер, ключ, модель) для функции с привязкой. Для локальных моделей к
 * запросу добавляется задача — по ней маршрутизатор подписывает работу модели в шапке.
 */
export function boundTarget(feature?: string): BoundTarget | null {
  const b = boundOf(feature);
  if (!b) return null;
  const provider = getProvider(b.provider);
  const secret = getSecret(provider.id);
  if (!secret) throw new Error("provider_not_configured: " + provider.id);
  const task = FEATURES.find((f) => f.id === feature)?.task ?? "chat";
  const wrapped =
    provider.id === "llamacpp"
      ? {
          id: provider.id,
          chat: (o: Record<string, unknown>) => provider.chat({ ...o, task } as never),
        }
      : (provider as unknown as BoundTarget["provider"]);
  return { provider: wrapped, secret, model: b.model };
}

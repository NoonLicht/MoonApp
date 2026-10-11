/**
 * Один запрос к модели чата (провайдер, ключ и модель — как у конспекта).
 * Нужен фишкам, которым достаточно «система + вопрос → текст»; сам запрос
 * проходит через слой провайдеров, то есть через «Щит для ИИ» и журнал.
 */
import { runWithPage } from "./middleware/perPageProxy";
import { conspectusTarget } from "./lectureConspectus";

export interface LlmTarget {
  provider: { chat(o: Record<string, unknown>): Promise<string> };
  secret: string;
  model: string;
}

export async function askModel(
  system: string,
  user: string,
  o: { appPage?: string | null; maxTokens?: number; temperature?: number; target?: LlmTarget } = {},
): Promise<string> {
  const t = o.target ?? ((await conspectusTarget(o.appPage ?? null)) as unknown as LlmTarget);
  const text = await runWithPage(o.appPage ?? null, () =>
    t.provider.chat({
      secret: t.secret,
      model: t.model,
      messages: [
        { role: "system", text: system },
        { role: "user", text: user },
      ],
      temperature: o.temperature ?? 0.3,
      maxTokens: o.maxTokens ?? 1200,
      stream: true,
    }),
  );
  return String(text || "").trim();
}

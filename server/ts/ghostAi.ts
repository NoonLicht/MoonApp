/**
 * «Контекст» на нейросети: кандидаты из семантического поиска проверяет модель
 * чата — оставляет только действительно относящиеся к тексту и кратко объясняет связь.
 * Любой сбой (нет модели, таймаут, невалидный ответ) → возвращается None, и
 * вызывающий код остаётся на оценке близости эмбеддингов.
 */
import { askModel } from "./llmOnce";
import type { GhostHit } from "./ghostContext";

export interface Judged extends GhostHit {
  why?: string;
}

const MAX_CANDIDATES = 16;
const TIMEOUT_MS = 12_000;

const SYSTEM =
  "Ты фильтр релевантности для личной базы знаний. Отвечаешь только JSON-массивом, без пояснений вокруг.";

function buildPrompt(text: string, cands: GhostHit[]): string {
  const list = cands
    .map((c, i) => `${i + 1}. [${c.source}] ${c.title} — ${c.snippet.replace(/\s+/g, " ").slice(0, 220)}`)
    .join("\n");
  return (
    `Пользователь работает с текстом:\n"""\n${text.replace(/\s+/g, " ").slice(0, 700)}\n"""\n\n` +
    `Кандидаты из его заметок и данных:\n${list}\n\n` +
    `Выбери только те кандидаты, которые ПО СМЫСЛУ полезны к этому тексту: ` +
    `та же тема, факт, решение, задача или противоречие. Случайные совпадения слов отбрасывай. ` +
    `Ответ — JSON-массив вида [{"n":1,"why":"до 12 слов, чем полезно"}], ` +
    `от лучших к худшим, не более 8. Если ничего не подходит — [].`
  );
}

export function parseJudged(raw: string, size: number): { n: number; why: string }[] | null {
  const m = /\[[\s\S]*\]/.exec(raw);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return null;
    const seen = new Set<number>();
    const out: { n: number; why: string }[] = [];
    for (const it of arr) {
      const n = Number((it as { n?: unknown })?.n);
      if (!Number.isInteger(n) || n < 1 || n > size || seen.has(n)) continue;
      seen.add(n);
      out.push({ n, why: String((it as { why?: unknown }).why ?? "").slice(0, 140) });
    }
    return out;
  } catch {
    return null;
  }
}

/** null — модель недоступна/ошиблась (оставить как есть); иначе — отобранные кандидаты. */
export async function judge(
  text: string,
  hits: GhostHit[],
  appPage?: string | null,
): Promise<Judged[] | null> {
  const cands = hits.slice(0, MAX_CANDIDATES);
  if (!cands.length || text.trim().length < 3) return null;
  try {
    const raw = await Promise.race([
      askModel(SYSTEM, buildPrompt(text, cands), {
        appPage,
        maxTokens: 500,
        temperature: 0,
        feature: "ghost",
      }),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)),
    ]);
    const picked = parseJudged(raw, cands.length);
    if (!picked) return null;
    return picked.map((p) => ({ ...cands[p.n - 1], why: p.why || undefined }));
  } catch {
    return null;
  }
}

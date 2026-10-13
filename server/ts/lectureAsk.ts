/**
 * Вопрос по записи лекции с таймкодами.
 *
 * Из расшифровки отбираются отрывки, ближайшие к вопросу (совпадение стемм слов
 * с учётом редкости слова), в запрос к модели они уходят с метками [чч:мм:сс],
 * а в ответе модель обязана ссылаться на эти метки. Ссылки разбираются обратно
 * в миллисекунды, чтобы интерфейс мог перемотать запись на нужное место.
 */
import { tokenize } from "./hybridRank";
import { stmts } from "./db";
import { runWithPage } from "./middleware/perPageProxy";
import { conspectusTarget } from "./lectureConspectus";
import { fmtTs } from "./lectureExport";

export interface AskChunk {
  id?: number;
  start_ms: number;
  end_ms: number;
  text: string;
}
export interface Passage {
  chunkId: number | null;
  startMs: number;
  endMs: number;
  text: string;
  score: number;
}
export interface Citation {
  ms: number;
  label: string;
}

const MAX_PASSAGES = 6;
const CONTEXT_CHARS = 9000;

/** Ключ слова: первые 6 букв — «энтропия» и «энтропией» дают один ключ (грубо, но без словаря). */
const key = (t: string): string => (/^\p{N}+$/u.test(t) ? t : t.slice(0, 6));
const terms = (s: string): string[] => tokenize(s).map(key);

/**
 * Рейтинг отрывка = сумма IDF совпавших стемм. Редкое слово («энтропия»)
 * весит больше частого («это»), поэтому одиночный общий союз не вытеснит
 * отрывок с точным термином.
 */
export function pickPassages(
  chunks: AskChunk[],
  question: string,
  limit = MAX_PASSAGES,
): Passage[] {
  const q = [...new Set(terms(question))];
  const docs = chunks
    .filter((c) => String(c.text || "").trim())
    .map((c) => ({ c, set: new Set(terms(c.text)) }));
  if (!q.length || !docs.length) return [];
  const df = new Map<string, number>();
  for (const t of q) df.set(t, docs.filter((d) => d.set.has(t)).length);
  const n = docs.length;
  const scored = docs
    .map((d) => {
      let score = 0;
      for (const t of q) {
        if (d.set.has(t)) score += Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      }
      return { c: d.c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.start_ms - b.c.start_ms)
    .slice(0, limit);
  // В хронологическом порядке — так модели проще следить за ходом лекции.
  return scored
    .sort((a, b) => a.c.start_ms - b.c.start_ms)
    .map((x) => ({
      chunkId: x.c.id ?? null,
      startMs: x.c.start_ms,
      endMs: x.c.end_ms,
      text: String(x.c.text).trim(),
      score: Math.round(x.score * 100) / 100,
    }));
}

export function buildPrompt(question: string, passages: Passage[]): string {
  let used = 0;
  const lines: string[] = [];
  for (const p of passages) {
    const line = `[${fmtTs(p.startMs)}] ${p.text}`;
    if (used + line.length > CONTEXT_CHARS) break;
    used += line.length;
    lines.push(line);
  }
  return (
    "Ответь на вопрос по расшифровке лекции. Используй только приведённые отрывки. " +
    "После каждого утверждения ставь метку времени отрывка в формате [чч:мм:сс]. " +
    "Если в отрывках ответа нет — так и скажи, ничего не выдумывай.\n\n" +
    "=== ОТРЫВКИ ===\n" +
    lines.join("\n") +
    "\n\n=== ВОПРОС ===\n" +
    question.trim()
  );
}

/** Достаёт метки [чч:мм:сс] / [мм:сс] из ответа модели. */
export function parseCitations(answer: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<number>();
  for (const m of answer.matchAll(/\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g)) {
    const h = Number(m[1] ?? 0);
    const ms = ((h * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
    if (seen.has(ms)) continue;
    seen.add(ms);
    out.push({ ms, label: fmtTs(ms) });
  }
  return out;
}

/** Провайдер чата с ключом и моделью (как у конспекта); внедряется в тестах. */
export interface AskTarget {
  provider: { chat(opts: Record<string, unknown>): Promise<string> };
  secret: string;
  model: string;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  passages: Passage[];
}

export async function askLecture(
  id: number,
  question: string,
  opts: { appPage?: string | null; target?: AskTarget } = {},
): Promise<AskResult> {
  const q = String(question || "").trim();
  if (!q) throw new Error("empty_question");
  if (!stmts.lectureGet.get(id)) throw new Error("session_not_found");
  const passages = pickPassages(stmts.chunkFor.all(id) as unknown as AskChunk[], q);
  if (!passages.length) return { answer: "", citations: [], passages: [] };
  const target: AskTarget =
    opts.target ||
    ((await conspectusTarget(opts.appPage ?? null, "lecture.ask")) as unknown as AskTarget);
  const text = await runWithPage(opts.appPage ?? null, () =>
    target.provider.chat({
      secret: target.secret,
      model: target.model,
      messages: [
        {
          role: "system",
          text: "Ты помогаешь разбираться в записи лекции. Отвечай кратко, по-русски, со ссылками на метки времени.",
        },
        { role: "user", text: buildPrompt(q, passages) },
      ],
      temperature: 0.2,
      maxTokens: 1200,
      stream: true,
    }),
  );
  const answer = String(text || "").trim();
  return { answer, citations: parseCitations(answer), passages };
}

/* --------------------------- «Я пропустил» --------------------------- */

/** Отрывки, пересекающиеся с интервалом [fromMs, toMs], в хронологическом порядке. */
export function passagesInRange(chunks: AskChunk[], fromMs: number, toMs: number): Passage[] {
  return chunks
    .filter((c) => String(c.text || "").trim() && c.end_ms > fromMs && c.start_ms < toMs)
    .sort((a, b) => a.start_ms - b.start_ms)
    .map((c) => ({
      chunkId: c.id ?? null,
      startMs: c.start_ms,
      endMs: c.end_ms,
      text: String(c.text).trim(),
      score: 1,
    }));
}

const MISSED_MAX_CHARS = 14000;

/** Краткое изложение пропущенного фрагмента лекции (по таймкодам). */
export async function summarizeMissed(
  id: number,
  fromMs: number,
  toMs: number,
  opts: { appPage?: string | null; target?: AskTarget } = {},
): Promise<{ summary: string; passages: Passage[]; truncated: boolean }> {
  if (!stmts.lectureGet.get(id)) throw new Error("session_not_found");
  if (!(toMs > fromMs)) throw new Error("bad_range");
  const passages = passagesInRange(stmts.chunkFor.all(id) as unknown as AskChunk[], fromMs, toMs);
  if (!passages.length) return { summary: "", passages: [], truncated: false };
  let text = passages.map((p) => `[${fmtTs(p.startMs)}] ${p.text}`).join("\n");
  const truncated = text.length > MISSED_MAX_CHARS;
  if (truncated) text = text.slice(0, MISSED_MAX_CHARS);
  const target: AskTarget =
    opts.target ||
    ((await conspectusTarget(opts.appPage ?? null, "lecture.ask")) as unknown as AskTarget);
  const out = await runWithPage(opts.appPage ?? null, () =>
    target.provider.chat({
      secret: target.secret,
      model: target.model,
      messages: [
        {
          role: "system",
          text: "Ты помогаешь студенту, который пропустил часть лекции. Кратко и по пунктам перескажи, что было сказано, сохраняя термины и формулы. Не выдумывай того, чего нет в тексте. Ссылайся на метки [чч:мм:сс].",
        },
        { role: "user", text: `Что было на лекции в этом фрагменте?\n\n${text}` },
      ],
      temperature: 0.2,
      maxTokens: 1500,
      stream: true,
    }),
  );
  return { summary: String(out || "").trim(), passages, truncated };
}

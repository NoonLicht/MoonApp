/**
 * Локальный «интеллект» почты. Текст писем никуда не отправляется: ни облачным провайдерам,
 * ни онлайн-переводчикам. Всё считается на этом компьютере:
 *  - EmbeddingGemma (встроенный llama.cpp) даёт векторы смысла предложений и писем;
 *  - сводки и задачи — извлекающие: выбираются самые «центральные» предложения цепочки,
 *    письма за период группируются по темам кластеризацией векторов;
 *  - ответы и быстрые реплики — заготовки по определённому намерению письма;
 *  - перевод — только локальная модель приложения.
 * Если модель эмбеддингов не установлена или выключена, используется хеш-векторизация слов:
 * качество ниже, но функции продолжают работать.
 */
import { embedModelFile, embedRaw, withPrefix } from "../llamacpp/embed";
import { translateStrings } from "../rss";
import { mailDb } from "./mailDb";
import { getSettings } from "./mailSettings";
import { getMessage, getThread, type MessageFull } from "./mailService";

/* ------------------------------- тексты письма ------------------------------ */

function plainOf(m: MessageFull): string {
  const t =
    m.text || m.html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  return t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const SIGNATURE =
  /^(--\s*$|с уважением|best regards|kind regards|regards,|sent from|отправлено с|—\s*$)/i;

/** Предложения письма без цитат, подписи и «шума». */
function sentencesOf(text: string, max = 400): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    if (SIGNATURE.test(line)) break;
    if (line.startsWith(">") || /^(on .+ wrote:|.+ (написал|пишет)\(?а?\)?:)$/i.test(line))
      continue;
    for (const s of line.split(/(?<=[.!?…])\s+/)) {
      const t = s.trim();
      if (t.length < 12 || t.length > 500) continue;
      if ((t.match(/https?:\/\//g) ?? []).length > 1) continue;
      out.push(t);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function detectLang(text: string, hint?: string): string {
  const h = (hint || getSettings().ai.language || "").slice(0, 2).toLowerCase();
  if (h) return h;
  const cyr = (text.match(/[а-яё]/gi) ?? []).length;
  const lat = (text.match(/[a-z]/gi) ?? []).length;
  return cyr > lat ? "ru" : "en";
}

/* --------------------------------- векторы --------------------------------- */

const DIM = 256;

function hashVec(text: string): Float32Array {
  const v = new Float32Array(DIM);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  for (const w of words) {
    // русские окончания отбрасываем грубо: «писем/письма/письмо» → один корень
    const stem = w.length > 5 ? w.slice(0, w.length - 2) : w;
    let h = 2166136261;
    for (let i = 0; i < stem.length; i++) h = Math.imul(h ^ stem.charCodeAt(i), 16777619);
    v[(h >>> 0) % DIM] += (h & 0x100) === 0 ? 1 : -1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

/** Векторы смысла: EmbeddingGemma, а без модели — хеш слов. Размер всегда одинаковый. */
async function vectors(texts: string[]): Promise<{ vecs: Float32Array[]; semantic: boolean }> {
  if (!texts.length) return { vecs: [], semantic: false };
  if (embedModelFile()) {
    try {
      const vecs = await embedRaw(texts.map((t) => withPrefix(t, "similar")));
      if (vecs.length === texts.length) return { vecs, semantic: true };
    } catch {
      /* модель не запустилась — работаем без неё */
    }
  }
  return { vecs: texts.map(hashVec), semantic: false };
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function centroid(vs: Float32Array[]): Float32Array {
  const c = new Float32Array(vs[0]?.length ?? DIM);
  for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i];
  let n = 0;
  for (const x of c) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < c.length; i++) c[i] /= n;
  return c;
}

/** Самые «центральные» предложения (MMR: важные и не повторяющие друг друга), в порядке текста. */
async function pickCentral(sentences: string[], k: number): Promise<string[]> {
  if (sentences.length <= k) return sentences;
  const { vecs } = await vectors(sentences);
  const c = centroid(vecs);
  const rel = vecs.map((v, i) => dot(v, c) + (i < 3 ? 0.04 : 0));
  const chosen: number[] = [];
  while (chosen.length < k) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < vecs.length; i++) {
      if (chosen.includes(i)) continue;
      const red = chosen.length ? Math.max(...chosen.map((j) => dot(vecs[i], vecs[j]))) : 0;
      const s = 0.7 * rel[i] - 0.3 * red;
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    if (best < 0) break;
    chosen.push(best);
  }
  return chosen.sort((a, b) => a - b).map((i) => sentences[i]);
}

/* --------------------------- заготовки по языкам --------------------------- */

type Intent = "question" | "meeting" | "thanks" | "request" | "info";

function intentOf(text: string): Intent {
  const t = text.toLowerCase();
  if (/(встреч|созвон|звонок|календар|meeting|call\b|invite|schedule|приглашен)/.test(t))
    return "meeting";
  if (/(спасибо|благодар|thank)/.test(t) && !/\?/.test(t)) return "thanks";
  if (/\?/.test(t)) return "question";
  if (/(пожалуйста|прошу|необходимо|нужно|please|could you|can you|need to|would you)/.test(t))
    return "request";
  return "info";
}

const T: Record<string, Record<string, string>> = {
  ru: {
    hello: "Здравствуйте",
    helloName: "Здравствуйте, {name}",
    bye: "С уважением",
    question: "Спасибо за письмо. Уточню детали и отвечу в ближайшее время.",
    meeting:
      "Спасибо за приглашение. Подтверждаю участие — пришлите, пожалуйста, детали, если они изменятся.",
    thanks: "Пожалуйста! Обращайтесь, если понадобится что-то ещё.",
    request: "Принял(а) запрос. Займусь этим и вернусь с результатом.",
    info: "Спасибо, информацию получил(а).",
    q1: "Спасибо, посмотрю и отвечу",
    q2: "Хорошо, договорились",
    q3: "Можно чуть позже?",
    m1: "Подтверждаю, буду",
    m2: "Не смогу в это время, предложите другое",
    m3: "Давайте перенесём",
    t1: "Всегда пожалуйста",
    t2: "Рад(а) помочь",
    t3: "Обращайтесь",
    r1: "Сделаю, дам знать",
    r2: "Нужно немного времени",
    r3: "Уточните, пожалуйста, детали",
    i1: "Спасибо, принято",
    i2: "Понял(а), спасибо",
    i3: "Хорошо, учту",
    gist: "Суть",
    messages: "Писем в цепочке",
    noText: "В письме нет текста для сводки.",
    needReply: "Требуют ответа",
    important: "Важное и личное",
    work: "Работа и дела",
    services: "Сервисы и уведомления",
    promo: "Рассылки и реклама",
    overall: "За период получено писем: {n}, из них непрочитанных: {u}.",
    similar: "ещё {n}",
  },
  en: {
    hello: "Hello",
    helloName: "Hello {name}",
    bye: "Best regards",
    question: "Thank you for your message. I will look into the details and get back to you soon.",
    meeting:
      "Thank you for the invitation. I confirm my attendance — please send details if anything changes.",
    thanks: "You're welcome! Let me know if you need anything else.",
    request: "Got your request. I will take care of it and come back with the result.",
    info: "Thank you, I have received the information.",
    q1: "Thanks, I'll look and reply",
    q2: "Sounds good",
    q3: "Can it wait a bit?",
    m1: "Confirmed, I'll be there",
    m2: "I can't make it, please suggest another time",
    m3: "Let's reschedule",
    t1: "You're welcome",
    t2: "Happy to help",
    t3: "Anytime",
    r1: "On it, will let you know",
    r2: "I need a bit more time",
    r3: "Please clarify the details",
    i1: "Thanks, noted",
    i2: "Got it, thank you",
    i3: "Okay, will keep in mind",
    gist: "Gist",
    messages: "Messages in thread",
    noText: "The message has no text to summarize.",
    needReply: "Need a reply",
    important: "Important & personal",
    work: "Work & tasks",
    services: "Services & notifications",
    promo: "Newsletters & promotions",
    overall: "Messages in the period: {n}, unread: {u}.",
    similar: "{n} more",
  },
};
const tr = (lang: string, key: string, vars: Record<string, string | number> = {}): string =>
  (T[lang]?.[key] ?? T.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) =>
    String(vars[k] ?? ""),
  );

function capitalise(s: string): string {
  const t = s.trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function toHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function threadSentences(id: string): {
  subject: string;
  sentences: string[];
  msgs: MessageFull[];
} {
  const msgs = getThread(id);
  const subject = msgs[msgs.length - 1]?.subject || msgs[0]?.subject || "";
  const sentences = msgs.flatMap((m) => sentencesOf(plainOf(m), 120));
  return { subject, sentences, msgs };
}

/* ------------------------------- запросы ИИ ------------------------------- */

export interface AiRequest {
  action:
    | "summarize"
    | "reply"
    | "compose"
    | "improve"
    | "subject"
    | "quick"
    | "tasks"
    | "translate"
    | "digest";
  id?: string;
  text?: string;
  instruction?: string;
  tone?: string;
  mode?: string;
  lang?: string;
  engine?: string;
  period?: "day" | "week";
  account?: string;
}

const ACTION_RE =
  /(пожалуйста|прошу|необходимо|нужно|надо|не забудьте|подтвердите|пришлите|отправьте|ответьте|до \d|к \d|срок|дедлайн|please|need to|must|deadline|by (mon|tue|wed|thu|fri|sat|sun|tomorrow|end of)|could you|can you|asap|confirm|send me|let me know)/i;

export async function runAi(
  r: AiRequest,
): Promise<{ text?: string; html?: string; list?: string[]; blocks?: string[] }> {
  if (!getSettings().ai.enabled) throw new Error("ai_disabled");
  switch (r.action) {
    case "summarize": {
      if (!r.id) throw new Error("id_required");
      const { subject, sentences, msgs } = threadSentences(r.id);
      const lang = detectLang(sentences.join(" "), r.lang);
      if (!sentences.length) return { text: tr(lang, "noText") };
      const k = Math.min(5, Math.max(2, Math.ceil(sentences.length / 6)));
      const key = await pickCentral(sentences, k);
      const text =
        `**${tr(lang, "gist")}:** ${subject || key[0]}\n\n` +
        key.map((s) => `- ${s}`).join("\n") +
        (msgs.length > 1 ? `\n\n_${tr(lang, "messages")}: ${msgs.length}_` : "");
      return { text };
    }
    case "tasks": {
      if (!r.id) throw new Error("id_required");
      const { sentences } = threadSentences(r.id);
      if (!sentences.length) return { list: [] };
      const protos = [
        "Please do this task and send the result before the deadline",
        "Пожалуйста, подготовьте и пришлите до пятницы",
        "We have a meeting scheduled, please confirm attendance",
        "Необходимо подтвердить встречу и срок",
      ];
      const { vecs, semantic } = await vectors([...sentences, ...protos]);
      const pv = vecs.slice(sentences.length);
      const scored = sentences.map((s, i) => {
        const rx = ACTION_RE.test(s) ? 0.5 : 0;
        const q = /\?\s*$/.test(s) ? 0.2 : 0;
        const sim = Math.max(...pv.map((p) => dot(vecs[i], p)));
        return { s, score: rx + q + (semantic ? Math.max(0, sim - 0.45) : 0) };
      });
      const list = scored
        .filter((x) => x.score >= 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map((x) => x.s);
      return { list };
    }
    case "quick": {
      if (!r.id) throw new Error("id_required");
      const m = getMessage(r.id);
      if (!m) throw new Error("not_found");
      const body = plainOf(m).slice(0, 2000);
      const lang = detectLang(body, r.lang);
      const intent = intentOf(`${m.subject}. ${body}`);
      const p = { question: "q", meeting: "m", thanks: "t", request: "r", info: "i" }[intent];
      return { list: [1, 2, 3].map((n) => tr(lang, `${p}${n}`)) };
    }
    case "reply": {
      if (!r.id) throw new Error("id_required");
      const th = getThread(r.id);
      const last = th[th.length - 1];
      if (!last) throw new Error("not_found");
      const body = plainOf(last).slice(0, 3000);
      const lang = detectLang(body, r.lang);
      const name = (last.fromName || "").split(/\s+/)[0];
      const hello = name ? tr(lang, "helloName", { name }) : tr(lang, "hello");
      const core = r.instruction?.trim()
        ? capitalise(r.instruction.trim().replace(/[.]*$/, "."))
        : tr(lang, intentOf(`${last.subject}. ${body}`));
      const text = `${hello}!\n\n${core}\n\n${tr(lang, "bye")}`;
      return { text, html: toHtml(text) };
    }
    case "compose": {
      const draft = (r.text || "").trim();
      const lang = detectLang(`${r.instruction ?? ""} ${draft}`, r.lang);
      const core = draft || capitalise((r.instruction || "").trim().replace(/[.]*$/, "."));
      const text = `${tr(lang, "hello")}!\n\n${core}\n\n${tr(lang, "bye")}`;
      return { text, html: toHtml(text) };
    }
    case "improve": {
      const src = (r.text || "").slice(0, 8000);
      const mode = r.mode || "fix";
      if (mode === "shorten") {
        const sentences = sentencesOf(src, 80);
        if (sentences.length < 3) return { text: src, html: toHtml(src) };
        const out = (
          await pickCentral(sentences, Math.max(2, Math.ceil(sentences.length * 0.6)))
        ).join(" ");
        return { text: out, html: toHtml(out) };
      }
      if (mode !== "fix")
        throw new Error(
          "This rewrite needs a text-generating model. Mail text is processed locally only, so only “fix” and “shorten” are available.",
        );
      const out = src
        .replace(/[ \t]+/g, " ")
        .replace(/\s+([,.!?;:])/g, "$1")
        .replace(/([,.!?;:])(?=[^\s\d"')\]}])/g, "$1 ")
        .replace(/([!?.]){4,}/g, "$1$1$1")
        .replace(/(^|[.!?]\s+|\n)([a-zа-яё])/g, (_m, a: string, b: string) => a + b.toUpperCase())
        .trim();
      return { text: out, html: toHtml(out) };
    }
    case "subject": {
      const sentences = sentencesOf(r.text || "", 60);
      if (!sentences.length) return { list: [] };
      const key = await pickCentral(sentences, Math.min(3, sentences.length));
      const list = key
        .map((s) =>
          capitalise(
            s
              .replace(/^(здравствуйте|привет|добрый день|hello|hi|dear)[^.!?]*[.!?]\s*/i, "")
              .split(/\s+/)
              .slice(0, 8)
              .join(" ")
              .replace(/[.,;:!?…]+$/, ""),
          ),
        )
        .filter(Boolean);
      return { list: [...new Set(list)].slice(0, 3) };
    }
    case "translate": {
      if (!r.id && !r.text) throw new Error("id_required");
      const lang = (r.lang || "ru").slice(0, 2).toLowerCase();
      const src = r.text ?? plainOf(getMessage(r.id as string) as MessageFull).slice(0, 20000);
      const chunks = src
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200);
      // только локальная модель: онлайн-переводчики получили бы текст письма
      let res;
      try {
        res = await translateStrings(chunks, lang, "local");
      } catch (e) {
        throw new Error(
          "Local translation model is unavailable (install it in the Translator page): " +
            (e as Error).message,
          { cause: e },
        );
      }
      const blocks = chunks.map((c, i) => res.out[i] ?? c);
      return { text: blocks.join("\n\n"), blocks };
    }
    case "digest":
      return digest(r);
    default:
      throw new Error("unknown_action");
  }
}

/* --------------------------------- сводка --------------------------------- */

type Cat = "important" | "work" | "services" | "promo";

const CAT_PROTOS: Record<Cat, string[]> = {
  important: [
    "personal message from a friend or family member",
    "личное сообщение от знакомого или близкого",
    "invoice, payment or bank notice that needs attention",
  ],
  work: [
    "work project discussion, task, meeting or report",
    "рабочая переписка: задача, проект, встреча, отчёт",
  ],
  services: [
    "automatic notification, security alert, login or password confirmation",
    "автоматическое уведомление сервиса, код подтверждения, безопасность аккаунта",
  ],
  promo: [
    "advertising newsletter with discounts and special offers",
    "рекламная рассылка со скидками и акциями",
  ],
};

interface DigestRow {
  id: string;
  from_name: string;
  from_addr: string;
  subject: string;
  snippet: string;
  date: number;
  seen: number;
}

function ruleCategory(m: DigestRow): Cat | null {
  const s = `${m.subject} ${m.snippet}`.toLowerCase();
  if (
    /(скидк|акци[яи]|распродаж|sale\b|% off|промокод|рассылк|unsubscribe|отписаться|newsletter)/.test(
      s,
    )
  )
    return "promo";
  if (
    /(no-?reply|noreply|donotreply|notification|notify|mailer-daemon|alerts?@|security@)/i.test(
      m.from_addr,
    )
  )
    return "services";
  if (
    /(пароль|код подтверждения|вход в аккаунт|безопасност|verify|security alert|sign-?in|one-time)/.test(
      s,
    )
  )
    return "services";
  return null;
}

async function digest(r: AiRequest): Promise<{ text: string; list: string[] }> {
  const days = r.period === "week" ? 7 : 1;
  const since = Date.now() - days * 86_400_000;
  const rows = mailDb()
    .prepare(
      `SELECT m.id, m.from_name, m.from_addr, m.subject, m.snippet, m.date, m.seen
       FROM messages m JOIN folders f ON f.account = m.account AND f.path = m.folder
       WHERE m.date >= ? AND f.special = '\\Inbox' ${r.account ? "AND m.account = ?" : ""}
       ORDER BY m.date DESC LIMIT 400`,
    )
    .all(...(r.account ? [since, r.account] : [since])) as DigestRow[];
  if (!rows.length) return { text: "", list: ["0"] };

  const lang = detectLang(rows.map((m) => m.subject).join(" "), r.lang);
  const docs = rows.map((m) => `${m.from_name || m.from_addr}. ${m.subject}. ${m.snippet}`);
  const protoList = (Object.keys(CAT_PROTOS) as Cat[]).flatMap((c) =>
    CAT_PROTOS[c].map((p) => ({ c, p })),
  );
  const { vecs, semantic } = await vectors([...docs, ...protoList.map((x) => x.p)]);
  const dv = vecs.slice(0, rows.length);
  const pv = vecs.slice(rows.length);

  const catOf = (i: number): Cat => {
    const rule = ruleCategory(rows[i]);
    if (rule) return rule;
    if (!semantic) return "work";
    let best: Cat = "work";
    let bestS = -1;
    protoList.forEach((x, j) => {
      const s = dot(dv[i], pv[j]);
      if (s > bestS) {
        bestS = s;
        best = x.c;
      }
    });
    return best;
  };

  // письма, на которые ждут ответа: непрочитанные с вопросом/просьбой не из рассылок
  const needsReply = (i: number): boolean => {
    const m = rows[i];
    if (m.seen) return false;
    const c = ruleCategory(m);
    if (c === "promo" || c === "services") return false;
    return /\?/.test(`${m.subject} ${m.snippet}`) || ACTION_RE.test(m.snippet);
  };

  // группировка похожих писем внутри категории (жадно, по близости к «ядру» группы)
  const THRESH = semantic ? 0.82 : 0.6;
  const cats: Record<Cat, number[][]> = { important: [], work: [], services: [], promo: [] };
  const replySet = new Set(rows.map((_m, i) => i).filter(needsReply));
  rows.forEach((_m, i) => {
    if (replySet.has(i)) return; // уже в блоке «Требуют ответа»
    const c = catOf(i);
    const same = (j: number) =>
      rows[j].from_addr === rows[i].from_addr && rows[j].subject === rows[i].subject;
    const target = cats[c].find((g) => same(g[0]) || dot(dv[g[0]], dv[i]) >= THRESH);
    if (target) target.push(i);
    else cats[c].push([i]);
  });

  const line = (g: number[]): string => {
    const head = rows[g[0]];
    const senders = [...new Set(g.map((i) => rows[i].from_name || rows[i].from_addr))];
    const who = senders.slice(0, 2).join(", ") + (senders.length > 2 ? "…" : "");
    const more = g.length > 1 ? ` (${tr(lang, "similar", { n: g.length - 1 })})` : "";
    return `- **${who}** — ${head.subject || "…"}${more}`;
  };

  const parts: string[] = [];
  const unread = rows.filter((m) => !m.seen).length;
  parts.push(tr(lang, "overall", { n: rows.length, u: unread }));

  const reply = rows.map((_m, i) => i).filter(needsReply);
  if (reply.length)
    parts.push(
      `**${tr(lang, "needReply")}**\n` +
        reply
          .slice(0, 10)
          .map((i) => `- **${rows[i].from_name || rows[i].from_addr}** — ${rows[i].subject || "…"}`)
          .join("\n"),
    );

  for (const c of ["important", "work", "services", "promo"] as Cat[]) {
    const groups = cats[c].filter((g) => g.length);
    if (!groups.length) continue;
    const shown = groups.slice(0, c === "promo" || c === "services" ? 6 : 12);
    const rest = groups.length - shown.length;
    parts.push(
      `**${tr(lang, c)}**\n` +
        shown.map(line).join("\n") +
        (rest > 0 ? `\n- … ${tr(lang, "similar", { n: rest })}` : ""),
    );
  }
  return { text: parts.join("\n\n"), list: [String(rows.length)] };
}

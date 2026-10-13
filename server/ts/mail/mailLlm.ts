/**
 * Генеративные ИИ-функции почты через языковую модель: облачный провайдер приложения или
 * локальная llama.cpp. Включается в настройках почты («Движок ИИ»); по умолчанию почта
 * считает всё локально через EmbeddingGemma (mailAi.ts) и ничего не отправляет наружу.
 */
import { askModel, type LlmTarget } from "../llmOnce";
import { getProvider } from "../providers";
import { getSecret } from "../security";
import { getSettings } from "./mailSettings";
import { getMessage, getThread, type MessageFull } from "./mailService";
import { mailDb } from "./mailDb";
import type { AiRequest } from "./mailAi";

const LANG_NAMES: Record<string, string> = {
  ru: "Russian",
  en: "English",
  es: "Spanish",
  fr: "French",
  zh: "Chinese",
  ar: "Arabic",
};

const SYSTEM =
  "You are an email assistant inside a desktop mail client. Be concise and accurate. " +
  "Never invent facts that are not in the email. Output only what is asked, with no preamble.";

type Out = { text?: string; html?: string; list?: string[]; blocks?: string[] };

function plain(m: MessageFull, max = 6000): string {
  const t =
    m.text || m.html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  return t
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function threadText(id: string, perMessage = 2500, total = 12000): string {
  return getThread(id)
    .map(
      (m) =>
        `From: ${m.fromName || m.fromAddr} <${m.fromAddr}>\nDate: ${new Date(m.date).toISOString()}\nSubject: ${m.subject}\n\n${plain(m, perMessage)}`,
    )
    .join("\n\n-----\n\n")
    .slice(-total);
}

function langName(code?: string): string {
  const c = (code || getSettings().ai.language || "").slice(0, 2).toLowerCase();
  return LANG_NAMES[c] || "the same language as the email";
}

function toHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Выбранная в настройках модель; undefined — модель «ИИ-конспекта» (общая по приложению). */
async function target(): Promise<LlmTarget | undefined> {
  const ai = getSettings().ai;
  if (ai.engine === "llamacpp") {
    const provider = getProvider("llamacpp");
    const model = ai.model || (await provider.listModels(""))[0] || "";
    if (!model) throw new Error("llamacpp_model_missing");
    return { provider, secret: getSecret("llamacpp") || "local", model } as unknown as LlmTarget;
  }
  if (ai.engine === "provider" && ai.providerId) {
    const provider = getProvider(ai.providerId);
    const secret = getSecret(provider.id);
    if (!secret) throw new Error("provider_not_configured: " + provider.id);
    let model = ai.model;
    if (!model) {
      let list: string[] = [];
      try {
        list = (await provider.listModels(secret)) as string[];
      } catch {
        /* нет сети — каталог провайдера */
      }
      if (!list.length) list = (provider.models as string[]) || [];
      model = list.find((m) => /chat|turbo|flash|mini|small|lite/i.test(m)) || list[0] || "";
    }
    if (!model) throw new Error("model_missing: " + provider.id);
    return { provider, secret, model } as unknown as LlmTarget;
  }
  return undefined;
}

export async function ask(
  system: string,
  user: string,
  o: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  return askModel(system, user, { appPage: "mail", target: await target(), ...o });
}

async function safeAsk(system: string, user: string, maxTokens: number): Promise<string> {
  try {
    return await ask(system, user, { maxTokens });
  } catch {
    return "";
  }
}

export async function translateWithModel(src: string, lang: string): Promise<string> {
  return ask(
    "You are a precise translator. Translate the text keeping line breaks, lists and names. Output only the translation.",
    `Translate into ${LANG_NAMES[lang] || lang}:\n\n${src.slice(0, 12000)}`,
    { maxTokens: 3000, temperature: 0.1 },
  );
}

export async function runLlm(r: AiRequest): Promise<Out> {
  const tone = r.tone || getSettings().ai.tone || "neutral";
  switch (r.action) {
    case "summarize": {
      if (!r.id) throw new Error("id_required");
      const out = await ask(
        SYSTEM,
        `Summarize this email conversation in ${langName(r.lang)}. Format: one short line with the gist, ` +
          `then up to 5 bullet points with key facts, decisions, dates and what is asked of the reader.\n\n${threadText(r.id)}`,
        { maxTokens: 700 },
      );
      return { text: out };
    }
    case "reply": {
      if (!r.id) throw new Error("id_required");
      const out = await ask(
        SYSTEM,
        `Write a reply to the last message of this conversation in ${langName(r.lang)}. Tone: ${tone}. ` +
          `${r.instruction ? `The user wants the reply to: ${r.instruction}.` : "Address every question asked."} ` +
          `Do not include the subject line, quoted text or a signature. Start directly with the greeting.\n\n${threadText(r.id)}`,
        { maxTokens: 900, temperature: 0.5 },
      );
      return { text: out, html: toHtml(out) };
    }
    case "compose": {
      const out = await ask(
        SYSTEM,
        `Write an email in ${langName(r.lang)}. Tone: ${tone}. Instruction: ${r.instruction || ""}. ` +
          `${r.text ? `Existing draft to build on:\n${r.text.slice(0, 4000)}\n` : ""}` +
          `Return only the body (greeting, text, closing) without a subject and without a signature.`,
        { maxTokens: 900, temperature: 0.6 },
      );
      return { text: out, html: toHtml(out) };
    }
    case "improve": {
      const how: Record<string, string> = {
        fix: "Fix spelling, grammar and punctuation. Keep wording and meaning.",
        shorten: "Make it shorter and clearer without losing key points.",
        expand: "Expand it slightly with polite, useful detail without inventing facts.",
        formal: "Rewrite in a formal, professional tone.",
        friendly: "Rewrite in a warm, friendly tone.",
      };
      const out = await ask(
        SYSTEM,
        `${how[r.mode || "fix"] || how.fix} Keep the language of the text. Return only the rewritten text.\n\n${(r.text || "").slice(0, 6000)}`,
        { maxTokens: 1200, temperature: 0.3 },
      );
      return { text: out, html: toHtml(out) };
    }
    case "subject": {
      const out = await ask(
        SYSTEM,
        `Suggest 3 short subject lines (max 8 words each) for this email, one per line, no numbering, same language as the email.\n\n${(r.text || "").slice(0, 3000)}`,
        { maxTokens: 120, temperature: 0.7 },
      );
      return {
        list: out
          .split(/\n+/)
          .map((s) => s.replace(/^[-*\d.\s"]+|"$/g, "").trim())
          .filter(Boolean)
          .slice(0, 3),
      };
    }
    case "quick": {
      if (!r.id) throw new Error("id_required");
      const m = getMessage(r.id);
      if (!m) throw new Error("not_found");
      const out = await ask(
        SYSTEM,
        `Suggest 3 very short possible replies (max 12 words each) to this email, in the same language as the email. ` +
          `Return a JSON array of 3 strings only.\n\n${plain(m, 3000)}`,
        { maxTokens: 200, temperature: 0.7 },
      );
      try {
        const arr = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)) as unknown[];
        return { list: arr.map(String).slice(0, 3) };
      } catch {
        return {
          list: out
            .split(/\n+/)
            .map((s) => s.replace(/^[-*\d.\s"]+|"[,]?$/g, "").trim())
            .filter(Boolean)
            .slice(0, 3),
        };
      }
    }
    case "tasks": {
      if (!r.id) throw new Error("id_required");
      const out = await ask(
        SYSTEM,
        `List the concrete action items, deadlines and meetings from this email conversation in ${langName(r.lang)}, ` +
          `one per line starting with "- ". If there are none, reply with "-".\n\n${threadText(r.id)}`,
        { maxTokens: 500 },
      );
      return {
        list: out
          .split(/\n+/)
          .map((s) => s.replace(/^[-*•]\s*/, "").trim())
          .filter((s) => s && s !== "-"),
      };
    }
    case "digest":
      return digestLlm(r);
    default:
      throw new Error("unknown_action");
  }
}

/** Сводка пакетами: порции сжимаются в тезисы, затем сливаются — длинная неделя не ломает запрос. */
async function digestLlm(r: AiRequest): Promise<Out> {
  const days = r.period === "week" ? 7 : 1;
  const rows = mailDb()
    .prepare(
      `SELECT m.from_name, m.from_addr, m.subject, m.snippet
       FROM messages m JOIN folders f ON f.account = m.account AND f.path = m.folder
       WHERE m.date >= ? AND f.special = '\\Inbox' ${r.account ? "AND m.account = ?" : ""}
       ORDER BY m.date DESC LIMIT 400`,
    )
    .all(
      ...(r.account
        ? [Date.now() - days * 86_400_000, r.account]
        : [Date.now() - days * 86_400_000]),
    ) as {
    from_name: string;
    from_addr: string;
    subject: string;
    snippet: string;
  }[];
  if (!rows.length) return { text: "", list: ["0"] };
  const groups = new Map<string, { who: string; subject: string; snippet: string; n: number }>();
  for (const m of rows) {
    const key = `${m.from_addr}|${m.subject}`;
    const g = groups.get(key);
    if (g) g.n++;
    else
      groups.set(key, {
        who: m.from_name || m.from_addr,
        subject: m.subject || "(no subject)",
        snippet: m.snippet,
        n: 1,
      });
  }
  const entries = [...groups.values()];
  const BATCH = 18;
  const batches: (typeof entries)[] = [];
  for (let i = 0; i < entries.length; i += BATCH) batches.push(entries.slice(i, i + BATCH));
  const partial: string[] = new Array(batches.length).fill("");
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const i = next++;
      const lines = batches[i]
        .map(
          (g) =>
            `- ${g.who} | ${g.subject}${g.n > 1 ? ` (x${g.n})` : ""} | ${g.snippet.slice(0, 140)}`,
        )
        .join("\n");
      const out = await safeAsk(
        SYSTEM,
        `Summarize these emails in ${langName(r.lang)} as 3-8 short bullet points. Name senders, ` +
          `merge similar notifications, and mark anything that needs a reply or has a deadline.\n\n${lines}`,
        700,
      );
      partial[i] = out.trim()
        ? out
        : batches[i]
            .map((g) => `- ${g.who}: ${g.subject}${g.n > 1 ? ` (x${g.n})` : ""}`)
            .join("\n");
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, worker));
  if (batches.length === 1) return { text: partial[0], list: [String(rows.length)] };
  const merged = partial.map((p, i) => `Part ${i + 1}:\n${p}`).join("\n\n");
  let out = await safeAsk(
    SYSTEM,
    `Below are summaries of ${rows.length} emails received in the last ${days === 1 ? "24 hours" : "7 days"}, split into parts. ` +
      `Write one digest in ${langName(r.lang)}: first one line with the overall picture, then group by topic ` +
      `(important/personal, work, services & notifications, newsletters/promotions) with short bullet points. ` +
      `Name senders, call out replies needed and deadlines, skip empty groups.\n\n${merged}`,
    1600,
  );
  if (!out.trim()) out = partial.join("\n\n");
  return { text: out, list: [String(rows.length)] };
}

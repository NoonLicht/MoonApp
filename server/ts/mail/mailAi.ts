/**
 * ИИ-помощник почты: сводка, черновик ответа, улучшение текста, быстрые ответы, задачи из письма
 * и перевод письма (общий движок перевода приложения — как в RSS).
 * Запросы идут через слой провайдеров приложения («Щит для ИИ», журнал) — своих ключей нет.
 */
import { askModel } from "../llmOnce";
import { translateStrings, normEngine } from "../rss";
import { getSettings } from "./mailSettings";
import { getMessage, getThread, type MessageFull } from "./mailService";

const LANG_NAMES: Record<string, string> = {
  ru: "Russian",
  en: "English",
  es: "Spanish",
  fr: "French",
  zh: "Chinese",
  ar: "Arabic",
};

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
  const th = getThread(id);
  const parts = th.map(
    (m) =>
      `From: ${m.fromName || m.fromAddr} <${m.fromAddr}>\nDate: ${new Date(m.date).toISOString()}\nSubject: ${m.subject}\n\n${plain(m, perMessage)}`,
  );
  return parts.join("\n\n-----\n\n").slice(-total);
}

function langName(code?: string): string {
  const c = (code || getSettings().ai.language || "").slice(0, 2).toLowerCase();
  return LANG_NAMES[c] || "the same language as the email";
}

const SYSTEM =
  "You are an email assistant inside a desktop mail client. Be concise and accurate. " +
  "Never invent facts that are not in the email. Output only what is asked, with no preamble.";

function toHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export interface AiRequest {
  action:
    "summarize" | "reply" | "compose" | "improve" | "subject" | "quick" | "tasks" | "translate";
  id?: string;
  text?: string;
  instruction?: string;
  tone?: string;
  mode?: string;
  lang?: string;
  engine?: string;
}

export async function runAi(
  r: AiRequest,
): Promise<{ text?: string; html?: string; list?: string[]; blocks?: string[] }> {
  if (!getSettings().ai.enabled) throw new Error("ai_disabled");
  const tone = r.tone || getSettings().ai.tone || "neutral";
  switch (r.action) {
    case "summarize": {
      if (!r.id) throw new Error("id_required");
      const out = await askModel(
        SYSTEM,
        `Summarize this email conversation in ${langName(r.lang)}. Format: one short line with the gist, ` +
          `then up to 5 bullet points with key facts, decisions, dates and what is asked of the reader.\n\n${threadText(r.id)}`,
        { appPage: "mail", maxTokens: 700 },
      );
      return { text: out };
    }
    case "reply": {
      if (!r.id) throw new Error("id_required");
      const out = await askModel(
        SYSTEM,
        `Write a reply to the last message of this conversation in ${langName(r.lang)}. Tone: ${tone}. ` +
          `${r.instruction ? `The user wants the reply to: ${r.instruction}.` : "Address every question asked."} ` +
          `Do not include the subject line, quoted text or a signature. Start directly with the greeting.\n\n${threadText(r.id)}`,
        { appPage: "mail", maxTokens: 900, temperature: 0.5 },
      );
      return { text: out, html: toHtml(out) };
    }
    case "compose": {
      const out = await askModel(
        SYSTEM,
        `Write an email in ${langName(r.lang)}. Tone: ${tone}. Instruction: ${r.instruction || ""}. ` +
          `${r.text ? `Existing draft to build on:\n${r.text.slice(0, 4000)}\n` : ""}` +
          `Return only the body (greeting, text, closing) without a subject and without a signature.`,
        { appPage: "mail", maxTokens: 900, temperature: 0.6 },
      );
      return { text: out, html: toHtml(out) };
    }
    case "improve": {
      const mode = r.mode || "fix";
      const how: Record<string, string> = {
        fix: "Fix spelling, grammar and punctuation. Keep wording and meaning.",
        shorten: "Make it shorter and clearer without losing key points.",
        expand: "Expand it slightly with polite, useful detail without inventing facts.",
        formal: "Rewrite in a formal, professional tone.",
        friendly: "Rewrite in a warm, friendly tone.",
      };
      const out = await askModel(
        SYSTEM,
        `${how[mode] || how.fix} Keep the language of the text. Return only the rewritten text.\n\n${(r.text || "").slice(0, 6000)}`,
        { appPage: "mail", maxTokens: 1200, temperature: 0.3 },
      );
      return { text: out, html: toHtml(out) };
    }
    case "subject": {
      const out = await askModel(
        SYSTEM,
        `Suggest 3 short subject lines (max 8 words each) for this email, one per line, no numbering, same language as the email.\n\n${(r.text || "").slice(0, 3000)}`,
        { appPage: "mail", maxTokens: 120, temperature: 0.7 },
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
      const out = await askModel(
        SYSTEM,
        `Suggest 3 very short possible replies (max 12 words each) to this email, in the same language as the email. ` +
          `Return a JSON array of 3 strings only.\n\n${plain(m, 3000)}`,
        { appPage: "mail", maxTokens: 200, temperature: 0.7 },
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
      const out = await askModel(
        SYSTEM,
        `List the concrete action items, deadlines and meetings from this email conversation in ${langName(r.lang)}, ` +
          `one per line starting with "- ". If there are none, reply with "-".\n\n${threadText(r.id)}`,
        { appPage: "mail", maxTokens: 500 },
      );
      return {
        list: out
          .split(/\n+/)
          .map((s) => s.replace(/^[-*•]\s*/, "").trim())
          .filter((s) => s && s !== "-"),
      };
    }
    case "translate": {
      if (!r.id && !r.text) throw new Error("id_required");
      const lang = (r.lang || "ru").slice(0, 2).toLowerCase();
      const src = r.text ?? plain(getMessage(r.id as string) as MessageFull, 20000);
      const chunks = src
        .split(/\n{2,}|\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200);
      const engine = normEngine(r.engine);
      if (engine === "ai") {
        const out = await askModel(
          "You are a precise translator. Translate the text keeping line breaks, lists and names. Output only the translation.",
          `Translate into ${LANG_NAMES[lang] || lang}:\n\n${src.slice(0, 12000)}`,
          { appPage: "mail", maxTokens: 3000, temperature: 0.1 },
        );
        return { text: out, blocks: out.split(/\n+/).filter(Boolean) };
      }
      const res = await translateStrings(chunks, lang, engine);
      const blocks = chunks.map((c, i) => res.out[i] ?? c);
      return { text: blocks.join("\n\n"), blocks };
    }
    default:
      throw new Error("unknown_action");
  }
}

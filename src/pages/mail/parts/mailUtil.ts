import DOMPurify from "dompurify";
import type { MailAddr } from "@/api/apiMail";

export function addrLabel(a: MailAddr): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function addrShort(a: { name?: string; address?: string }): string {
  return a.name || a.address || "";
}

export function initials(s: string): string {
  const w = s.replace(/<.*>/, "").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return ((w[0][0] ?? "") + (w.length > 1 ? (w[1][0] ?? "") : "")).toUpperCase();
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function fmtDate(ts: number, lang: string, long = false): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (long) return d.toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });
  if (sameDay) return d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString(lang, { day: "numeric", month: "short" });
  return d.toLocaleDateString(lang, { year: "2-digit", month: "short", day: "numeric" });
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Парсинг «a@b.c, Имя <d@e.f>» в список адресов. */
export function parseAddrs(s: string): string[] {
  return s
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /<([^>]+)>/.exec(x);
      return (m ? m[1] : x).trim();
    })
    .filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));
}

/**
 * Очистка HTML письма. Скрипты, формы, <style>, фреймы убираются; удалённые
 * картинки и фоны блокируются (трекер-пиксели), пока пользователь не разрешит.
 */
export function prepareHtml(html: string, allowRemote: boolean): { html: string; blocked: number } {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "link", "meta", "form", "iframe", "object", "embed", "base"],
    FORBID_ATTR: ["srcset"],
  });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  let blocked = 0;
  if (!allowRemote) {
    doc.querySelectorAll("img,video,audio,source,image").forEach((el) => {
      const src = el.getAttribute("src") || "";
      if (/^(https?:)?\/\//i.test(src)) {
        el.removeAttribute("src");
        el.setAttribute("data-blocked", "1");
        blocked++;
      }
    });
    doc.querySelectorAll("[style]").forEach((el) => {
      if (/url\s*\(/i.test(el.getAttribute("style") || "")) {
        el.removeAttribute("style");
        blocked++;
      }
    });
    doc.querySelectorAll("[background]").forEach((el) => {
      el.removeAttribute("background");
      blocked++;
    });
  }
  doc.querySelectorAll("a").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
  return { html: doc.body.innerHTML, blocked };
}

/** Тема ответа/пересылки без дублирования префикса. */
export function prefixSubject(prefix: "Re" | "Fwd", subject: string): string {
  const re = new RegExp(`^\\s*${prefix}\\s*:`, "i");
  return re.test(subject) ? subject : `${prefix}: ${subject}`;
}

export function laterToday(): number {
  const d = new Date();
  d.setHours(d.getHours() + 3, 0, 0, 0);
  return d.getTime();
}
export function tomorrow(h = 9): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
}
export function weekend(): number {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
export function nextWeek(): number {
  const d = new Date();
  d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7));
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** Значение для <input type="datetime-local">. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Холст, который понимает содержимое: по объектам доски (заметки, стикеры,
 * карточки-ссылки, распознанные картинки) модель предлагает связи, группы и
 * недостающие шаги. Здесь — описание объектов для модели и безопасный разбор
 * ответа: любые id, которых нет на доске, отбрасываются.
 */

export interface BoardObj {
  id: string;
  type: string;
  text?: string;
  name?: string;
  preview?: string;
  path?: string;
  src?: string;
  status?: string;
  link?: { kind: string; ref: string };
}

export interface Described {
  id: string;
  kind: string;
  label: string;
}

/** Типы, несущие смысл; линии, штрихи и фигуры без текста пропускаются. */
const MEANINGFUL = new Set(["sticky", "text", "note", "task", "link", "image", "shape", "frame"]);

export function describe(
  objs: BoardObj[],
  extra: { image?: Record<string, string>; linked?: Record<string, string> } = {},
  max = 60,
): Described[] {
  const out: Described[] = [];
  for (const o of objs) {
    if (!o?.id || !MEANINGFUL.has(o.type)) continue;
    const parts = [
      o.text,
      o.name,
      o.preview,
      extra.image?.[o.id] ? `[текст на картинке] ${extra.image[o.id]}` : "",
      extra.linked?.[o.id] ?? "",
    ]
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const label = [...new Set(parts)].join(" — ").slice(0, 220);
    if (!label) continue;
    const kind = o.type === "link" && o.link ? `link:${o.link.kind}` : o.type;
    out.push({ id: o.id, kind, label });
    if (out.length >= max) break;
  }
  return out;
}

export function buildPrompt(items: Described[]): string {
  const list = items.map((i) => `${i.id} | ${i.kind} | ${i.label}`).join("\n");
  return (
    `Ниже объекты доски (id | тип | содержимое). Найди смысловые связи между ними, предложи группы по темам ` +
    `и укажи, каких шагов или материалов не хватает до завершённой картины.\n` +
    `Ответь ТОЛЬКО JSON: {"links":[{"from":"id","to":"id","why":"до 8 слов"}],` +
    `"groups":[{"name":"тема","ids":["id","id"]}],"missing":[{"text":"недостающий шаг"}]}.\n` +
    `Связей не больше 12, групп не больше 5 (по 2+ объекта), недостающих шагов не больше 6. ` +
    `Используй только указанные id. Ничего не выдумывай сверх содержимого.\n\n${list}`
  );
}

export interface Suggestions {
  links: { from: string; to: string; why: string }[];
  groups: { name: string; ids: string[] }[];
  missing: { text: string }[];
}

export function parseSuggestions(raw: string, validIds: string[]): Suggestions {
  const out: Suggestions = { links: [], groups: [], missing: [] };
  const text = String(raw ?? "");
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return out;
  let obj: { links?: unknown; groups?: unknown; missing?: unknown };
  try {
    obj = JSON.parse(text.slice(a, b + 1));
  } catch {
    return out;
  }
  const ok = new Set(validIds);
  const seen = new Set<string>();
  for (const l of Array.isArray(obj.links) ? obj.links : []) {
    const o = l as Record<string, unknown>;
    const from = String(o?.from ?? "");
    const to = String(o?.to ?? "");
    if (!ok.has(from) || !ok.has(to) || from === to) continue;
    const key = [from, to].sort().join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.links.push({ from, to, why: String(o?.why ?? "").slice(0, 80) });
    if (out.links.length >= 12) break;
  }
  for (const g of Array.isArray(obj.groups) ? obj.groups : []) {
    const o = g as Record<string, unknown>;
    const ids = (Array.isArray(o?.ids) ? o.ids : []).map(String).filter((id) => ok.has(id));
    const name = String(o?.name ?? "").trim().slice(0, 40);
    if (!name || new Set(ids).size < 2) continue;
    out.groups.push({ name, ids: [...new Set(ids)] });
    if (out.groups.length >= 5) break;
  }
  for (const m of Array.isArray(obj.missing) ? obj.missing : []) {
    const t = String((m as Record<string, unknown>)?.text ?? "").trim().slice(0, 120);
    if (t.length >= 3) out.missing.push({ text: t });
    if (out.missing.length >= 6) break;
  }
  return out;
}

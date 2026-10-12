/**
 * «Говорящие заметки»: Markdown → текст, пригодный для озвучки. В отличие от
 * RSVP-разбора, сохраняет абзацы (пауза между ними), убирает всё, что на слух
 * звучит мусором: адреса, теги, чекбоксы, таблицы, код, ссылки на вложения.
 */

export function speakableText(md: string, o: { maxChars?: number } = {}): string {
  let t = String(md ?? "")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, "")
    .replace(/^[ \t]*(?:#{1,6}|[-*+>]|\d+[.)])[ \t]+/gm, "")
    .replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/[ \t]+/g, " ");
  // абзацы — через пустую строку: озвучка делает между ними паузу
  t = t
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  const max = o.maxChars ?? 12_000;
  if (t.length <= max) return t;
  // обрезаем по границе абзаца, а не посреди слова
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf("\n\n");
  return (at > max * 0.3 ? cut.slice(0, at) : cut.slice(0, cut.lastIndexOf(" "))).trim();
}

/** Оценка длительности озвучки в минутах (≈ 900 знаков в минуту речи). */
export function speechMinutes(text: string): number {
  return Math.max(0.1, Math.round((text.length / 900) * 10) / 10);
}

/** Компактная подпись под сообщением: токены · время генерации · время сообщения. */
export interface MsgMetaInput {
  text: string;
  created_at?: string;
  gen_ms?: number | null;
  tokens?: number | null;
}

const kfmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/** created_at хранится в UTC как «YYYY-MM-DD HH:MM:SS». Сегодняшнее — только часы, иначе с датой. */
export function msgTime(created?: string, now: Date = new Date()): string {
  if (!created) return "";
  const d = new Date(created.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const same = d.toDateString() === now.toDateString();
  return same ? hm : `${p(d.getDate())}.${p(d.getMonth() + 1)} ${hm}`;
}

export function msgMeta(
  m: MsgMetaInput,
  units: { tok: string; sec: string },
  now?: Date,
): string {
  const tokens = m.tokens && m.tokens > 0 ? m.tokens : Math.max(1, Math.round(m.text.length / 3.5));
  const parts = [`≈${kfmt(tokens)} ${units.tok}`];
  if (m.gen_ms && m.gen_ms > 0) parts.push(`${(m.gen_ms / 1000).toFixed(1)} ${units.sec}`);
  const time = msgTime(m.created_at, now);
  if (time) parts.push(time);
  return parts.join(" · ");
}

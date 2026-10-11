/**
 * Ветвление диалога: новый чат получает копию истории до выбранного сообщения
 * включительно; исходный диалог не меняется.
 */

export interface ForkMsg {
  id: number;
  role: string;
  text: string;
}

/** Сообщения от начала до сообщения с id включительно; null — если id не найден. */
export function messagesUpTo<T extends ForkMsg>(messages: T[], upToId: number): T[] | null {
  const idx = messages.findIndex((m) => m.id === upToId);
  return idx < 0 ? null : messages.slice(0, idx + 1);
}

const SUFFIX = " ⑂";

/** Название ветки: «Тема ⑂», «Тема ⑂ 2» … без бесконечного наращивания суффикса. */
export function forkTitle(title: string, existing: string[] = []): string {
  const base = String(title || "New chat").replace(/ ⑂(?: \d+)?$/, "");
  const taken = new Set(existing);
  let name = base + SUFFIX;
  for (let n = 2; taken.has(name); n++) name = `${base}${SUFFIX} ${n}`;
  return name.slice(0, 120);
}

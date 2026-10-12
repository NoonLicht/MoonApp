import type { ChatMessage } from "@/api/types";

/**
 * Картинки, прикреплённые к сообщениям, на сервере не хранятся (в БД только
 * текст), поэтому после перезагрузки их не было бы в чате. Сохраняем их в
 * localStorage по ключу «диалог + текст сообщения» — как лёгкий кэш; при
 * переполнении квоты просто молча пропускаем.
 */
const KEY = (convId: number) => `moonapp.chat.imgs.${convId}`;
const MAX_BYTES = 1_500_000;

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function load(convId: number): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY(convId)) || "{}");
  } catch {
    return {};
  }
}

export function rememberImages(convId: number, text: string, images: string[]): void {
  if (!images.length) return;
  try {
    const map = load(convId);
    map[hash(text)] = images;
    // Держим размер в рамках: сначала выбрасываем самые старые записи.
    let raw = JSON.stringify(map);
    const keys = Object.keys(map);
    while (raw.length > MAX_BYTES && keys.length > 1) {
      delete map[keys.shift() as string];
      raw = JSON.stringify(map);
    }
    localStorage.setItem(KEY(convId), raw);
  } catch {
    /* квота localStorage — картинки просто не переживут перезагрузку */
  }
}

export function withImages(convId: number, messages: ChatMessage[]): ChatMessage[] {
  const map = load(convId);
  if (!Object.keys(map).length) return messages;
  return messages.map((m) => {
    if (m.role !== "user") return m;
    const imgs = map[hash(m.text)];
    return imgs ? { ...m, images: imgs } : m;
  });
}

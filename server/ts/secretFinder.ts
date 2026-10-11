/**
 * Поиск секретов в распознанном тексте скриншота (для автоматического блюра).
 *
 * Работает по словам OCR с рамками: слова склеиваются в строку, регулярные
 * выражения ищут секреты (почта, номера карт с проверкой Луна, телефоны, ключи API,
 * JWT, пароль после метки, IP-адреса, длинные токены), а совпадения возвращаются
 * к рамкам слов. Одна строка скриншота даёт одну область.
 */

export interface OcrWord {
  text: string;
  confidence?: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface SecretRegion {
  kind: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Контрольная сумма Луна — отсекает случайные длинные числа. */
export function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

interface Pattern {
  kind: string;
  re: RegExp;
  /** Номер группы, которую нужно скрыть (по умолчанию всё совпадение). */
  group?: number;
  accept?: (m: RegExpExecArray) => boolean;
}

const PATTERNS: Pattern[] = [
  { kind: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  {
    kind: "card",
    re: /(?<![\d])(?:\d[ -]?){13,19}(?![\d])/g,
    accept: (m) => luhn(m[0].replace(/[ -]/g, "")),
  },
  { kind: "phone", re: /(?<![\d])(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?![\d])/g },
  { kind: "phone", re: /\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3}[\s-]?\d{2,4}[\s-]?\d{0,4}/g },
  {
    kind: "api-key",
    re: /(?<![\w-])(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g,
  },
  { kind: "jwt", re: /eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g },
  {
    kind: "password",
    re: /(?:парол[ьяю]|password|passwd|pwd|pass|secret|token|токен)\s*[:=]\s*(\S{3,})/gi,
    group: 1,
  },
  {
    kind: "ip",
    re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g,
  },
  {
    kind: "token",
    re: /(?<![\w-])[A-Za-z0-9_-]{32,}(?![\w-])/g,
    accept: (m) => /\d/.test(m[0]) && /[A-Za-z]/.test(m[0]),
  },
];

export function findSecrets(words: OcrWord[]): SecretRegion[] {
  const clean = words.filter((w) => w && typeof w.text === "string" && w.text.trim() && w.bbox);
  if (!clean.length) return [];
  // Склеиваем слова пробелами и запоминаем, где какое слово начинается.
  let text = "";
  const spans: { start: number; end: number; w: OcrWord }[] = [];
  for (const w of clean) {
    if (text) text += " ";
    spans.push({ start: text.length, end: text.length + w.text.length, w });
    text += w.text;
  }

  const hit = new Map<OcrWord, string>();
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      if (m[0].length === 0) {
        p.re.lastIndex++;
        continue;
      }
      if (p.accept && !p.accept(m)) continue;
      let from = m.index;
      let to = m.index + m[0].length;
      if (p.group) {
        const g = m[p.group];
        if (!g) continue;
        from = m.index + m[0].lastIndexOf(g);
        to = from + g.length;
      }
      for (const s of spans) if (s.start < to && s.end > from && !hit.has(s.w)) hit.set(s.w, p.kind);
    }
  }
  if (!hit.size) return [];

  // Объединяем соседние слова одной строки в одну область.
  const ordered = clean.filter((w) => hit.has(w));
  const regions: SecretRegion[] = [];
  for (const w of ordered) {
    const last = regions[regions.length - 1];
    const h = w.bbox.y1 - w.bbox.y0;
    const sameLine =
      last &&
      Math.abs((w.bbox.y0 + w.bbox.y1) / 2 - (last.y0 + last.y1) / 2) < Math.max(h, last.y1 - last.y0) / 2 &&
      w.bbox.x0 - last.x1 < Math.max(h, 12) * 2;
    if (last && sameLine) {
      last.x0 = Math.min(last.x0, w.bbox.x0);
      last.y0 = Math.min(last.y0, w.bbox.y0);
      last.x1 = Math.max(last.x1, w.bbox.x1);
      last.y1 = Math.max(last.y1, w.bbox.y1);
    } else {
      regions.push({ kind: hit.get(w) as string, ...w.bbox });
    }
  }
  return regions;
}

/** Достаёт слова с рамками из результата tesseract (blocks → paragraphs → lines → words). */
export function flattenWords(data: unknown): OcrWord[] {
  const d = data as {
    words?: OcrWord[];
    blocks?: { paragraphs?: { lines?: { words?: OcrWord[] }[] }[] }[];
  };
  if (Array.isArray(d?.words) && d.words.length) return d.words;
  const out: OcrWord[] = [];
  for (const b of d?.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? []) for (const w of l.words ?? []) out.push(w);
  return out;
}

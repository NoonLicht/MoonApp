/**
 * Разбор текста кассового чека (результат OCR) в позиции для бюджета.
 *
 * OCR даёт «грязный» текст, поэтому парсер консервативен: позиция — это строка,
 * заканчивающаяся ценой; служебные строки (итого, налички, НДС, карта) отбрасываются,
 * итог берётся из строки «ИТОГО/К ОПЛАТЕ». Если сумма позиций расходится с итогом,
 * это видно в поле `mismatch` — интерфейс просит пользователя проверить черновик.
 */

export interface ReceiptItem {
  name: string;
  amount: number;
  category: string;
}

export interface ParsedReceipt {
  merchant: string;
  /** YYYY-MM-DD или пустая строка, если дату найти не удалось. */
  date: string;
  total: number | null;
  items: ReceiptItem[];
  /** Сумма позиций минус итог (null, если итога нет). Ненулевое значение — повод проверить. */
  mismatch: number | null;
}

const PRICE_AT_END = /(\d{1,3}(?:[ \u00a0]\d{3})*|\d+)[.,](\d{2})\s*(?:[=*]|р\.?|руб\.?|₽)?\s*$/i;
// \b в JS понимает только латиницу, поэтому границу слова задаём через \p{L}.
const TOTAL_LINE =
  /(^|\s)(итого|итог|к\s*оплате|всего\s*к\s*оплате|сумма\s*к\s*оплате)(?!\p{L})/iu;
const SERVICE_LINE =
  /(налич|сдача|безнал|карт[аы]|ндс|скидк|бонус|баллы|смена|кассир|чек(?!\p{L})|инн(?!\p{L})|фн(?!\p{L})|фд(?!\p{L})|фп(?!\p{L})|сно(?!\p{L})|ккт|электронн|получено|округл|предоплат)/iu;

const CATEGORY_RULES: [string, RegExp][] = [
  ["Здоровье", /(аптек|таблет|капсул|витамин|лекарств|бинт|пластыр|мазь|сироп)/i],
  ["Транспорт", /(бензин|аи-?9|аи-?95|дт\b|азс|парков|такси|метро|проезд|топлив)/i],
  ["Подписки", /(подписк|premium|netflix|spotify|youtube|яндекс\s*плюс)/i],
  ["Развлечения", /(кино|билет|игр[аы]|концерт|боулинг|квест)/i],
  [
    "Еда",
    /(молок|хлеб|батон|сыр|колбас|мяс|кур[иы]ц|рыб|овощ|фрукт|яблок|банан|картоф|помидор|огур|вод[аы]|сок\b|чай|кофе|шоколад|конфет|печень|йогурт|творог|кефир|масл[оа]|яйц|сахар|мук[аи]|круп|рис\b|макарон|пельмен|пицц|бургер|салат|шаурм|напиток|пиво|вино)/i,
  ],
];

/** Категория по названию позиции; нераспознанное — «Другое». */
export function categorize(name: string): string {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(name)) return cat;
  return "Другое";
}

function toNumber(intPart: string, frac: string): number {
  return Number(intPart.replace(/[ \u00a0]/g, "") + "." + frac);
}

export function parseDate(text: string): string {
  const m = text.match(/(?<!\d)(\d{2})[./-](\d{2})[./-](\d{4}|\d{2})(?!\d)/);
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    const mo = Number(m[2]);
    const d = Number(m[1]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${m[2]}-${m[1]}`;
  }
  const iso = text.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  return iso ? iso[0] : "";
}

function cleanName(raw: string): string {
  return raw
    .replace(PRICE_AT_END, "")
    .replace(/\d+\s*[xх*]\s*\d+[.,]?\d*\s*[=]?\s*$/i, "") // «2 х 45,00 =»
    .replace(/^[\s\d.)-]+(?=\p{L})/u, "") // номер позиции в начале
    .replace(/[=*_|]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseReceipt(text: string): ParsedReceipt {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let total: number | null = null;
  const items: ReceiptItem[] = [];

  for (const line of lines) {
    const price = line.match(PRICE_AT_END);
    if (TOTAL_LINE.test(line)) {
      if (price) total = toNumber(price[1], price[2]);
      continue;
    }
    if (!price || SERVICE_LINE.test(line)) continue;
    const amount = toNumber(price[1], price[2]);
    const name = cleanName(line);
    if (!amount || name.replace(/[^\p{L}]/gu, "").length < 2) continue;
    items.push({ name, amount, category: categorize(name) });
  }

  const merchant =
    lines.find((l) => (l.match(/\p{L}/gu) ?? []).length >= 3 && !SERVICE_LINE.test(l) && !PRICE_AT_END.test(l)) ??
    "";
  const sum = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  return {
    merchant: merchant.slice(0, 80),
    date: parseDate(lines.join("\n")),
    total,
    items,
    mismatch: total === null ? null : Math.round((sum - total) * 100) / 100,
  };
}

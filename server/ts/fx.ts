/**
 * Курсы валют для мультивалютного бюджета: используется бесплатный,
 * не требующий ключа API Центробанка РФ (www.cbr-xml-daily.ru) — отдаёт
 * курс каждой валюты к рублю, в т.ч. за прошлые даты (архив по дням).
 * Выбран сознательно вместо, например, Frankfurter — тот вообще не знает
 * рубль (санкционные ограничения ECB-данных), а для приложения с русским
 * интерфейсом это основная валюта.
 */
import logger from "./logger";

interface CbrValute {
  CharCode: string;
  Nominal: number;
  Value: number;
}
interface CbrResponse {
  Date: string;
  Valute: Record<string, CbrValute>;
}

/** Кэш по дате — курс за конкретный день не меняется, смысла перезапрашивать нет. */
const cache = new Map<string, Record<string, number>>();

function urlForDate(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr >= today) return "https://www.cbr-xml-daily.ru/daily_json.js";
  const [y, m, d] = dateStr.split("-");
  return `https://www.cbr-xml-daily.ru/archive/${y}/${m}/${d}/daily_json.js`;
}

/**
 * Курс к рублю на дату dateStr (YYYY-MM-DD): { "USD": 91.23, "EUR": 99.8, "RUB": 1, ... }.
 * При сетевой ошибке возвращает null — вызывающий код должен явно решить,
 * что делать (не выдумывать курс из головы).
 */
export async function getRatesToRub(dateStr: string): Promise<Record<string, number> | null> {
  const cached = cache.get(dateStr);
  if (cached) return cached;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(urlForDate(dateStr), { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as CbrResponse;
    const rates: Record<string, number> = { RUB: 1 };
    for (const v of Object.values(data.Valute || {})) {
      if (v.Nominal > 0) rates[v.CharCode] = v.Value / v.Nominal;
    }
    cache.set(dateStr, rates);
    return rates;
  } catch (e) {
    logger.warn("fx.rates_failed", { date: dateStr, error: (e as Error).message });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Валюты, доступные для выбора в UI (ЦБ РФ публикует курс каждой из них). */
export const KNOWN_CURRENCIES = [
  "RUB",
  "USD",
  "EUR",
  "GBP",
  "CNY",
  "TRY",
  "GEL",
  "AMD",
  "KZT",
  "AED",
  "JPY",
  "CHF",
];

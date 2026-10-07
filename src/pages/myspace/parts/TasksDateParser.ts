/**
 * Выделено из TasksPanel.tsx при разбиении крупного файла (поведение не менялось).
 */

/* ---------- multilingual natural-date parsing ----------
 * Быстрый quick-add понимал "today/tomorrow" только на английском (плюс пара
 * русских слов захардкожена отдельно и не совпадала с regex создания задачи).
 * Ниже — единый разбор относительных дат/дней недели/времени на всех языках
 * приложения (en/ru/es/fr/zh/ar), используемый и для чипов-подсказок, и для
 * реального создания задачи.
 */
type NaturalDateMatch = { phrase: string; date: Date; hasTime: boolean };

/** "YYYY-MM-DD" по локальным компонентам даты — toISOString() тут не годится:
 *  он конвертирует в UTC, и полночь по местному времени в часовых поясах
 *  восточнее UTC (например Москва) откатывается на предыдущий день. */
export function formatLocalDateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

const REL_DAY_WORDS: { words: string[]; days: number }[] = [
  {
    words: ["day after tomorrow", "послезавтра", "pasado mañana", "après-demain", "后天", "بعد غد"],
    days: 2,
  },
  { words: ["tomorrow", "завтра", "mañana", "demain", "明天", "غدا", "غداً"], days: 1 },
  { words: ["today", "сегодня", "hoy", "aujourd'hui", "今天", "اليوم"], days: 0 },
];

const WEEKDAY_NAMES: Record<string, string[]> = {
  en: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
  ru: ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"],
  es: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
  fr: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
  zh: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"],
  ar: ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
};
/* "следующий/следующая/следующее" согласуется по роду с днём недели. */
const RU_NEXT_PREFIX = [
  "следующее",
  "следующий",
  "следующий",
  "следующая",
  "следующий",
  "следующая",
  "следующая",
];
/* "в/во + винительный падеж" — "в среду", "во вторник", "в пятницу". */
const RU_ACCUSATIVE = [
  "в воскресенье",
  "в понедельник",
  "во вторник",
  "в среду",
  "в четверг",
  "в пятницу",
  "в субботу",
];

/** Все варианты фраз "следующий понедельник"/"в среду"/голых названий дней
 *  недели по языкам, отсортированные от самых длинных к самым коротким (чтобы
 *  не перепутать префикс с целой фразой). Голое название (без "следующий")
 *  тоже считается ближайшим будущим этим днём недели. */
function buildWeekdayPhrases(): { phrase: string; day: number }[] {
  const out: { phrase: string; day: number }[] = [];
  WEEKDAY_NAMES.en.forEach((w, i) => {
    out.push({ phrase: `next ${w}`, day: i });
    out.push({ phrase: w, day: i });
  });
  WEEKDAY_NAMES.ru.forEach((w, i) => {
    out.push({ phrase: `${RU_NEXT_PREFIX[i]} ${w}`, day: i });
    out.push({ phrase: RU_ACCUSATIVE[i], day: i });
    out.push({ phrase: w, day: i });
  });
  WEEKDAY_NAMES.es.forEach((w, i) => {
    out.push({ phrase: `próximo ${w}`, day: i });
    out.push({ phrase: w, day: i });
  });
  WEEKDAY_NAMES.fr.forEach((w, i) => {
    out.push({ phrase: `${w} prochain`, day: i });
    out.push({ phrase: w, day: i });
  });
  WEEKDAY_NAMES.zh.forEach((w, i) => {
    out.push({ phrase: `下${w}`, day: i });
    out.push({ phrase: w, day: i });
  });
  WEEKDAY_NAMES.ar.forEach((w, i) => {
    out.push({ phrase: `${w} القادم`, day: i });
    out.push({ phrase: w, day: i });
  });
  return out.sort((a, b) => b.phrase.length - a.phrase.length);
}
const WEEKDAY_PHRASES = buildWeekdayPhrases();
const REL_PHRASES = REL_DAY_WORDS.flatMap((g) =>
  g.words.map((w) => ({ phrase: w, days: g.days })),
).sort((a, b) => b.phrase.length - a.phrase.length);

/** Время: "15:00", "15.00", "3pm", "3 pm". */
const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b|\b(1[0-2]|0?[1-9])\s?(am|pm)\b/i;
/** Время без минут с локализованным предлогом: "в 15", "at 15", "a las 15",
 *  "à 15h", "15点", "الساعة 15". \b не годится — для кириллицы/арабского оно
 *  не является "словесным" символом, поэтому границу считаем по пробелам. */
const TIME_HOUR_ONLY_RE =
  /(?:^|\s)(?:в|at|a las|à|الساعة)\s?([01]?\d|2[0-3])\s?h?(?=\s|$)|(?:^|\s)([01]?\d|2[0-3])\s?点/i;

export function parseNaturalDate(text: string): NaturalDateMatch | null {
  const lower = text.toLowerCase();
  let dateHit: { phrase: string; base: Date } | null = null;

  for (const { phrase, days } of REL_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx >= 0) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      dateHit = { phrase: text.slice(idx, idx + phrase.length), base: d };
      break;
    }
  }
  if (!dateHit) {
    for (const { phrase, day } of WEEKDAY_PHRASES) {
      const idx = lower.indexOf(phrase);
      if (idx >= 0) {
        const d = new Date();
        const currentDay = d.getDay();
        let diff = day - currentDay;
        if (diff <= 0) diff += 7;
        d.setDate(d.getDate() + diff);
        dateHit = { phrase: text.slice(idx, idx + phrase.length), base: d };
        break;
      }
    }
  }
  if (!dateHit) return null;

  let hasTime = false;
  const timeM = lower.match(TIME_RE);
  if (timeM) {
    hasTime = true;
    if (timeM[1] !== undefined) {
      dateHit.base.setHours(parseInt(timeM[1], 10), parseInt(timeM[2], 10), 0, 0);
    } else {
      let h = parseInt(timeM[3], 10) % 12;
      if (timeM[4].toLowerCase() === "pm") h += 12;
      dateHit.base.setHours(h, 0, 0, 0);
    }
  } else {
    const hourM = lower.match(TIME_HOUR_ONLY_RE);
    if (hourM) {
      hasTime = true;
      const h = parseInt(hourM[1] ?? hourM[2], 10);
      dateHit.base.setHours(h, 0, 0, 0);
    } else {
      dateHit.base.setHours(0, 0, 0, 0);
    }
  }

  return { phrase: dateHit.phrase, date: dateHit.base, hasTime };
}

/**
 * Русский NLP-движок для TTS: Ёфикация, разворот чисел в слова, расстановка
 * ударений, защита сокращений, смарт-чанкинг по границам предложений.
 *
 * Пайплайн: normalize(text, opts) → текст готов к чанкингу; chunkText(text,
 * limit) → чанки строго по границам предложений с защитой сокращений
 * (т.д., т.п., г., ул., ст., руб., проф., акад., 3.14) и реплик диалогов.
 *
 * TS-исходник, как server/ts/setupTask.ts: компилируется в server/ruNlp.js
 * командой `npm run compile:server`, поэтому `require("./ruNlp")` из tts.js и
 * роутов продолжает работать без изменений.
 */

/* ------------------------- Ёфикация ------------------------- */

// Частотный словарь: «е» → «ё» только в известных словах (иначе вред).
const YO_PLAIN_TO_YO: Record<string, string> = {
  все: "всё",
  всего: "всего",
  всем: "всём",
  еще: "ещё",
  ее: "её",
  четырех: "четырёх",
  трех: "трёх",
  пришел: "пришёл",
  ушел: "ушёл",
  зашел: "зашёл",
  пошел: "пошёл",
  нашел: "нашёл",
  шел: "шёл",
  жесткий: "жёсткий",
  желудок: "жёлудок",
  черный: "чёрный",
  черного: "чёрного",
  зеленый: "зелёный",
  желтый: "жёлтый",
  легкий: "лёгкий",
  легко: "легко",
  тяжелый: "тяжёлый",
  ежик: "ёжик",
  идет: "идёт",
  ведет: "ведёт",
  несет: "несёт",
  берет: "берёт",
  живет: "живёт",
  поет: "поёт",
  принес: "принёс",
  отнес: "отнёс",
  темный: "тёмный",
  темнота: "темнота",
  шелест: "шелест",
  шепчет: "шепчет",
  надежды: "надежды",
  звезд: "звёзд",
  озеро: "озеро",
  затмение: "затмение",
};

/** Ёфикация по словарю: регистр исходного слова сохраняется. */
export function yoficate(text: unknown): string {
  return String(text || "").replace(/\p{L}+/gu, (w) => {
    const lower = w.toLowerCase();
    const yowed = YO_PLAIN_TO_YO[lower];
    if (!yowed || yowed === lower) return w;
    return w[0] === w[0].toUpperCase() && /\p{Lu}/u.test(w[0])
      ? yowed[0].toUpperCase() + yowed.slice(1)
      : yowed;
  });
}

/* --------------------- Разворот чисел --------------------- */

const UNITS = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const FEM_UNITS = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = [
  "десять",
  "одиннадцать",
  "двенадцать",
  "тринадцать",
  "четырнадцать",
  "пятнадцать",
  "шестнадцать",
  "семнадцать",
  "восемнадцать",
  "девятнадцать",
];
const TENS = [
  "",
  "",
  "двадцать",
  "тридцать",
  "сорок",
  "пятьдесят",
  "шестьдесят",
  "семьдесят",
  "восемьдесят",
  "девяносто",
];
const HUNDREDS = [
  "",
  "сто",
  "двести",
  "триста",
  "четыреста",
  "пятьсот",
  "шестьсот",
  "семьсот",
  "восемьсот",
  "девятьсот",
];

/** 0..999 прописью; fem=true даёт женский род (одна/две) — для тысяч. */
function threeDigitsToWords(n: number, fem = false): string[] {
  const parts: string[] = [];
  const h = Math.floor(n / 100),
    rest = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (rest >= 10 && rest < 20) {
    parts.push(TEENS[rest - 10]);
    return parts;
  }
  const t = Math.floor(rest / 10),
    u = rest % 10;
  if (t) parts.push(TENS[t]);
  if (u) parts.push(fem ? FEM_UNITS[u] : UNITS[u]);
  return parts;
}

/** Русская форма множественного числа: 1 час / 2 часа / 5 часов. */
export function pluralForm(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10,
    m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Римское число в int (проверка формата — у вызывающего, см. ROMAN_RE). */
function romanToInt(s: string): number {
  const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = map[s[i]],
      next = map[s[i + 1]] || 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

const ROMAN_RE = /^(?=[MDCLXVI])M*(C[MD]|D?C{0,3})(X[LC]|L?X{0,3})(I[VX]|V?I{0,3})$/;

/** Число прописью; ordinal=true — последнее слово в порядковом виде (первый, третий). */
export function numberToRussian(numStr: string, ordinal = false): string {
  const n = parseInt(numStr, 10);
  if (Number.isNaN(n)) return numStr;
  if (n === 0) return "ноль";
  const groups: string[] = [];
  let rest = n;
  const scales: { v: number; fem: boolean; forms: [string, string, string] | null }[] = [
    { v: 1_000_000_000, fem: false, forms: ["миллиард", "миллиарда", "миллиардов"] },
    { v: 1_000_000, fem: false, forms: ["миллион", "миллиона", "миллионов"] },
    { v: 1_000, fem: true, forms: ["тысяча", "тысячи", "тысяч"] },
    { v: 1, fem: false, forms: null },
  ];
  for (const s of scales) {
    if (rest >= s.v) {
      const g = Math.floor(rest / s.v);
      rest %= s.v;
      const words = threeDigitsToWords(g, s.fem);
      if (s.forms) words.push(pluralForm(g, s.forms[0], s.forms[1], s.forms[2]));
      if (words.length) groups.push(words.join(" "));
    }
  }
  if (!groups.length) groups.push(threeDigitsToWords(n).join(" "));
  if (ordinal) {
    const ordMap: Record<string, string> = {
      один: "первый",
      два: "второй",
      три: "третий",
      четыре: "четвертый",
      пять: "пятый",
      шесть: "шестой",
      семь: "седьмой",
      восемь: "восьмой",
      девять: "девятый",
      десять: "десятый",
      двадцать: "двадцатый",
      тридцать: "тридцатый",
      сорок: "сороковой",
      пятьдесят: "пятидесятый",
      сто: "сотый",
      тысяча: "тысячный",
      ноль: "нулевой",
    };
    const words = groups[groups.length - 1].split(" ");
    const w = words[words.length - 1];
    words[words.length - 1] = ordMap[w] || w + "ный";
    groups[groups.length - 1] = words.join(" ");
  }
  return groups.join(" ").trim();
}

/* ------------------- Умный разворот чисел в тексте ------------------- */

/** Разворот чисел в тексте: время, годы, проценты, дроби, римские числа. */
export function expandNumbers(text: unknown): string {
  return String(text || "")
    .replace(
      /\b(\d{1,2}):(\d{2})\b/g,
      (_, h: string, m: string) =>
        `${numberToRussian(h)} ${pluralForm(+h, "час", "часа", "часов")} ${numberToRussian(m)} ${pluralForm(+m, "минута", "минуты", "минут")}`,
    )
    .replace(/\b(\d{1,4})\s?(гг?\.)/gi, (_, y: string) => `${numberToRussian(y, true)} год`)
    .replace(
      /\b(\d+)\s?%/g,
      (_, d: string) =>
        `${numberToRussian(d)} ${pluralForm(+d, "процент", "процента", "процентов")}`,
    )
    .replace(
      /\b(\d+),(\d+)\b/g,
      (_, a: string, b: string) =>
        `${numberToRussian(a)} запятая ${b
          .split("")
          .map((d) => numberToRussian(d))
          .join(" ")}`,
    )
    .replace(
      /\b(\d+)\.(\d+)\b/g,
      (_, a: string, b: string) =>
        `${numberToRussian(a)} точка ${b
          .split("")
          .map((d) => numberToRussian(d))
          .join(" ")}`,
    )
    .replace(/\b(\d+)\b/g, (_, d: string) => numberToRussian(d))
    .replace(/\b([MDCLXVI]{2,})\b/g, (m) => (ROMAN_RE.test(m) ? String(romanToInt(m)) : m));
}

/* --------------------- Ударения (омографы) --------------------- */

/** Омограф: слово и правило выбора ударения по контексту вокруг него. */
interface Homograph {
  word: string;
  stress: (before: string, after?: string) => string;
}

const HOMOGRAPHS: Homograph[] = [
  {
    word: "замок",
    stress: (before, after) =>
      /открыт|закрыт|ключ|двер/i.test(before + (after || "")) ? "замо́к" : "за́мок",
  },
  { word: "мука", stress: (before) => (/пшен|ржа|тесто|хлеб/i.test(before) ? "мука́" : "му́ка") },
  { word: "белок", stress: () => "бело́к" },
  { word: "дорог", stress: () => "доро́г" },
];

/** Расставить ударения в омографах (ошибочный выбор не ломает текст). */
export function markStress(text: unknown): string {
  let t = String(text || "");
  for (const h of HOMOGRAPHS) {
    const re = new RegExp(`(\\S*)\\s?\\b${h.word}\\b(\\S*)`, "giu");
    t = t.replace(re, (m, before: string, after: string) => {
      try {
        return h.stress(before || "", after || "");
      } catch {
        return m;
      }
    });
  }
  return t;
}

/* --------------------- Сокращения-исключения --------------------- */

const ABBREV = [
  "т.д.",
  "т.п.",
  "т.е.",
  "т.к.",
  "т.н.",
  "г.",
  "ул.",
  "ст.",
  "руб.",
  "проф.",
  "акад.",
  "др.",
  "пр.",
  "ж.",
  "д.",
  "см.",
  "им.",
  "св.",
  "гг.",
  "вв.",
  "стр.",
  "мин.",
  "сек.",
  "тыс.",
  "млн.",
  "млрд.",
  "у.",
  "обл.",
  "кв.",
];

/** Скрываем сокращения (и десятичные точки) от сплиттера по предложениям. */
export function protectAbbrev(text: unknown): string {
  let t = String(text);
  ABBREV.forEach((a, i) => {
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(esc, "g"), `\u0001${i}\u0001`);
  });
  t = t.replace(/(\d)\.(\d)/g, "$1\u0002$2");
  return t;
}

/** Обратная замена: возвращает сокращения и десятичные точки на место. */
export function unprotectAbbrev(text: unknown): string {
  let t = String(text).replace(/\u0002/g, ".");
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i: string) => ABBREV[Number(i)] || "");
  return t;
}

/* --------------------- Чанкинг по предложениям --------------------- */

/** Чанк для TTS: текст (может отсутствовать у чистого паузного маркера) и пауза. */
export interface Chunk {
  text?: string;
  pauseMs: number | null;
}

/**
 * Режет текст на чанки ≤ limit символов СТРОГО по границам предложений.
 * Паузные маркеры [PAUSE=500ms] возвращаются элементами { pauseMs }.
 */
export function chunkText(text: unknown, limit = 350): Chunk[] {
  const out: Chunk[] = [];
  const protectedText = protectAbbrev(String(text || ""));
  const paragraphs = protectedText.split(/\n{2,}/).filter((p) => p.trim());
  for (const para of paragraphs) {
    const sentences = para.split(/(?<=[.!?;…])\s+/).filter((s) => s.trim());
    let cur = "";
    const push = (s: string): void => {
      let pauseMs: number | null = null;
      const m = s.match(/\[PAUSE=(\d+)ms\]/);
      if (m) {
        pauseMs = Number(m[1]);
        s = s.replace(/\[PAUSE=\d+ms\]/g, "").trim();
      }
      if (s) out.push({ text: unprotectAbbrev(s), pauseMs });
      else if (pauseMs) out.push({ pauseMs });
    };
    for (let s of sentences) {
      s = s.trim();
      // Гигантское предложение без точек → режем по запятым/пробелам
      while (s.length > limit * 1.5) {
        const comma = s.lastIndexOf(",", limit);
        const cut = comma > limit * 0.3 ? comma : s.lastIndexOf(" ", limit);
        if (cut <= 0) break;
        push(s.slice(0, cut + 1).trim());
        s = s.slice(cut + 1).trim();
      }
      if (!s) continue;
      if (cur && cur.length + s.length + 1 > limit) {
        push(cur);
        cur = s;
      } else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur.trim()) push(cur);
  }
  return out;
}

/* --------------------- Полная нормализация --------------------- */

/** Что делать с текстом перед озвучкой (по умолчанию — разворот чисел + ёфикация). */
export interface NormalizeOptions {
  expandNumbers?: boolean;
  yoficate?: boolean;
  markStress?: boolean;
}

export function normalize(text: unknown, opts: NormalizeOptions = {}): string {
  let t = String(text || "");
  if (opts.expandNumbers !== false) t = expandNumbers(t);
  if (opts.yoficate !== false) t = yoficate(t);
  if (opts.markStress) t = markStress(t);
  return t;
}

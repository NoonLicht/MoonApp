"use strict";

/**
 * Русский NLP-движок для TTS: Ёфикация, разворот чисел в слова, расстановка
 * ударений, защита сокращений, смарт-чанкинг по границам предложений.
 *
 * Пайплайн: normalize(text, opts) → текст готов к чанкингу; chunkText(text,
 * limit) → чанки строго по границам предложений с защитой сокращений
 * (т.д., т.п., г., ул., ст., руб., проф., акад., 3.14) и реплик диалогов.
 */

/* ------------------------- Ёфикация ------------------------- */

// Частотный словарь: «е» → «ё» только в известных словах (иначе вред).
const YO_PLAIN_TO_YO = {
  "все": "всё", "всего": "всего", "всем": "всём", "еще": "ещё", "ее": "её",
  "четырех": "четырёх", "трех": "трёх", "пришел": "пришёл", "ушел": "ушёл",
  "зашел": "зашёл", "пошел": "пошёл", "нашел": "нашёл", "шел": "шёл",
  "жесткий": "жёсткий", "желудок": "жёлудок", "черный": "чёрный", "черного": "чёрного",
  "зеленый": "зелёный", "желтый": "жёлтый", "легкий": "лёгкий", "легко": "легко",
  "тяжелый": "тяжёлый", "ежик": "ёжик", "идет": "идёт", "ведет": "ведёт",
  "несет": "несёт", "берет": "берёт", "живет": "живёт", "поет": "поёт",
  "принес": "принёс", "отнес": "отнёс", "темный": "тёмный", "темнота": "темнота",
  "шелест": "шелест", "шепчет": "шепчет", "надежды": "надежды", "звезд": "звёзд",
  "озеро": "озеро", "затмение": "затмение",
};

function yoficate(text) {
  return String(text || "").replace(/\p{L}+/gu, (w) => {
    const lower = w.toLowerCase();
    const yowed = YO_PLAIN_TO_YO[lower];
    if (!yowed || yowed === lower) return w;
    return w[0] === w[0].toUpperCase() && /\p{Lu}/u.test(w[0])
      ? yowed[0].toUpperCase() + yowed.slice(1)
      : yowed;
  });
}

module.exports = { yoficate };

/* --------------------- Разворот чисел --------------------- */

const UNITS = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const FEM_UNITS = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

function threeDigitsToWords(n, fem = false) {
  const parts = [];
  const h = Math.floor(n / 100), rest = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (rest >= 10 && rest < 20) { parts.push(TEENS[rest - 10]); return parts; }
  const t = Math.floor(rest / 10), u = rest % 10;
  if (t) parts.push(TENS[t]);
  if (u) parts.push(fem ? FEM_UNITS[u] : UNITS[u]);
  return parts;
}

function pluralForm(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function romanToInt(s) {
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = map[s[i]], next = map[s[i + 1]] || 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

const ROMAN_RE = /^(?=[MDCLXVI])M*(C[MD]|D?C{0,3})(X[LC]|L?X{0,3})(I[VX]|V?I{0,3})$/;

function numberToRussian(numStr, ordinal = false) {
  const n = parseInt(numStr, 10);
  if (Number.isNaN(n)) return numStr;
  if (n === 0) return "ноль";
  const groups = [];
  let rest = n;
  const scales = [
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
    const ordMap = { "один": "первый", "два": "второй", "три": "третий", "четыре": "четвертый", "пять": "пятый", "шесть": "шестой", "семь": "седьмой", "восемь": "восьмой", "девять": "девятый", "десять": "десятый", "двадцать": "двадцатый", "тридцать": "тридцатый", "сорок": "сороковой", "пятьдесят": "пятидесятый", "сто": "сотый", "тысяча": "тысячный", "ноль": "нулевой" };
    const words = groups[groups.length - 1].split(" ");
    const w = words[words.length - 1];
    words[words.length - 1] = ordMap[w] || w + "ный";
    groups[groups.length - 1] = words.join(" ");
  }
  return groups.join(" ").trim();
}

module.exports.yoficate = yoficate;
module.exports.numberToRussian = numberToRussian;

/* ------------------- Умный разворот чисел в тексте ------------------- */

function expandNumbers(text) {
  return String(text || "")
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) =>
      `${numberToRussian(h)} ${pluralForm(+h, "час", "часа", "часов")} ${numberToRussian(m)} ${pluralForm(+m, "минута", "минуты", "минут")}`)
    .replace(/\b(\d{1,4})\s?(гг?\.)/gi, (_, y) => `${numberToRussian(y, true)} год`)
    .replace(/\b(\d+)\s?%/g, (_, d) => `${numberToRussian(d)} ${pluralForm(+d, "процент", "процента", "процентов")}`)
    .replace(/\b(\d+),(\d+)\b/g, (_, a, b) =>
      `${numberToRussian(a)} запятая ${b.split("").map((d) => numberToRussian(d)).join(" ")}`)
    .replace(/\b(\d+)\.(\d+)\b/g, (_, a, b) =>
      `${numberToRussian(a)} точка ${b.split("").map((d) => numberToRussian(d)).join(" ")}`)
    .replace(/\b(\d+)\b/g, (_, d) => numberToRussian(d))
    .replace(/\b([MDCLXVI]{2,})\b/g, (m) => (ROMAN_RE.test(m) ? String(romanToInt(m)) : m));
}

module.exports.expandNumbers = expandNumbers;

/* --------------------- Ударения (омографы) --------------------- */

const HOMOGRAPHS = [
  { word: "замок", stress: (before, after) => (/открыт|закрыт|ключ|двер/i.test(before + after) ? "замо́к" : "за́мок") },
  { word: "мука", stress: (before) => (/пшен|ржа|тесто|хлеб/i.test(before) ? "мука́" : "му́ка") },
  { word: "белок", stress: () => "бело́к" },
  { word: "дорог", stress: () => "доро́г" },
];

function markStress(text) {
  let t = String(text || "");
  for (const h of HOMOGRAPHS) {
    const re = new RegExp(`(\\S*)\\s?\\b${h.word}\\b(\\S*)`, "giu");
    t = t.replace(re, (m, before, after) => {
      try { return h.stress(before || "", after || ""); } catch { return m; }
    });
  }
  return t;
}

module.exports.markStress = markStress;

/* --------------------- Сокращения-исключения --------------------- */

const ABBREV = [
  "т.д.", "т.п.", "т.е.", "т.к.", "т.н.", "г.", "ул.", "ст.", "руб.", "проф.",
  "акад.", "др.", "пр.", "ж.", "д.", "см.", "им.", "св.", "гг.", "вв.", "стр.",
  "мин.", "сек.", "тыс.", "млн.", "млрд.", "у.", "обл.", "кв.",
];

// Скрываем сокращения (и десятичные точки) от сплиттера.
function protectAbbrev(text) {
  let t = String(text);
  ABBREV.forEach((a, i) => {
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(esc, "g"), `\u0001${i}\u0001`);
  });
  t = t.replace(/(\d)\.(\d)/g, "$1\u0002$2");
  return t;
}

function unprotectAbbrev(text) {
  let t = String(text).replace(/\u0002/g, ".");
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => ABBREV[Number(i)] || "");
  return t;
}

module.exports.protectAbbrev = protectAbbrev;
module.exports.unprotectAbbrev = unprotectAbbrev;

/* --------------------- Чанкинг по предложениям --------------------- */

/**
 * Режет текст на чанки ≤ limit символов СТРОГО по границам предложений.
 * Паузные маркеры [PAUSE=500ms] возвращаются элементами { pauseMs }.
 */
function chunkText(text, limit = 350) {
  const out = [];
  const protectedText = protectAbbrev(String(text || ""));
  const paragraphs = protectedText.split(/\n{2,}/).filter((p) => p.trim());
  for (const para of paragraphs) {
    const sentences = para.split(/(?<=[.!?;…])\s+/).filter((s) => s.trim());
    let cur = "";
    const push = (s) => {
      let pauseMs = null;
      const m = s.match(/\[PAUSE=(\d+)ms\]/);
      if (m) { pauseMs = Number(m[1]); s = s.replace(/\[PAUSE=\d+ms\]/g, "").trim(); }
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
      if (cur && cur.length + s.length + 1 > limit) { push(cur); cur = s; }
      else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur.trim()) push(cur);
  }
  return out;
}

/* --------------------- Полная нормализация --------------------- */

function normalize(text, opts = {}) {
  let t = String(text || "");
  if (opts.expandNumbers !== false) t = expandNumbers(t);
  if (opts.yoficate !== false) t = yoficate(t);
  if (opts.markStress) t = markStress(t);
  return t;
}

module.exports.chunkText = chunkText;
module.exports.normalize = normalize;





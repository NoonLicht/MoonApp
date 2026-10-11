/**
 * Инструменты заметок и учёбы (чистые функции над Markdown):
 *  - оглавление и «карта содержания» (MOC);
 *  - трансклюзия ![[Заметка]] / ![[Заметка#Раздел]];
 *  - слова-паразиты;
 *  - приватные блоки (вырезаются при экспорте);
 *  - глоссарий из выделенных терминов;
 *  - расписание повторений и алгоритм SM-2;
 *  - формулы в таблицах (=SUM(B2:B4), =B2*C2 …).
 */

/* ------------------------------ Оглавление ------------------------------ */

export interface Heading {
  level: number;
  text: string;
  slug: string;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Заголовки вне блоков кода; повторяющиеся slug получают суффикс -1, -2. */
export function headings(md: string): Heading[] {
  const out: Heading[] = [];
  const seen = new Map<string, number>();
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const text = m[2].replace(/[*_`]/g, "").trim();
    let slug = slugify(text);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    out.push({ level: m[1].length, text, slug });
  }
  return out;
}

const TOC_START = "<!-- toc -->";
const TOC_END = "<!-- /toc -->";

export function buildToc(md: string, maxLevel = 3): string {
  const hs = headings(md).filter((h) => h.level <= maxLevel);
  if (!hs.length) return "";
  const base = Math.min(...hs.map((h) => h.level));
  return hs.map((h) => `${"  ".repeat(h.level - base)}- [${h.text}](#${h.slug})`).join("\n");
}

/** Вставляет или обновляет оглавление между маркерами <!-- toc --> … <!-- /toc -->. */
export function applyToc(md: string, maxLevel = 3): string {
  const toc = buildToc(md.replace(new RegExp(`${TOC_START}[\\s\\S]*?${TOC_END}`), ""), maxLevel);
  if (!toc) return md;
  const block = `${TOC_START}\n${toc}\n${TOC_END}`;
  const re = new RegExp(`${TOC_START}[\\s\\S]*?${TOC_END}`);
  if (re.test(md)) return md.replace(re, block);
  // после первого заголовка первого уровня, иначе в начало (после frontmatter)
  const fm = md.match(/^---\n[\s\S]*?\n---\n/);
  const head = fm ? fm[0] : "";
  const rest = md.slice(head.length);
  const h1 = rest.match(/^#\s+.+\n/);
  if (h1) return head + h1[0] + "\n" + block + "\n" + rest.slice(h1[0].length);
  return head + block + "\n\n" + rest;
}

/* --------------------------------- MOC --------------------------------- */

export interface NoteRef {
  path: string;
  title: string;
  tags: string[];
}

/** Карта содержания: заметки по папкам, внутри — по алфавиту, со ссылками [[...]]. */
export function buildMoc(notes: NoteRef[], title = "Карта содержания"): string {
  const byFolder = new Map<string, NoteRef[]>();
  for (const n of notes) {
    const i = n.path.lastIndexOf("/");
    const folder = i === -1 ? "" : n.path.slice(0, i);
    (byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push(n);
  }
  const lines = [`# ${title}`, ""];
  for (const folder of [...byFolder.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`## ${folder || "Без папки"}`, "");
    for (const n of byFolder.get(folder)!.sort((a, b) => a.title.localeCompare(b.title))) {
      const tags = n.tags.length ? ` — ${n.tags.join(" ")}` : "";
      lines.push(`- [[${n.title}]]${tags}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/* ----------------------------- Трансклюзия ----------------------------- */

/** Содержимое раздела `heading` заметки (до следующего заголовка того же или выше уровня). */
export function extractSection(md: string, heading: string): string | null {
  const lines = md.split(/\r?\n/);
  const want = slugify(heading);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    if (start === -1 && slugify(m[2]) === want) {
      start = i;
      level = m[1].length;
    } else if (start !== -1 && m[1].length <= level) {
      return lines.slice(start + 1, i).join("\n").trim();
    }
  }
  return start === -1 ? null : lines.slice(start + 1).join("\n").trim();
}

/**
 * Разворачивает ![[Заметка]] и ![[Заметка#Раздел]] в текст. Циклы и слишком
 * глубокая вложенность останавливаются пометкой, а не зависанием.
 */
export function expandTransclusions(
  md: string,
  resolve: (name: string) => string | null,
  depth = 3,
  stack: string[] = [],
): string {
  return md.replace(/!\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]/g, (m, name: string, sec?: string) => {
    const key = name.trim();
    // изображения и вложения не трогаем
    if (/\.(png|jpe?g|gif|webp|svg|pdf|mp3|mp4|wav)$/i.test(key)) return m;
    if (stack.includes(key)) return `> ⚠️ цикл трансклюзии: ${key}`;
    if (depth <= 0) return `> ⚠️ слишком глубокая вложенность: ${key}`;
    const body = resolve(key);
    if (body === null) return `> ⚠️ заметка не найдена: ${key}`;
    const part = sec ? extractSection(body, sec) : body;
    if (part === null) return `> ⚠️ раздел не найден: ${key}#${sec}`;
    return expandTransclusions(part, resolve, depth - 1, [...stack, key]);
  });
}

/* ----------------------------- Паразиты ----------------------------- */

const PARASITES = [
  "как бы",
  "типа",
  "короче",
  "в общем-то",
  "в общем",
  "так сказать",
  "на самом деле",
  "собственно",
  "по сути",
  "вот",
  "ну",
  "значит",
  "э-э",
  "эм",
];

export interface ParasiteHit {
  word: string;
  count: number;
}

export function findParasites(md: string): { total: number; hits: ParasiteHit[] } {
  const text = md.replace(/```[\s\S]*?```/g, " ").toLowerCase();
  const hits: ParasiteHit[] = [];
  for (const w of PARASITES) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, "gu");
    const count = (text.match(re) ?? []).length;
    if (count) hits.push({ word: w, count });
  }
  hits.sort((a, b) => b.count - a.count);
  return { total: hits.reduce((s, h) => s + h.count, 0), hits };
}

/* -------------------------- Приватные блоки -------------------------- */

/** Вырезает ::: private … ::: и %%…%% — для экспорта и публикации. */
export function stripPrivate(md: string): string {
  return md
    .replace(/^:::[ \t]*private[ \t]*\n[\s\S]*?\n:::[ \t]*$/gm, "")
    .replace(/%%[\s\S]*?%%/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

/* ------------------------------ Глоссарий ------------------------------ */

export interface GlossaryItem {
  term: string;
  definition: string;
}

/** Строки вида «**Термин** — определение» или «**Термин**: определение». */
export function extractGlossary(md: string): GlossaryItem[] {
  const out: GlossaryItem[] = [];
  const seen = new Set<string>();
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?\*\*([^*]{2,60})\*\*\s*(?:—|–|-|:)\s*(.{4,})$/);
    if (!m) continue;
    const term = m[1].trim();
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, definition: m[2].trim() });
  }
  return out.sort((a, b) => a.term.localeCompare(b.term));
}

/* -------------------------- Повторения (SM-2) -------------------------- */

export interface Card {
  /** Интервал в днях. */
  interval: number;
  repetitions: number;
  ease: number;
}

export const NEW_CARD: Card = { interval: 0, repetitions: 0, ease: 2.5 };

/** Оценка quality: 0–5 (меньше 3 — не вспомнил). Возвращает новое состояние карточки. */
export function sm2(card: Card, quality: number): Card {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  let { interval, repetitions, ease } = card;
  if (q < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    repetitions += 1;
    interval = repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.round(interval * ease);
  }
  ease = Math.max(1.3, Math.round((ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))) * 100) / 100);
  return { interval, repetitions, ease };
}

/** План повторений для материала, изученного в день `from` (YYYY-MM-DD). */
export function reviewPlan(from: string, intervals = [1, 3, 7, 14, 30, 60]): string[] {
  const t = Date.parse(`${from}T00:00:00Z`);
  return intervals.map((d) => new Date(t + d * 86_400_000).toISOString().slice(0, 10));
}

/* ------------------------- Формулы в таблицах ------------------------- */

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

type Grid = string[][];

function numAt(grid: Grid, ref: string, computed: Map<string, number | null>): number {
  const m = ref.match(/^([A-Za-z]+)(\d+)$/);
  if (!m) return NaN;
  const r = Number(m[2]) - 1;
  const c = colIndex(m[1]);
  const key = `${r}:${c}`;
  if (computed.has(key)) return computed.get(key) ?? NaN;
  const raw = (grid[r]?.[c] ?? "").trim();
  if (raw.startsWith("=")) return NaN; // ещё не вычислено (цикл или порядок)
  const n = Number(raw.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function rangeValues(grid: Grid, a: string, b: string, computed: Map<string, number | null>): number[] {
  const ma = a.match(/^([A-Za-z]+)(\d+)$/);
  const mb = b.match(/^([A-Za-z]+)(\d+)$/);
  if (!ma || !mb) return [];
  const [c1, c2] = [colIndex(ma[1]), colIndex(mb[1])].sort((x, y) => x - y);
  const [r1, r2] = [Number(ma[2]), Number(mb[2])].sort((x, y) => x - y);
  const out: number[] = [];
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const v = numAt(grid, `${String.fromCharCode(65 + c)}${r}`, computed);
      if (Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

/** Безопасный вычислитель выражения: числа, ссылки на ячейки, + − * / скобки. */
function evalArithmetic(expr: string): number {
  const tokens = expr.match(/\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
  if (tokens.join("") !== expr.replace(/\s+/g, "")) return NaN;
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const factor = (): number => {
    const t = tokens[i++];
    if (t === "(") {
      const v = sum();
      if (tokens[i++] !== ")") return NaN;
      return v;
    }
    if (t === "-") return -factor();
    if (t === "+") return factor();
    return Number(t);
  };
  const term = (): number => {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[i++];
      const r = factor();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return i === tokens.length ? v : NaN;
}

function evalFormula(f: string, grid: Grid, computed: Map<string, number | null>): number {
  const body = f.slice(1).trim();
  const fn = body.match(/^(SUM|AVG|AVERAGE|MIN|MAX|COUNT)\(\s*([A-Za-z]+\d+)\s*:\s*([A-Za-z]+\d+)\s*\)$/i);
  if (fn) {
    const v = rangeValues(grid, fn[2], fn[3], computed);
    if (!v.length) return fn[1].toUpperCase() === "COUNT" ? 0 : NaN;
    switch (fn[1].toUpperCase()) {
      case "SUM":
        return v.reduce((s, x) => s + x, 0);
      case "AVG":
      case "AVERAGE":
        return v.reduce((s, x) => s + x, 0) / v.length;
      case "MIN":
        return Math.min(...v);
      case "MAX":
        return Math.max(...v);
      default:
        return v.length;
    }
  }
  // арифметика со ссылками на ячейки
  const replaced = body.replace(/[A-Za-z]+\d+/g, (ref) => {
    const v = numAt(grid, ref, computed);
    return Number.isFinite(v) ? String(v) : "NaN";
  });
  if (/NaN/.test(replaced)) return NaN;
  return evalArithmetic(replaced);
}

/**
 * Находит таблицы Markdown и заменяет ячейки-формулы вычисленным значением.
 * Строка заголовка — строка 1, разделитель не считается, дальше 2, 3, …
 * Исходная формула сохраняется в комментарии <!--=… --> рядом со значением.
 */
export function evaluateTables(md: string): { text: string; evaluated: number } {
  const lines = md.split("\n");
  let evaluated = 0;
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) j++;
    const block = lines.slice(i, j);
    if (block.length >= 2 && /^\s*\|[\s:|-]+\|\s*$/.test(block[1])) {
      const rows = block.map((l) => l.trim().replace(/^\||\|$/g, "").split("|"));
      // строки таблицы без разделителя: заголовок=0, данные=1…
      const grid: Grid = rows.filter((_, k) => k !== 1).map((r) => r.map((c) => c));
      const computed = new Map<string, number | null>();
      let progress = true;
      while (progress) {
        progress = false;
        grid.forEach((row, r) =>
          row.forEach((cell, c) => {
            const key = `${r}:${c}`;
            const raw = cell.trim();
            if (computed.has(key)) return;
            const stored = raw.match(/<!--(=[\s\S]*?)-->/);
            const src = stored ? stored[1].trim() : raw;
            if (!src.startsWith("=")) return;
            const v = evalFormula(src, grid, computed);
            if (Number.isFinite(v)) {
              computed.set(key, v);
              progress = true;
            }
          }),
        );
      }
      block.forEach((line, k) => {
        if (k === 1) return;
        const r = k === 0 ? 0 : k - 1;
        const cells = line.trim().replace(/^\||\|$/g, "").split("|");
        let changed = false;
        const next = cells.map((cell, c) => {
          const v = computed.get(`${r}:${c}`);
          if (v === undefined || v === null) return cell;
          const stored = cell.match(/<!--(=[\s\S]*?)-->/);
          const raw = cell.trim();
          const formula = stored ? stored[1].trim() : raw.startsWith("=") ? raw : "";
          if (!formula) return cell;
          changed = true;
          evaluated++;
          const val = Math.round(v * 1e6) / 1e6;
          return ` ${val} <!--${formula}--> `;
        });
        if (changed) lines[i + k] = `|${next.join("|")}|`;
      });
    }
    i = j;
  }
  return { text: lines.join("\n"), evaluated };
}

/* ------------------------- «Долги» графа заметок ------------------------- */

export interface LinkDebt {
  /** Название, на которое ссылаются, но такой заметки нет. */
  target: string;
  count: number;
  from: string[];
}

/** Ссылки [[…]] на несуществующие заметки; задачи и доски (task:/canvas:) пропускаются. */
export function unresolvedLinks(notes: { path: string; title: string; content: string }[]): LinkDebt[] {
  const exist = new Set(notes.map((n) => n.title.toLowerCase()));
  const map = new Map<string, LinkDebt>();
  for (const n of notes) {
    const body = n.content.replace(/```[\s\S]*?```/g, " ");
    for (const m of body.matchAll(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const target = m[1].trim();
      if (/^(task|canvas|note|chat|lecture):/i.test(target)) continue;
      if (exist.has(target.toLowerCase())) continue;
      const key = target.toLowerCase();
      const d = map.get(key) ?? { target, count: 0, from: [] };
      d.count++;
      if (!d.from.includes(n.path)) d.from.push(n.path);
      map.set(key, d);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
}

/* ------------------------------- Цитатник ------------------------------- */

export interface Quote {
  text: string;
  source: string;
}

/** Цитаты — блоки `> …` (кроме выносок вида `> [!note]`) длиной от 20 символов. */
export function extractQuotes(notes: { path: string; title: string; content: string }[]): Quote[] {
  const out: Quote[] = [];
  const seen = new Set<string>();
  for (const n of notes) {
    const body = n.content.replace(/```[\s\S]*?```/g, " ");
    let buf: string[] = [];
    const flush = (): void => {
      const text = buf.join(" ").replace(/\s+/g, " ").trim();
      buf = [];
      if (text.length < 20 || /^\[!\w+\]/.test(text) || /^\*\*Вопрос:\*\*/.test(text)) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ text, source: n.title });
    };
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^>\s?(.*)$/);
      if (m) buf.push(m[1]);
      else flush();
    }
    flush();
  }
  return out;
}

/* ---------------------------- Экспорт в слайды ---------------------------- */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Минимальный Markdown → HTML для слайда: заголовки, списки, абзацы, **жирный**, *курсив*, `код`. */
function slideBody(md: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const flush = (): void => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      list.push(inline(li[1]));
      continue;
    }
    flush();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) out.push(`<h${Math.min(h[1].length + 1, 4)}>${inline(h[2])}</h${Math.min(h[1].length + 1, 4)}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join("\n");
}

/**
 * Одностраничная HTML-презентация: слайды разделяются строкой `---` либо
 * заголовком второго уровня. Листание — стрелками, пробелом и кликом; без
 * внешних зависимостей, открывается из файла.
 */
export function toSlidesHtml(md: string, title = "Презентация"): string {
  const clean = stripPrivate(md).replace(/^---\n[\s\S]*?\n---\n/, "");
  let parts = clean.split(/\n-{3,}\s*\n/);
  if (parts.length === 1) parts = clean.split(/\n(?=##\s)/);
  const slides = parts.map((p) => p.trim()).filter(Boolean);
  const body = slides.map((s, i) => `<section class="s${i === 0 ? " on" : ""}">${slideBody(s)}</section>`).join("\n");
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;height:100%;background:#0f1117;color:#eceef5;font:28px/1.45 system-ui,sans-serif}
section{display:none;box-sizing:border-box;height:100%;padding:6vh 8vw;overflow:auto}
section.on{display:block}
h2,h3,h4{margin:0 0 .6em;color:#ffd166} ul{padding-left:1.2em} li{margin:.3em 0}
code{background:#1d2130;padding:.05em .3em;border-radius:4px}
#n{position:fixed;right:16px;bottom:10px;font-size:14px;opacity:.6}
</style></head><body>
${body}
<div id="n"></div>
<script>
(function(){var s=[].slice.call(document.querySelectorAll("section")),i=0,n=document.getElementById("n");
function go(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach(function(e,j){e.classList.toggle("on",j===i)});n.textContent=(i+1)+" / "+s.length}
document.addEventListener("keydown",function(e){if(["ArrowRight","ArrowDown"," ","PageDown"].indexOf(e.key)>=0)go(i+1);if(["ArrowLeft","ArrowUp","PageUp"].indexOf(e.key)>=0)go(i-1)});
document.addEventListener("click",function(){go(i+1)});go(0)})();
</script></body></html>
`;
}

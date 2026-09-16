// Разведка Фазы 1 (dedup): ищем повторяющиеся блоки строк между файлами.
// Запуск: node scripts/dupScan.js [minLines] [--json]
import fs from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const MIN = Number(process.argv[2]) || 8;
const ROOTS = ["src", "server", "tests", "electron", "scripts"];
const EXT = new Set([".js", ".ts", ".tsx", ".mjs", ".jsx"]);

// Собранные артефакты (server/ts/x.ts -> server/x.js) — это не дубли кода, а его
// копия от tsc. Выводим список динамически, чтобы новый переведённый модуль не
// пришлось вписывать вручную (иначе он сразу «задублирует» свой же исходник).
const tsDir = path.join(root, "server", "ts");
const GENERATED = new Set(
  (fs.existsSync(tsDir) ? fs.readdirSync(tsDir) : [])
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => path.join("server", f.replace(/\.ts$/, ".js"))),
);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (
        e.name === "node_modules" ||
        e.name === ".git" ||
        e.name === "dist" ||
        e.name === "vendor"
      )
        continue;
      walk(p, out);
    } else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

/** Нормализуем строку: убираем отступы/пробелы, чтобы ловить копипасту с другим форматированием. */
const norm = (s) => s.replace(/\s+/g, " ").trim();

const files = ROOTS.filter((r) => fs.existsSync(path.join(root, r))).flatMap((r) =>
  walk(path.join(root, r)),
).filter((f) => !GENERATED.has(path.relative(root, f)));
const index = new Map(); // normalized line -> [{file, line}]
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const n = norm(raw);
    if (n.length < 12) return; // мелочь/скобки
    if (/^(\/\/|\/\*|\*)/.test(n)) return; // комментарии
    if (/^import |^const .* = require\(/.test(n)) return;
    if (!index.has(n)) index.set(n, []);
    index.get(n).push({ file: path.relative(root, f), line: i + 1 });
  });
}

// Ищем последовательности >= MIN строк, встретившиеся в >= 2 местах.
const sig = new Map(); // file -> normalized lines
for (const f of files)
  sig.set(path.relative(root, f), fs.readFileSync(f, "utf8").split(/\r?\n/).map(norm));
const blocks = new Map(); // key -> [{file, start}]
for (const [file, lines] of sig) {
  for (let i = 0; i + MIN <= lines.length; i++) {
    const chunk = lines.slice(i, i + MIN);
    if (chunk.some((l) => l.length < 3)) continue; // блоки со «скобками» не считаем
    const key = chunk.join("\n").replace(/[\d]+/g, "#"); // числа → шаблон (ловит копипасту с иными константами)
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push({ file, start: i + 1 });
  }
}

// Оставляем только те блоки, что реально встречаются в 2+ РАЗНЫХ файлах (или 2+ местах одного файла).
const found = [];
for (const [key, places] of blocks) {
  const unique = new Map();
  for (const p of places)
    if (!unique.has(p.file + ":" + p.start)) unique.set(p.file + ":" + p.start, p);
  const list = [...unique.values()];
  if (list.length < 2) continue;
  const filesSet = new Set(list.map((p) => p.file));
  found.push({
    lines: MIN,
    files: filesSet.size,
    places: list,
    preview: key.split("\n").slice(0, 3).join(" | ").slice(0, 110),
  });
}

// Убираем вложенные блоки (оставляем максимальные).
found.sort((a, b) => b.lines - a.lines || b.files - a.files);
const dropped = new Set();
const result = [];
for (const b of found) {
  const key = b.places
    .map((p) => p.file + ":" + p.start)
    .sort()
    .join(",");
  if (dropped.has(key)) continue;
  result.push(b);
  // помечаем все под-блоки того же набора мест как вложенные
  for (let s = 1; s < MIN; s++) {
    for (const p of b.places)
      dropped.add(
        b.places
          .map((x) => x.file + ":" + (x.start + s))
          .sort()
          .join(","),
      );
  }
}

console.log(
  `Файлов просканировано: ${files.length}; минимальный блок: ${MIN} строк; найдено дублей: ${result.length}`,
);
for (const b of result.slice(0, 40)) {
  console.log(`\n--- ${b.lines} строк × ${b.places.length} мест, файлов: ${b.files}`);
  console.log(`    ${b.preview}`);
  for (const p of b.places.slice(0, 6)) console.log(`    ${p.file}:${p.start}`);
}

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";

/**
 * Страж «комментарий, случайно оставшийся в разметке».
 *
 * Реальный баг: в JSX между элементами оказались строки комментария
 * `// Свой плеер: торрент-поток идёт через HTTP Range…`. В JSX children это не
 * комментарий, а обычный текст, поэтому надпись показывалась пользователю.
 * Типы и линтер такое не ловят: JSX-текст абсолютно легален.
 *
 * Ловим именно признак комментария в текстовом узле (`//`, `/*`, `*`), а не
 * «любой длинный текст»: легальные подписи вида «Select a note or create a new
 * one» в проекте есть, и запрещать их не нужно.
 */
const root = path.resolve(__dirname, "..");
const src = path.join(root, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

interface Leak {
  file: string;
  line: number;
  text: string;
}

/** Текстовый узел JSX, начинающийся как комментарий, — то, что видно в DOM. */
function leaksIn(file: string): Leak[] {
  const code = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Leak[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = node.getText(sf).replace(/\s+/g, " ").trim();
      if (/^(\/\/|\/\*|\*)/.test(text)) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ file: path.relative(root, file), line: pos.line + 1, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("разметка: в JSX нет случайного текста вместо комментариев", () => {
  it("текстовые дети JSX нигде не начинаются как комментарий (// или /*)", () => {
    const files = walk(src).filter((f) => f.endsWith(".tsx"));
    expect(files.length).toBeGreaterThan(20);

    const leaks = files.flatMap(leaksIn);
    const report = leaks.map((l) => `${l.file}:${l.line} → «${l.text}»`).join("\n");
    expect(report).toBe("");
  });

  it("сам страж ловит подложенный комментарий-текст", () => {
    // Проверка самого правила: без неё тест «зелёный» и при сломанном обходе AST.
    const sample = path.join(root, "tests", ".jsx-leak-sample.tsx");
    fs.writeFileSync(
      sample,
      [
        "export default function X() {",
        "  return (",
        "    <div>",
        "      // Это забытый комментарий внутри разметки — он станет текстом",
        "      <span>ok</span>",
        "    </div>",
        "  );",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const found = leaksIn(sample);
      expect(found).toHaveLength(1);
      expect(found[0].line).toBe(4);
      expect(found[0].text).toContain("забытый комментарий");
    } finally {
      fs.rmSync(sample, { force: true });
    }
  });
});
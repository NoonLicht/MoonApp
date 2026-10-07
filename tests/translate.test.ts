import { describe, it, expect } from "vitest";
import ru from "@/i18n/ru.json";
import en from "@/i18n/en.json";

/**
 * Переводчик (server/ts/translate): разбиение документов на куски не должно терять
 * и портить ничего, кроме переводимого текста; подсказка — по шаблону TranslateGemma.
 */
const seg =
  require("../server/translate/segment") as typeof import("../server/ts/translate/segment");
const langs =
  require("../server/translate/languages") as typeof import("../server/ts/translate/languages");
const engine =
  require("../server/translate/engine") as typeof import("../server/ts/translate/engine");

const join = (parts: { text: string }[]): string => parts.map((p) => p.text).join("");

describe("разбиение на куски", () => {
  const samples = [
    "Hello world.\n\nSecond paragraph here.\n\n\nThird.",
    "  leading spaces\n\ntrailing  \n",
    "Одна строка без абзацев",
    "",
    "123\n\n456",
    `${"Long sentence number one. ".repeat(120)}\n\nShort.`,
  ];

  it("склейка кусков точно равна исходнику (plain)", () => {
    for (const s of samples.slice(0, 5)) expect(join(seg.splitPlain(s))).toBe(s);
  });

  it("длинный абзац режется на куски не длиннее предела", () => {
    const parts = seg.splitPlain(samples[5]).filter((p) => p.tr);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(seg.MAX_CHARS);
  });

  it("markdown: код не переводится, текст вокруг — да", () => {
    const md = "# Title\n\nSome text.\n\n```js\nconst a = 1;\n```\n\nMore text.\n";
    const parts = seg.splitMarkdown(md);
    expect(join(parts)).toBe(md);
    const tr = parts.filter((p) => p.tr).map((p) => p.text);
    expect(tr.join("|")).not.toMatch(/const a/);
    expect(tr.join("|")).toMatch(/Some text/);
  });

  it("субтитры: тайминги и номера остаются, переводится только реплика", () => {
    const srt =
      "1\n00:00:01,000 --> 00:00:02,000\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nHow are you?\nFine.\n";
    const parts = seg.splitSubtitles(srt);
    expect(join(parts)).toBe(srt);
    const tr = parts.filter((p) => p.tr).map((p) => p.text);
    expect(tr).toEqual(["Hello there", "How are you?\nFine."]);
  });

  it("html: теги и script/style не затрагиваются", () => {
    const html =
      "<p>Hello <b>big</b> world</p><script>var x = 'text';</script><style>p{color:red}</style>";
    const parts = seg.splitHtml(html);
    expect(join(parts)).toBe(html);
    const tr = parts.filter((p) => p.tr).map((p) => p.text);
    expect(tr).toEqual(["Hello", "big", "world"]);
  });

  it("docx: текст абзаца склеивается из w:t, перевод идёт в первый run", () => {
    const xml =
      '<w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t xml:space="preserve">lo &amp; bye</w:t></w:r></w:p>';
    const paras = seg.docxParagraphs(xml);
    expect(paras[0].text).toBe("Hello & bye");
    const out = seg.docxReplace(paras[0].xml, "Привет & пока");
    expect(out).toContain("Привет &amp; пока");
    expect(out.match(/<w:t[^>]*><\/w:t>/g)).toHaveLength(1);
  });
});

describe("языки и подсказка", () => {
  it("определение языка по письменности и служебным словам", () => {
    expect(langs.detectLanguage("Привет, как дела у тебя сегодня?")).toBe("ru");
    expect(langs.detectLanguage("日本語のテキストです")).toBe("ja");
    expect(langs.detectLanguage("The cat is in the house and it is happy")).toBe("en");
    expect(langs.detectLanguage("Der Hund ist nicht in dem Haus und das ist gut")).toBe("de");
  });

  it("подсказка соответствует шаблону TranslateGemma", () => {
    const p = engine.buildPrompt("  Hello  ", "en", "ru");
    expect(
      p.startsWith(
        "<bos><start_of_turn>user\nYou are a professional English (en) to Russian (ru) translator.",
      ),
    ).toBe(true);
    expect(p).toContain(
      "Please translate the following English text into Russian:\n\n\nHello<end_of_turn>\n<start_of_turn>model\n",
    );
  });

  it("у каждого языка есть английское название", () => {
    for (const [code, name] of Object.entries(langs.LANGUAGES)) expect(name, code).toBeTruthy();
  });
});

describe("переводы страницы", () => {
  it("ru и en содержат одинаковый набор ключей translate", () => {
    const keys = (o: unknown, p = ""): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        v && typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`],
      );
    const a = keys((ru as unknown as { translate: unknown }).translate).sort();
    const b = keys((en as unknown as { translate: unknown }).translate).sort();
    expect(a).toEqual(b);
  });
});

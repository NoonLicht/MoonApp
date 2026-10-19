import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Помощник «Документов» и «Таблиц» и каталог моделей: разделы списка, ссылки Hugging Face,
 * чтение страниц для модели и подрезка истории под окно контекста.
 */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-assistant-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
let models: any;
let web: any;
let llm: any;

beforeAll(() => {
  models = req("../server/llamacpp/models");
  web = req("../server/assistant/web");
  llm = req("../server/assistant/llm");
});

afterAll(() => {
  try {
    fs.rmSync(STORAGE, { recursive: true, force: true });
  } catch {
    /* не критично */
  }
});

describe("разделы списка моделей", () => {
  it("Qwen, Gemma, прочие и картинки — по семейству", () => {
    expect(models.sectionOf("qwen35-9b")).toBe("qwen");
    expect(models.sectionOf("qwen3tts")).toBe("qwen");
    expect(models.sectionOf("gemma4-e4b")).toBe("gemma");
    expect(models.sectionOf("embeddinggemma2")).toBe("gemma");
    expect(models.sectionOf("qwen-image-21-turbo")).toBe("image");
    // узкие и сторонние модели — в «прочие»
    for (const g of ["translategemma-4b", "chandra2", "gpt-oss-20b", "granite40-h-tiny", "glm47-flash"])
      expect(models.sectionOf(g)).toBe("other");
  });

  it("в каталоге есть запрошенные модели и все строки получили раздел", () => {
    const groups = new Set(models.CATALOG.map((m: any) => m.group));
    for (const g of ["gemma4-e4b", "gemma4-e2b", "qwen35-9b", "qwen35-4b", "qwen3vl-8b-instruct"])
      expect(groups.has(g)).toBe(true);
    for (const m of models.CATALOG) expect(["qwen", "gemma", "other", "image"]).toContain(m.section);
    // GLM — минимум три модели, все в «прочих»
    const glm = new Set(models.CATALOG.filter((m: any) => /^glm/.test(m.group)).map((m: any) => m.group));
    expect(glm.size).toBeGreaterThanOrEqual(3);
    for (const m of models.CATALOG.filter((x: any) => /^glm/.test(x.group))) expect(m.section).toBe("other");
  });

  it("Qwen-Image 2.1 и Turbo: кванты 3–6, файлы в папке sd, рядом VAE и текстовый энкодер", () => {
    for (const g of ["qwen-image-21", "qwen-image-21-turbo"]) {
      const rows = models.CATALOG.filter((m: any) => m.group === g);
      expect(rows.map((r: any) => r.note).sort()).toEqual(["q3km", "q4km", "q5km", "q6k"]);
      for (const r of rows) {
        expect(r.section).toBe("image");
        expect(r.dir).toBe("sd");
        const extra = r.extra.map((e: any) => `${e.repo}:${e.file}`);
        expect(extra).toContain("unsloth/Qwen-Image-2.1-FP8:vae/qwen_image_2.1_vae_bf16.safetensors");
        expect(extra.some((x: string) => /Qwen3-VL-8B-Instruct-GGUF/.test(x))).toBe(true);
      }
    }
  });
});

describe("ссылки Hugging Face", () => {
  it("страница репозитория и ссылка на файл", () => {
    expect(models.parseHfUrl("https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-Quantized")).toEqual({
      repo: "abenzerps/Qwen-Image-2.1-Uncensored-Quantized",
      rev: "main",
    });
    expect(models.parseHfUrl("https://huggingface.co/a/b/tree/dev")).toEqual({ repo: "a/b", rev: "dev" });
    expect(models.parseHfUrl("https://huggingface.co/a/b/resolve/main/x/m-Q4_K_M.gguf?download=true")).toEqual({
      repo: "a/b",
      rev: "main",
      file: "x/m-Q4_K_M.gguf",
    });
    expect(models.parseHfUrl("https://example.com/a/b")).toBeNull();
    expect(models.parseHfUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("чтение страниц для помощника", () => {
  it("убирает скрипты и меню, не ломается на «>» внутри атрибутов", () => {
    const html = `<html><head><title>Тест &amp; страница</title><script>var x = "<b>";</script></head>
      <body><nav>меню</nav><div data-props='{"a":"x > y"}'><h1>Заголовок</h1><p>Первый <b>абзац</b>.</p>
      <ul><li>раз</li><li>два</li></ul></div><footer>подвал</footer></body></html>`;
    const r = web.htmlToText(html);
    expect(r.title).toBe("Тест & страница");
    expect(r.text).toContain("Заголовок");
    expect(r.text).toContain("Первый абзац.");
    expect(r.text).toContain("- раз");
    expect(r.text).not.toMatch(/меню|подвал|var x|x > y|data-props/);
  });

  it("локальные адреса запрещены", async () => {
    await expect(web.webFetch("http://127.0.0.1:4000/api/health")).rejects.toThrow("private_address");
    await expect(web.webFetch("http://192.168.1.1/")).rejects.toThrow("private_address");
    await expect(web.webFetch("ftp://example.com/")).rejects.toThrow("bad_url");
  });
});

describe("подрезка истории под окно контекста", () => {
  const msg = (role: string, n: number, extra: object = {}) => ({ role, content: "x".repeat(n), ...extra });

  it("system и последнее сообщение остаются, старое уходит", () => {
    const out = llm.fit([msg("system", 100), msg("user", 4000), msg("assistant", 4000), msg("user", 100)], 600);
    expect(out[0].role).toBe("system");
    expect(out[out.length - 1].content.length).toBe(100);
    expect(out.length).toBeLessThan(4);
  });

  it("вызов инструмента уходит вместе с результатом, сирот не остаётся", () => {
    const calls = [{ id: "c1", name: "read_document", arguments: "{}" }];
    const out = llm.fit(
      [
        msg("system", 50),
        msg("assistant", 0, { tool_calls: calls }),
        msg("tool", 5000, { tool_call_id: "c1" }),
        msg("user", 50),
      ],
      300,
    );
    expect(out.some((m: any) => m.role === "tool")).toBe(false);
    expect(out.map((m: any) => m.role)).toEqual(["system", "user"]);
  });
});

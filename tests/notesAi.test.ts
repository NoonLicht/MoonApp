import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/notesAi (TS-исходник server/ts/notesAi.ts → server/notesAi.js):
 * ИИ-оформление заметок MySpace.
 *
 * Проверяем то, на чём держатся роуты (server/routes/myspace.js):
 *  - sidecar-исходники .ai/<имя>.txt: имя, контейнмент пути, запись/чтение/перенос;
 *  - «Оформить» сохраняет исходник ДО запроса к модели (падать — так падать с
 *    исходником, а не без него);
 *  - «Регенерировать» собирает текст из ИСХОДНИКА, а не из текущей заметки;
 *  - разбиение длинной заметки не теряет строки, но ограничено предохранителем;
 *  - коды ошибок notes_ai_* (нет ключа/модели/исходника, потеря текста)
 *    доходят до страницы заметок, которая переводит их в подсказки.
 *
 * Провайдер чата подменяется заглушкой: сеть в тестах не нужна и недопустима.
 */
const req = createRequire(import.meta.url);

let storage: string;
let notesAi: any;
let providers: any;
let security: any;
let settings: any;
let fsUtil: any;
let vault: any;

/** Аргументы, с которыми вызывали provider.chat (по одному на запрос). */
let chatCalls: any[];
/** Ответ модели: строка или функция (для поочерёдных ответов блокам). */
let answer: string | (() => string);
let defaultChatModel: string;

const notesDir = (): string => path.join(storage, "vault", "notes");
const aiDir = (): string => path.join(notesDir(), ".ai");

/** Чистит vault/notes между тестами (кириллица → только fsUtil.removePath). */
function resetNotes(): void {
  const dir = notesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return;
  }
  for (const entry of fs.readdirSync(dir)) fsUtil.removePath(path.join(dir, entry));
}

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-notesai-"));
  process.env.MOONAPP_STORAGE = storage;
  settings = req("../server/settings");
  defaultChatModel = String((settings.get("chat") || {}).model || "");
});

beforeEach(() => {
  chatCalls = [];
  answer = "## Оформленная заметка\n\n- пункт";
  notesAi = req("../server/notesAi");
  providers = req("../server/providers");
  security = req("../server/security");
  fsUtil = req("../server/fsUtil");
  vault = req("../server/myspace-vault");
  resetNotes();
  // Заглушка провайдера: id/модели/чат. getProvider вызывается по свойству
  // модуля, поэтому подмена видна notesAi.js без перезагрузки модуля.
  providers.getProvider = () => ({
    id: "deepseek",
    models: ["deepseek-chat"],
    listModels: async () => ["deepseek-chat"],
    chat: async (opts: any) => {
      chatCalls.push(opts);
      return typeof answer === "function" ? answer() : answer;
    },
  });
  security.getSecret = () => "test-key";
});
describe("server/notesAi — форма модуля и sidecar-исходники", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    expect(notesAi.default).toBeUndefined();
    expect(Object.keys(notesAi).sort()).toEqual(
      [
        "NOTES_DIR",
        "SOURCE_DIR",
        "aiCfg",
        "aiConfig",
        "aiProviders",
        "cleanupAnswer",
        "formatNote",
        "moveSource",
        "providerModels",
        "readSource",
        "removeSource",
        "setAiConfig",
        "sourceInfo",
        "sourcePath",
        "splitForFormat",
        "structureQuickNote",
        "writeSource",
      ].sort(),
    );
  });

  it("исходник лежит в storage/vault/notes/.ai и повторяет имя заметки", () => {
    expect(notesAi.NOTES_DIR).toBe(notesDir());
    expect(notesAi.SOURCE_DIR).toBe(aiDir());
    expect(notesAi.sourcePath("Моя заметка.md")).toBe(path.join(aiDir(), "Моя заметка.txt"));
    // Папка заметки не влияет на имя sidecar'а: он всегда рядом с .ai.
    expect(notesAi.sourcePath("Учёба/Физика/Лекция 1.md")).toBe(path.join(aiDir(), "Лекция 1.txt"));
  });

  it("не даёт выйти за .ai даже при path traversal и мусорных символах", () => {
    for (const bad of ["../../secret.md", "..\\..\\secret.md", "C:\\Windows\\evil.md"]) {
      const p = notesAi.sourcePath(bad);
      expect(path.dirname(p), bad).toBe(aiDir());
    }
    // Windows не примет такие имена — заменяем, иначе writeFileSync упадёт.
    // («a:b" стал бы диском: basename видит в нём букву диска, поэтому в тесте
    // нелегальные символы стоят после имени.)
    expect(path.basename(notesAi.sourcePath("отчёт?*.md"))).toBe("отчёт_.txt");
  });

  it("пишет, читает, показывает состояние и удаляет исходник (кириллица!)", () => {
    const note = "Моя заметка.md";
    expect(notesAi.sourceInfo(note)).toMatchObject({ exists: false, chars: 0, updatedAt: "" });
    const w = notesAi.writeSource(note, "сырой текст\nвторая строка");
    expect(w.ok).toBe(true);
    expect(notesAi.readSource(note)).toBe("сырой текст\nвторая строка");
    const info = notesAi.sourceInfo(note);
    expect(info.exists).toBe(true);
    expect(info.chars).toBe("сырой текст\nвторая строка".length);
    expect(info.updatedAt).not.toBe("");
    expect(notesAi.removeSource(note)).toBe(true);
    expect(notesAi.sourceInfo(note).exists).toBe(false);
  });

  it("переносит исходник вслед за переименованием заметки", () => {
    notesAi.writeSource("Старое имя.md", "текст");
    expect(notesAi.moveSource("Старое имя.md", "Новое имя.md")).toBe(true);
    expect(notesAi.readSource("Старое имя.md")).toBe("");
    expect(notesAi.readSource("Новое имя.md")).toBe("текст");
    // Переносить нечего — это не ошибка, просто false.
    expect(notesAi.moveSource("Нет такого.md", "Куда-то.md")).toBe(false);
  });

  it("папка .ai скрыта от проводника заметок", () => {
    notesAi.writeSource("Заметка.md", "текст");
    vault.writeFile("Заметка.md", "# Заметка", {});
    const names = vault.buildTree().map((n: any) => n.name);
    expect(names).toContain("Заметка.md");
    expect(names).not.toContain(".ai");
  });
});

/**
 * splitForFormat/cleanupAnswer — вспомогательная механика оформления: длинную
 * заметку режем, короткую отправляем целиком, а ```-обёртку модели снимаем.
 */
describe("server/notesAi — разбиение и очистка ответа", () => {
  it("пустой текст даёт пустой список блоков", () => {
    expect(notesAi.splitForFormat("")).toEqual([]);
    expect(notesAi.splitForFormat("   \n \n")).toEqual([]);
  });
  it("короткую заметку отправляем одним блоком", () => {
    expect(notesAi.splitForFormat("строка 1\nстрока 2", 100)).toEqual(["строка 1\nстрока 2"]);
  });
  it('длинную режем по строкам — join("\\n") возвращает исходник символ в символ', () => {
    const text = Array.from({ length: 60 }, (_, i) => `строка ${i}`).join("\n");
    const blocks = notesAi.splitForFormat(text, 50);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join("\n")).toBe(text);
    for (const b of blocks) expect(b.length).toBeLessThanOrEqual(50);
  });
  it("снимает ```-обёртку вокруг всего ответа", () => {
    expect(notesAi.cleanupAnswer("```markdown\n## Заголовок\n\nтекст\n```")).toBe(
      "## Заголовок\n\nтекст",
    );
    expect(notesAi.cleanupAnswer("```\n## Заголовок\n```")).toBe("## Заголовок");
  });
  it("не трогает заметку, в которой код — это часть текста", () => {
    const note = "# Заметка\n\n```js\nconst a = 1;\n```\n";
    expect(notesAi.cleanupAnswer(note)).toBe(note.trim());
  });
});
describe("server/notesAi — «Оформить» и «Регенерировать»", () => {
  const note = "Черновик.md";
  const raw = "  теория вероятности\n\n\n формула p(a) = 0.5   ";

  it("«Оформить» сохраняет исходник и отдаёт размеченный ответ модели", async () => {
    const res = await notesAi.formatNote({ path: note, content: raw, title: "Черновик" });
    expect(res.regenerated).toBe(false);
    expect(res.content).toBe("## Оформленная заметка\n\n- пункт");
    expect(res.rawChars).toBe(raw.trim().length);
    expect(res.chars).toBe(res.content.length);
    expect(res.blocks).toBe(1);
    expect(res.provider).toBe("deepseek");
    // Исходник — ровно текущий текст заметки (без хвостовых пробелов).
    expect(notesAi.readSource(note)).toBe(raw.trim());
    // В модель ушёл текст заметки и заголовок, настройки — детерминированные.
    const call = chatCalls[0];
    expect(call.messages[1].text).toContain("теория вероятности");
    expect(call.messages[1].text).toContain("Черновик");
    expect(call.temperature).toBe(0.3);
    expect(call.stream).toBe(true);
    expect(call.model).toBe(defaultChatModel);
  });

  it("исходник остаётся на диске, даже если модель упала", async () => {
    answer = () => {
      throw new Error("HTTP 500");
    };
    await expect(notesAi.formatNote({ path: note, content: raw })).rejects.toThrow(/HTTP 500/);
    expect(notesAi.readSource(note)).toBe(raw.trim());
  });

  it("«Регенерировать» собирает текст из исходника, а не из текущей заметки", async () => {
    await notesAi.formatNote({ path: note, content: raw, title: "Черновик" });
    chatCalls = [];
    // Пользователь правил уже оформленную версию — регенерация это игнорирует.
    const res = await notesAi.formatNote({
      path: note,
      content: "правки, которых не должно быть в запросе",
      mode: "regenerate",
    });
    expect(res.regenerated).toBe(true);
    expect(res.rawChars).toBe(raw.trim().length);
    expect(chatCalls[0].messages[1].text).toContain("теория вероятности");
    expect(chatCalls[0].messages[1].text).not.toContain("которых не должно быть");
  });

  it("«Регенерировать» без сохранённого исходника — понятная ошибка, а не пустой запрос", async () => {
    await expect(notesAi.formatNote({ path: "Пусто.md", mode: "regenerate" })).rejects.toThrow(
      /notes_ai_no_source/,
    );
    expect(chatCalls).toEqual([]);
  });

  it("пустую заметку в модель не отправляем", async () => {
    await expect(notesAi.formatNote({ path: note, content: "   \n\n " })).rejects.toThrow(
      /notes_ai_empty_note/,
    );
    expect(chatCalls).toEqual([]);
    expect(notesAi.readSource(note)).toBe("");
  });

  it("длинную заметку отправляем блоками и склеиваем ответы по порядку", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `строка номер ${i} с текстом`);
    const long = lines.join("\n");
    const queue = ["```md\nБЛОК-1\n```", "БЛОК-2", "БЛОК-3", "БЛОК-4", "БЛОК-5"];
    answer = () => queue.shift() || "БЛОК-N";
    const res = await notesAi.formatNote({ path: note, content: long, title: "Длинная" });
    expect(res.blocks).toBeGreaterThan(1);
    expect(chatCalls.length).toBe(res.blocks);
    expect(res.content.startsWith("БЛОК-1")).toBe(true);
    expect(res.content).toContain("\n\n"); // склейка блоков
    // Промпт знает, что это фрагмент, и просит не повторять продолжение.
    expect(chatCalls[0].messages[1].text).toContain("ФРАГМЕНТ 1 из");
  });

  it("слишком длинную заметку не отправляем вовсе (предохранитель)", async () => {
    const huge = Array.from({ length: 3000 }, (_, i) => `строка ${i} ${"x".repeat(100)}`).join(
      "\n",
    );
    await expect(notesAi.formatNote({ path: note, content: huge })).rejects.toThrow(
      /notes_ai_too_long/,
    );
    expect(chatCalls).toEqual([]);
  });

  it("потеря текста моделью — ошибка, а не молча укороченная заметка", async () => {
    answer = "ок";
    await expect(notesAi.formatNote({ path: note, content: "а".repeat(500) })).rejects.toThrow(
      /notes_ai_short_output/,
    );
  });

  it("пустой ответ модели — ошибка (оформлять нечего)", async () => {
    answer = "   \n  ";
    await expect(notesAi.formatNote({ path: note, content: raw })).rejects.toThrow(
      /notes_ai_empty_response/,
    );
  });
});
describe("server/notesAi — коды ошибок для подсказок в UI", () => {
  const note = "Заметка.md";

  it("неизвестный провайдер чата", async () => {
    providers.getProvider = () => {
      throw new Error("unknown provider");
    };
    await expect(notesAi.formatNote({ path: note, content: "текст" })).rejects.toThrow(
      /notes_ai_provider_unknown/,
    );
  });

  it("нет ключа провайдера — сообщение содержит имя провайдера", async () => {
    security.getSecret = () => "";
    await expect(notesAi.formatNote({ path: note, content: "текст" })).rejects.toThrow(
      /notes_ai_not_configured: deepseek/,
    );
    expect(chatCalls).toEqual([]);
  });

  it("модель не задана в чате — берём chat-модель из списка провайдера", async () => {
    settings.set({ chat: { model: "" } });
    try {
      providers.getProvider = () => ({
        id: "deepseek",
        models: [],
        // reasoner медленнее и хуже держит длинный контекст — ожидаем chat-модель.
        listModels: async () => ["deepseek-reasoner", "deepseek-chat"],
        chat: async (opts: any) => {
          chatCalls.push(opts);
          return "## Готово";
        },
      });
      const res = await notesAi.formatNote({ path: note, content: "черновик" });
      expect(chatCalls[0].model).toBe("deepseek-chat");
      expect(res.model).toBe("deepseek-chat");
    } finally {
      settings.set({ chat: { model: defaultChatModel } });
    }
  });

  it("список моделей пуст и настройка пуста — понятная ошибка про модель", async () => {
    settings.set({ chat: { model: "" } });
    try {
      providers.getProvider = () => ({
        id: "deepseek",
        models: [],
        listModels: async () => [],
        chat: async () => "не должно вызваться",
      });
      await expect(notesAi.formatNote({ path: note, content: "черновик" })).rejects.toThrow(
        /notes_ai_model_missing: deepseek/,
      );
    } finally {
      settings.set({ chat: { model: defaultChatModel } });
    }
  });

  it("сбой listModels не мешает оформлению (берём каталог провайдера)", async () => {
    settings.set({ chat: { model: "" } });
    try {
      providers.getProvider = () => ({
        id: "deepseek",
        models: ["deepseek-chat"],
        listModels: async () => {
          throw new Error("нет сети");
        },
        chat: async (opts: any) => {
          chatCalls.push(opts);
          return "## Готово";
        },
      });
      const res = await notesAi.formatNote({ path: note, content: "черновик" });
      expect(res.model).toBe("deepseek-chat");
    } finally {
      settings.set({ chat: { model: defaultChatModel } });
    }
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Тесты AI-конспекта (server/lecture.js → generateConspectus).
 *
 * Контекст: раньше конспект уходил в локальный Ollama и обрезался до последних
 * 14 000 символов расшифровки — для длинной лекции конспект строился по её концу.
 * Теперь расшифровка режется на блоки, каждый блок превращается в черновые
 * заметки, а затем заметки сводятся в конспект.
 *
 * Сеть не трогаем: провайдера подставляем свой (generateConspectus принимает
 * target) — проверяем ЛОГИКУ нарезки, два прохода, прогресс и тексты ошибок.
 *
 * ВАЖНО про способ загрузки модулей: server/* — это CJS, и динамический import()
 * даёт ДРУГОЙ экземпляр модуля, чем require() внутри server/lecture.js (два
 * независимых соединения к БД: строка, вставленная через import, не видна
 * lecture.getStatus). Поэтому берём модули тем же способом, что и сервер.
 */
const req = createRequire(import.meta.url);

beforeAll(() => {
  // storage подменяем ДО загрузки server/*: config читает MOONAPP_STORAGE при require.
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-conspectus-"));
});

/** Модуль лекций (тот же экземпляр, что и в сервере). */
function lectureMod(): any {
  return req("../server/lecture");
}

/** Провайдер-заглушка: помнит запросы и отдаёт заготовленный текст. */
function fakeTarget(reply: (prompt: string, i: number) => string) {
  const prompts: string[] = [];
  return {
    prompts,
    target: {
      provider: {
        id: "fake",
        chat: async ({ messages }: { messages: { text: string }[] }) => {
          const prompt = messages.map((m) => m.text).join("\n");
          prompts.push(prompt);
          return reply(prompt, prompts.length - 1);
        },
      },
      secret: "test-key",
      model: "fake-model",
      cfg: {
        providerId: "fake",
        model: "fake-model",
        chunkChars: 400,
        overlapChars: 120,
        maxChunks: 3,
        temperature: 0.3,
      },
    },
  };
}

/** Сессия с готовой расшифровкой (тексты чанков пишем прямо в БД). */
async function sessionWithChunks(texts: string[]) {
  const lecture = lectureMod();
  const { stmts } = req("../server/db");
  const info = stmts.lectureInsert.run("лекция с расшифровкой", 16000, 1);
  const id = Number(info.lastInsertRowid);
  texts.forEach((text, i) => {
    stmts.chunkInsert.run(id, i + 1, i * 20000, i * 20000 + 19000, `chunk_${i}.wav`, {
      status: "done",
      text,
      error: "",
    });
  });
  return { lecture, stmts, id };
}
describe("AI-конспект — нарезка на блоки (transcriptBlocks)", () => {
  const chunks = (n: number, len = 200) =>
    Array.from({ length: n }, (_, i) => ({ start_ms: i * 20000, text: "с".repeat(len) }));

  it("режет длинную расшифровку на блоки с таймкодами", async () => {
    const lecture = await lectureMod();
    const { blocks, total, truncated } = lecture.transcriptBlocks(chunks(20), 1000, 0, 60);
    expect(blocks.length).toBeGreaterThan(1);
    expect(total).toBe(blocks.length);
    expect(truncated).toBe(false);
    // Каждый блок начинается с таймкода — модель видит хронологию лекции.
    for (const b of blocks) expect(b.startsWith("[00:")).toBe(true);
  });

  it("«шов»: начало следующего блока ссылается на конец предыдущего", async () => {
    const lecture = await lectureMod();
    const { blocks } = lecture.transcriptBlocks(chunks(20), 1000, 200, 60);
    expect(blocks.length).toBeGreaterThan(1);
    // Второй блок несёт хвост предыдущего, иначе разрезанная фраза теряет смысл.
    expect(blocks[1]).toContain("продолжение предыдущего фрагмента");
  });

  it("предохранитель: очень длинная лекция режется до maxChunks и помечается truncated", async () => {
    const lecture = await lectureMod();
    const { blocks, total, truncated } = lecture.transcriptBlocks(chunks(50), 500, 0, 3);
    expect(blocks).toHaveLength(3);
    expect(truncated).toBe(true);
    expect(total).toBeGreaterThan(3);
  });

  it("без текста чанков блоков нет", async () => {
    const lecture = await lectureMod();
    const { blocks, truncated } = lecture.transcriptBlocks(
      [
        { start_ms: 0, text: "" },
        { start_ms: 1000, text: "   " },
      ],
      1000,
      0,
      10,
    );
    expect(blocks).toEqual([]);
    expect(truncated).toBe(false);
  });
});
describe("AI-конспект — сборка (generateConspectus)", () => {
  it("несуществующая сессия — session_not_found", async () => {
    const lecture = await lectureMod();
    await expect(lecture.generateConspectus(999999)).rejects.toThrow(/session_not_found/);
  });

  it("без расшифровки — no_transcript_yet", async () => {
    const { lecture, id } = await sessionWithChunks([]);
    await expect(lecture.generateConspectus(id)).rejects.toThrow(/no_transcript_yet/);
  });

  it("собирает конспект в два прохода и сохраняет его в заметки", async () => {
    const { lecture, stmts, id } = await sessionWithChunks(
      // Тексты длиннее порога блока (400 символов в fake-настройках) — иначе
      // расшифровка влезла бы в один блок и второй проход не проверился бы.
      Array.from(
        { length: 6 },
        (_, i) => `Фрагмент ${i + 1}. ` + "определение производной и предела функции. ".repeat(8),
      ),
    );
    const fake = fakeTarget((prompt, i) =>
      prompt.includes("=== ФРАГМЕНТ ===") ? `заметка ${i + 1}` : "## Обзор\nготовый конспект",
    );
    const res = await lecture.generateConspectus(id, { target: fake.target });

    expect(res.markdown).toContain("## Обзор");
    expect(res.model).toBe("fake/fake-model");
    expect(res.blocks).toBeGreaterThan(1);
    // Первый проход — по запросу на блок, второй — сведение в конспект.
    expect(fake.prompts.length).toBe(res.blocks + 1);
    expect(fake.prompts[0]).toContain("=== ФРАГМЕНТ ===");
    expect(fake.prompts[fake.prompts.length - 1]).toContain("=== ЗАМЕТКИ ===");
    // Конспект сохранён в заметки лекции (кнопка «Сохранить заметки» его не потеряет).
    expect(String(stmts.lectureGet.get(id).notes)).toContain("## Обзор");
    const st = lecture.conspectusState(id);
    expect(st.state).toBe("done");
    expect(st.progress).toBe(res.blocks);
    expect(st.model).toBe("fake-model");
  });

  it("ошибка провайдера попадает в состояние (UI покажет причину)", async () => {
    const { lecture, id } = await sessionWithChunks(["короткая расшифровка"]);
    const failing = {
      provider: {
        id: "fake",
        chat: async () => {
          throw new Error("api error 401: invalid key");
        },
      },
      secret: "x",
      model: "fake-model",
      cfg: {
        providerId: "fake",
        model: "fake-model",
        chunkChars: 400,
        overlapChars: 0,
        maxChunks: 3,
        temperature: 0.3,
      },
    };
    await expect(lecture.generateConspectus(id, { target: failing })).rejects.toThrow(/401/);
    const st = lecture.conspectusState(id);
    expect(st.state).toBe("error");
    expect(st.error).toContain("401");
  });

  it("пустой ответ модели — conspectus_empty_response, а не пустой конспект", async () => {
    const { lecture, id } = await sessionWithChunks(["текст лекции"]);
    const empty = fakeTarget(() => "   ");
    await expect(lecture.generateConspectus(id, { target: empty.target })).rejects.toThrow(
      /conspectus_empty_response/,
    );
  });

  it("второй запуск во время сборки — conspectus_busy", async () => {
    const { lecture, id } = await sessionWithChunks(
      Array.from({ length: 4 }, (_, i) => `Блок ${i + 1}. Определения и формулы.`),
    );
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = fakeTarget(() => "заметка");
    slow.target.provider.chat = async ({ messages }: { messages: { text: string }[] }) => {
      await gate; // держим первый запрос, пока не отпустим
      const prompt = messages.map((m) => m.text).join("\n");
      return prompt.includes("=== ФРАГМЕНТ ===") ? "заметка" : "## Обзор";
    };
    const first = lecture.generateConspectus(id, { target: slow.target });
    await new Promise((r) => setTimeout(r, 30)); // даём прогону дойти до модели
    await expect(lecture.generateConspectus(id, { target: slow.target })).rejects.toThrow(
      /conspectus_busy/,
    );
    release?.();
    const res = await first;
    expect(res.markdown).toContain("## Обзор");
  });

  it("conspectusState по умолчанию — idle", async () => {
    const lecture = await lectureMod();
    const st = lecture.conspectusState(999999);
    expect(st.state).toBe("idle");
    expect(st.progress).toBe(0);
  });
});

/**
 * Двухдорожечная разметка говорящих (часть диаризации, не требующая модели):
 * эфир (sys) — лектор, микрофон (mic) — аудитория в комнате. Подписи приходят
 * с клиента (переведённые), потому что экспорт читает пользователь.
 */
describe("Экспорт — подписи говорящих (dual-track)", () => {
  function sessionWithSpeakers() {
    const lecture = lectureMod();
    const { stmts } = req("../server/db");
    const info = stmts.lectureInsert.run("лекция с эфиром", 16000, 1);
    const id = Number(info.lastInsertRowid);
    // Дорожка эфира (лектор) и микрофона (аудитория) — как при двухдорожечной записи.
    stmts.chunkInsert.run(id, 1, 0, 4000, "sys_00001.wav", {
      status: "done",
      text: "Лектор говорит",
      source: "sys",
    });
    stmts.chunkInsert.run(id, 2, 4000, 8000, "chunk_00002.wav", {
      status: "done",
      text: "Студент спрашивает",
      source: "mic",
    });
    return { lecture, id };
  }

  it("SRT подписывает реплики «— Лектор:» и «— Аудитория:»", () => {
    const { lecture, id } = sessionWithSpeakers();
    const out = lecture.exportContent(id, "srt", { mode: "dual", sys: "Лектор", mic: "Аудитория" });
    expect(out.body).toContain("— Лектор: Лектор говорит");
    expect(out.body).toContain("— Аудитория: Студент спрашивает");
  });

  it("VTT использует <v Имя> — плееры читают это как имя говорящего", () => {
    const { lecture, id } = sessionWithSpeakers();
    const out = lecture.exportContent(id, "vtt", { mode: "dual", sys: "Лектор", mic: "Аудитория" });
    expect(out.body).toContain("<v Лектор>Лектор говорит");
    expect(out.body).toContain("<v Аудитория>Студент спрашивает");
  });

  it("Markdown помечает говорящего рядом с таймкодом", () => {
    const { lecture, id } = sessionWithSpeakers();
    const out = lecture.exportContent(id, "md", { mode: "dual", sys: "Лектор", mic: "Аудитория" });
    expect(out.body).toContain("**Лектор:**");
    expect(out.body).toContain("**Аудитория:**");
  });

  it("labels=off отключает подписи (экспорт как раньше)", () => {
    const { lecture, id } = sessionWithSpeakers();
    const out = lecture.exportContent(id, "srt", { mode: "off" });
    expect(out.body).not.toContain("— Лектор:");
    expect(out.body).toContain("Лектор говорит");
  });
});
describe("AI-конспект — настройки, провайдеры и умный авто-запуск", () => {
  it("провайдер по умолчанию — DeepSeek, режим — умный авто", async () => {
    const lecture = await lectureMod();
    const s = lecture.conspectusSettings();
    expect(s.providerId).toBe("deepseek");
    expect(s.trigger).toBe("smart");
    // Ключ берётся из настроек провайдеров: в тестовом storage его нет.
    expect(s.hasKey).toBe(false);
    expect(s.triggerOptions).toEqual(["smart", "auto", "manual"]);
    // Список для селекта: DeepSeek присутствует и помечен «нет ключа».
    const ds = s.providers.find((p: { id: string }) => p.id === "deepseek");
    expect(ds).toBeTruthy();
    expect(ds.hasKey).toBe(false);
  });

  it("сохраняет режим/провайдера и отвергает мусор", async () => {
    const lecture = await lectureMod();
    const s = lecture.setConspectusSettings({
      trigger: "manual",
      providerId: "openai",
      autoMinChars: 500,
    });
    expect(s.trigger).toBe("manual");
    expect(s.providerId).toBe("openai");
    expect(s.autoMinChars).toBe(500);

    // Пустая строка = «провайдер как в настройках чата».
    expect(lecture.setConspectusSettings({ providerId: "" }).providerFromChat).toBe(true);

    expect(() => lecture.setConspectusSettings({ trigger: "sometimes" })).toThrow(
      /conspectus_trigger_unknown/,
    );
    expect(() => lecture.setConspectusSettings({ providerId: "not-a-provider" })).toThrow(
      /conspectus_provider_unknown/,
    );

    // Вернуть дефолт, чтобы не портить следующие проверки авто-запуска.
    lecture.setConspectusSettings({ trigger: "smart", providerId: "deepseek", autoMinChars: 1200 });
  });

  it("умный режим молчит, если расшифровки мало (autoMinChars)", async () => {
    const { lecture, id } = await sessionWithChunks(["короткая фраза"]);
    lecture.setConspectusSettings({ trigger: "smart", autoMinChars: 5000 });
    lecture.maybeAutoConspectus(id);
    await new Promise((r) => setTimeout(r, 30));
    // Расшифровка меньше порога — сборка не начиналась.
    expect(lecture.conspectusState(id).state).toBe("idle");
  });

  it("режим «вручную» не запускает авто-сборку", async () => {
    const { lecture, id } = await sessionWithChunks(["А".repeat(3000)]);
    lecture.setConspectusSettings({ trigger: "manual" });
    lecture.maybeAutoConspectus(id);
    await new Promise((r) => setTimeout(r, 30));
    expect(lecture.conspectusState(id).state).toBe("idle");
  });

  it("режим «всегда авто» реально стартует сборку (падает на отсутствии ключа)", async () => {
    const { lecture, id } = await sessionWithChunks(["Б".repeat(3000)]);
    lecture.setConspectusSettings({ trigger: "auto" });
    lecture.maybeAutoConspectus(id);
    // Даём прогону дойти до провайдера: ключа в тестовом storage нет, поэтому
    // задача обязана перейти в error с понятной причиной — это и есть признак,
    // что авто-запуск состоялся (а не «тихо ничего не сделал»).
    await new Promise((r) => setTimeout(r, 60));
    const st = lecture.conspectusState(id);
    expect(st.state).toBe("error");
    expect(String(st.error)).toMatch(/conspectus_not_configured|conspectus_model_missing/);
    lecture.setConspectusSettings({ trigger: "smart" });
  });

  it("конспект помечается устаревшим, когда расшифровка заметно выросла", async () => {
    const { lecture, stmts, id } = await sessionWithChunks(["В".repeat(2000)]);
    const fake = fakeTarget((prompt) =>
      prompt.includes("=== ФРАГМЕНТ ===") ? "заметка" : "## Обзор",
    );
    await lecture.generateConspectus(id, { target: fake.target });

    const lec = stmts.lectureGet.get(id);
    expect(lec.conspectus_at).toBeTruthy(); // время сборки записано
    expect(lecture.transcriptWeight(id).chars).toBe(2000);
    expect(lecture.conspectusState(id).stale).toBe(false);

    // Дослали текст — конспект построен по меньшей части лекции.
    stmts.chunkInsert.run(id, 5, 60000, 80000, "chunk_00005.wav", {
      status: "done",
      text: "Г".repeat(4000),
    });
    expect(lecture.conspectusState(id).stale).toBe(true);
    expect(lecture.conspectusState(id).transcriptChars).toBe(6000);
  });
});

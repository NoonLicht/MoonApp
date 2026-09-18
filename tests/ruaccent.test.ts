import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Расстановка ударений RUAccent: контракт исходников и настроек.
 *
 * Почему контрактом, а не живым запуском: vitest — это Node, а RUAccent живёт в
 * python-окружении приложения (storage/python311) и тянет ~80 МБ моделей с
 * HuggingFace. Все полезные здесь ошибки ловятся и без запуска — они были
 * реальными при подключении:
 *
 *   1. недокачанные модели: RUAccent считает каталог скачанным по его НАЛИЧИЮ,
 *      поэтому обрыв закачки `model.onnx` навсегда ломает расстановку
 *      («Load model from … failed: File doesn't exist») — на прерванной задаче
 *      это и случилось. Значит, обёртка ОБЯЗАНА проверять обязательные файлы и
 *      сносить неполные каталоги, иначе ошибку нельзя вылечить из интерфейса;
 *   2. символы вне «белого списка» RUAccent: `process_all` чистит текст и молча
 *      удаляет многоточие, «№», «°», «/», «%». Озвучка без многоточия теряет
 *      паузу в конце фразы — значит, рискованные символы должны защищаться
 *      через skip_regex;
 *   3. формат ударения: RUAccent ставит «+» ПЕРЕД гласной (именно это ждёт
 *      русская модель F5), а XTTS такие знаки не понимает — их надо снимать;
 *   4. чужие знаки ударения: наш markStress ставит U+0301 ПОСЛЕ гласной, и
 *      перед RUAccent их нужно снять, иначе в слове окажутся две разметки;
 *   5. каталог моделей в storage/tts попадает под суточную TTL-уборку — без
 *      исключения модели удалялись бы каждые сутки.
 */
const req = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..");
const engines = path.join(root, "server", "engines");
const read = (f: string): string => fs.readFileSync(path.join(engines, f), "utf8");

describe("RUAccent: файлы и модель", () => {
  it("обёртка и рабочий процесс лежат рядом с движками", () => {
    expect(fs.existsSync(path.join(engines, "ru_accent.py"))).toBe(true);
    expect(fs.existsSync(path.join(engines, "ruaccent_worker.py"))).toBe(true);
  });

  it("модели качаются в storage/tts/ruaccent, а не в site-packages", () => {
    const src = read("ru_accent.py");
    expect(src).toContain('os.path.join(storage_dir(), "tts", "ruaccent")');
    // Каталог данных берётся из окружения приложения, а не из каталога установки.
    expect(src).toContain("MOONAPP_STORAGE");
    // Путь уходит в RUAccent как workdir — иначе модели легли бы в пакет и
    // удалились бы вместе с окружением.
    expect(src).toContain("workdir=self.root");
  });

  it("прерванная закачка лечится: обязательные файлы проверяются, каталог сносится", () => {
    const src = read("ru_accent.py");
    expect(src).toContain("def broken_parts");
    expect(src).toContain("def repair");
    expect(src).toContain("model.onnx");
    expect(src).toContain("shutil.rmtree");
    // Один повтор после чистки: обрыв закачки по тексту ошибки не опознать.
    expect(src).toMatch(/again = repair\(/);
  });

  it("лёгкий режим не тянет данные движка правил (188 МБ)", () => {
    const src = read("ru_accent.py");
    expect(src).toContain("acc.koziev_paths = []");
    expect(src).toMatch(/if self\.tiny_mode:/);
  });

  it("свои знаки ударения снимаются, рискованные символы защищаются", () => {
    const src = read("ru_accent.py");
    // markStress ставит U+0301 ПОСЛЕ гласной — перед RUAccent их снимаем.
    expect(src).toContain("COMBINING = re.compile");
    expect(src).toContain('COMBINING.sub("", str(text or ""))');
    // Многоточие и прочее без защиты RUAccent просто удалил бы из текста.
    expect(src).toContain("def protect_risky");
    expect(src).toContain("skip_regex=");
    expect(src).toContain("…");
  });
});

describe("RUAccent: рабочий процесс (протокол)", () => {
  it("переводит потоки в UTF-8 до чтения протокола", () => {
    const src = read("ruaccent_worker.py");
    const main = src.slice(src.indexOf("def main():"));
    const call = main.indexOf("force_utf8()");
    const loop = main.indexOf("for line in sys.stdin");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(loop);
  });

  it("понимает load/accent/unload/shutdown и отвечает ready/accented", () => {
    const src = read("ruaccent_worker.py");
    for (const t of [
      'rtype == "load"',
      'rtype == "accent"',
      'rtype == "unload"',
      'rtype == "shutdown"',
    ]) {
      expect(src, t).toContain(t);
    }
    expect(src).toContain('"type": "ready"');
    expect(src).toContain('"type": "accented"');
  });

  it("ошибка RUAccent не завершает процесс и не роняет озвучку", () => {
    const src = read("ruaccent_worker.py");
    // Ошибка отдаётся сообщением, обработка следующей строки продолжается.
    expect(src).toContain("except AccenterError as e:");
    expect(src).toContain('"type": "error"');
    expect(src).toMatch(/ruaccent_not_installed/);
  });
});

describe("RUAccent: движки понимают (или снимают) ударения", () => {
  it("XTTS снимает «+» перед гласной, но не трогает обычные плюсы", () => {
    const src = read("xtts_wrapper.py");
    expect(src).toContain("_PLUS_BEFORE_VOWEL");
    expect(src).toContain("def drop_stress");
    // Плюс считается ударением только перед гласной: «C++» и «2 + 2» — не оно.
    expect(src).toMatch(/\\\+\(\[аеёиоуыэюя/);
  });

  it("F5 отдаёт «+» русской модели и снимает знаки для базовой", () => {
    const src = read("f5_wrapper.py");
    expect(src).toContain("def _stress_plus");
    expect(src).toContain("def _stress_off");
    expect(src).toContain(
      'text = _stress_plus(req["text"]) if self.ruModel else _stress_off(req["text"])',
    );
  });
});

describe("RUAccent: настройки, установщик и уборка", () => {
  it("настройки по умолчанию — лёгкий режим и модель tiny2.1", () => {
    const src = fs.readFileSync(path.join(root, "server", "ts", "settings.ts"), "utf8");
    expect(src).toContain('stressModel: "tiny2.1"');
    expect(src).toContain("stressLite: true");
  });

  it("установщик окружения ставит ruaccent вместе с движком", () => {
    const src = fs.readFileSync(path.join(root, "server", "ts", "pyEnv.ts"), "utf8");
    expect(src).toMatch(/id: "stress", args: \["ruaccent"\]/);
    // Проба окружения знает про модуль: иначе про отсутствие RUAccent узнать негде.
    expect(read("python_env.py")).toContain('"ruaccent"');
  });

  it("каталог моделей исключён из суточной уборки storage/tts", () => {
    // Защита от потери сотен мегабайт моделей: removeOlderThan удаляет всё
    // старше суток, и без исключения следующее задание качало бы их заново.
    // Проверяем собранный server/tts.js — именно он работает в приложении.
    const built = fs.readFileSync(path.join(root, "server", "tts.js"), "utf8");
    expect(built).toContain('keep: ["profiles.json", "presets.json", "ruaccent"]');
  });

  it("словарная ёфикация знает «свекла» (RUAccent её не ёфицирует)", () => {
    process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-ra-nlp-"));
    const nlp = req("../server/ruNlp");
    expect(nlp.yoficate("Свекла на столе")).toBe("Свёкла на столе");
  });
});

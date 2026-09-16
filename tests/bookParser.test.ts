import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/bookParser, переведённого на TS (server/ts/bookParser.ts →
 * server/bookParser.js).
 *
 * Модуль разбирает книги в главы для озвучки, и цена ошибки здесь слышна:
 * неправильная кодировка .txt даёт «коридор» из мойбейка, а невычищенный мусор
 * (сноски, URL, переносы) читается диктором вслух. Тесты фиксируют как рабочие
 * правила (детект кодировки, HTML → текст, умная чистка, нарезка глав), так и
 * известные ограничения — чтобы они не «потерялись» при следующих правках.
 */
const req = createRequire(import.meta.url);

let bp: any;
let tmp: string;

/**
 * iconv-lite не объявлен в зависимостях (приходит транзитивно) и используется
 * только для .txt в cp1251/cp866, с фолбэком на utf8. Поэтому от наличия
 * пакета зависит, будет ли текст читаемым, а не мойбейком.
 */
let hasIconv = false;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-bookparser-"));
  process.env.MOONAPP_STORAGE = tmp;
  bp = req("../server/bookParser");
  try {
    req("iconv-lite");
    hasIconv = true;
  } catch {
    hasIconv = false;
  }
});

describe("server/bookParser — форма модуля и детект кодировки", () => {
  it("require() отдаёт функции напрямую (без { default })", () => {
    expect(bp.default).toBeUndefined();
    for (const fn of ["detectDecode", "htmlToText", "cleanText", "parseBook"]) {
      expect(typeof bp[fn], fn).toBe("function");
    }
  });

  it("UTF-8 с BOM: метка отбрасывается, кодировка utf-8-sig", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Привет", "utf8")]);
    const r = bp.detectDecode(buf);
    expect(r.encoding).toBe("utf-8-sig");
    expect(r.text).toBe("Привет");
  });

  it("чистый ASCII не пытается быть кириллицей", () => {
    const r = bp.detectDecode(Buffer.from("hello world", "ascii"));
    expect(r.encoding).toBe("ascii");
    expect(r.text).toBe("hello world");
  });

  it("UTF-8 без BOM распознаётся по валидным последовательностям", () => {
    const r = bp.detectDecode(Buffer.from("Привет, мир!", "utf8"));
    expect(r.encoding).toBe("utf-8");
    expect(r.text).toBe("Привет, мир!");
  });

  it("cp1251: кодировка определяется, текст читается при наличии iconv", () => {
    // «Привет» в cp1251: буквы лежат в 0xC0–0xFF, а это невалидный UTF-8.
    const buf = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const r = bp.detectDecode(buf);
    expect(r.encoding.startsWith("cp1251")).toBe(true);
    if (hasIconv) expect(r.text).toBe("Привет");
    else expect(r.encoding).toBe("cp1251(fallback-utf8)");
  });
});

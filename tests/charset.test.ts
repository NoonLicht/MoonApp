import { describe, it, expect } from "vitest";
import {
  decodeBytes,
  decodeCp1251,
  decodeEntities,
  encodeCp1251,
  formEncode,
  normCharset,
  pctEncode,
  stripTags,
  toBytes,
} from "../server/charset";

/**
 * Кодировка windows-1251 — фундамент поиска на phpBB-форумах (rutracker.org):
 * страницы приходят в cp1251, и строка поиска должна уходить в cp1251.
 *
 * Главная проверка здесь — сверка нашей таблицы с системным TextDecoder:
 * в таблице легко потерять/переставить символ (так и было потеряно 0x80),
 * поэтому эталон — платформа, а не наши глаза.
 */
describe("charset — windows-1251", () => {
  it("декодирует все 256 байтов так же, как системный TextDecoder", () => {
    const ref = new TextDecoder("windows-1251");
    for (let b = 0; b < 256; b++) {
      const ours = decodeCp1251(Buffer.from([b]));
      const theirs = ref.decode(Buffer.from([b]));
      expect(ours, `байт 0x${b.toString(16)}`).toBe(theirs);
    }
  });

  it("кодирование — точная обратная операция к декодированию (все байты)", () => {
    for (let b = 0; b < 256; b++) {
      const buf = Buffer.from([b]);
      expect([...encodeCp1251(decodeCp1251(buf))], `байт 0x${b.toString(16)}`).toEqual([b]);
    }
  });

  it("кириллица кодируется байтами cp1251, а не UTF-8", () => {
    // «Привет» в cp1251 = CF F0 E8 E2 E5 F2 (в UTF-8 это 12 байт).
    expect([...encodeCp1251("Привет")]).toEqual([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    // «ё» = 0xB8, «№» = 0xB9 — самые частые «ловушки» кодировки.
    expect([...encodeCp1251("ё")]).toEqual([0xb8]);
    expect([...encodeCp1251("№")]).toEqual([0xb9]);
  });

  it("decodeBytes: utf-8 идёт быстрым путём, cp1251 — таблицей", () => {
    expect(decodeBytes(Buffer.from("Привет", "utf8"), "utf-8")).toBe("Привет");
    expect(decodeBytes(encodeCp1251("Привет"), "windows-1251")).toBe("Привет");
    expect(decodeBytes(encodeCp1251("Привет"), "cp1251")).toBe("Привет");
    // Неизвестный ярлык не роняет декодирование.
    expect(decodeBytes(Buffer.from("ok"), "koi8-r")).toBe("ok");
    expect(normCharset("UTF8")).toBe("utf-8");
    expect(normCharset("")).toBe("windows-1251");
  });

  it("toBytes: неизвестная кодировка не портит байты (уходим в UTF-8)", () => {
    expect([...toBytes("ok", "koi8-r")]).toEqual([...Buffer.from("ok", "utf8")]);
  });

  it("pctEncode: пробел → +, кириллица → %XX в cp1251", () => {
    expect(pctEncode("ёж")).toBe("%B8%E6");
    expect(pctEncode("Матрица")).toBe("%CC%E0%F2%F0%E8%F6%E0");
    expect(pctEncode("The Matrix")).toBe("The+Matrix");
    expect(pctEncode("a-b_c.d~e")).toBe("a-b_c.d~e");
    // Значение в UTF-8 (для форумов без cp1251) кодируется иначе — это ожидаемо.
    expect(pctEncode("ё", "utf-8")).toBe("%D1%91");
  });

  it("formEncode: тело POST-формы в кодировке форума", () => {
    expect(formEncode({ nm: "Матрица", start: 0 }, "windows-1251")).toBe(
      "nm=%CC%E0%F2%F0%E8%F6%E0&start=0",
    );
    // undefined/null-поля не попадают в тело (иначе форум получит мусор).
    expect(formEncode({ a: "1", b: undefined, c: null })).toBe("a=1");
  });

  it("decodeEntities и stripTags: числовые сущности и склейка ячеек", () => {
    expect(decodeEntities("&#1055;&#1088;&#1080;&#1074;&#1077;&#1090;")).toBe("Привет");
    expect(decodeEntities("a &amp; b &quot;c&quot; &#x41;")).toBe('a & b "c" A');
    expect(decodeEntities("&nbsp;x")).toBe(" x");
    expect(stripTags("<b>Фильм</b> <span>1.37 GB</span>")).toBe("Фильм 1.37 GB");
    expect(stripTags("<script>var x=1;</script>текст")).toBe("текст");
  });
});

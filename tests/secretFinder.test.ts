import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Поиск секретов в словах OCR (server/ts/secretFinder.ts). */
const req = createRequire(import.meta.url);
let sf: any;
beforeAll(() => {
  sf = req("../server/secretFinder");
});

/** Слова в одну строку: каждое шириной 10 px на символ. */
function line(text: string, y = 0) {
  let x = 0;
  return text.split(" ").map((t) => {
    const w = { text: t, bbox: { x0: x, y0: y, x1: x + t.length * 10, y1: y + 20 } };
    x += t.length * 10 + 8;
    return w;
  });
}

describe("luhn", () => {
  it("принимает валидный номер и отвергает случайный", () => {
    expect(sf.luhn("4111111111111111")).toBe(true);
    expect(sf.luhn("4111111111111112")).toBe(false);
    expect(sf.luhn("123")).toBe(false);
  });
});

describe("findSecrets", () => {
  it("номер карты из четырёх слов даёт одну область на всю группу", () => {
    const r = sf.findSecrets(line("Карта 4111 1111 1111 1111 действует"));
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("card");
    expect(r[0].x0).toBe(58); // «Карта» = 50 px + зазор 8
  });

  it("почта, ключ API и IP", () => {
    const words = [
      ...line("пишите на ivan@example.com", 0),
      ...line("ключ sk-abcdefghijklmnop1234", 40),
      ...line("сервер 192.168.1.10", 80),
    ];
    const kinds = sf.findSecrets(words).map((r: any) => r.kind);
    expect(kinds).toEqual(["email", "api-key", "ip"]);
  });

  it("после метки «пароль:» скрывается только значение", () => {
    const r = sf.findSecrets(line("Пароль: qwerty123"));
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("password");
    expect(r[0].x0).toBe(78); // «Пароль:» = 70 px + зазор 8
  });

  it("обычный текст и случайное число без Луна не трогает", () => {
    expect(sf.findSecrets(line("Сегодня хорошая погода 1234 5678 9012 3456"))).toEqual([]);
    expect(sf.findSecrets([])).toEqual([]);
  });

  it("flattenWords достаёт слова из blocks и из плоского words", () => {
    const w = { text: "a", bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } };
    expect(sf.flattenWords({ words: [w] })).toEqual([w]);
    expect(
      sf.flattenWords({ blocks: [{ paragraphs: [{ lines: [{ words: [w, w] }] }] }] }),
    ).toHaveLength(2);
    expect(sf.flattenWords(null)).toEqual([]);
  });
});

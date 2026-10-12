import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Ветвление диалога (server/ts/chatFork.ts). */
const req = createRequire(import.meta.url);
let cf: any;
beforeAll(() => {
  cf = req("../server/chatFork");
});

describe("messagesUpTo", () => {
  const msgs = [
    { id: 1, role: "user", text: "a" },
    { id: 2, role: "assistant", text: "b" },
    { id: 5, role: "user", text: "c" },
  ];
  it("берёт историю до сообщения включительно", () => {
    expect(cf.messagesUpTo(msgs, 2).map((m: any) => m.id)).toEqual([1, 2]);
    expect(cf.messagesUpTo(msgs, 5).length).toBe(3);
  });
  it("неизвестный id — null", () => {
    expect(cf.messagesUpTo(msgs, 3)).toBeNull();
  });
});

describe("forkTitle", () => {
  it("добавляет метку ветки", () => {
    expect(cf.forkTitle("Тема")).toBe("Тема ⑂");
  });
  it("нумерует повторы и не наращивает суффикс", () => {
    expect(cf.forkTitle("Тема ⑂", ["Тема ⑂"])).toBe("Тема ⑂ 2");
    expect(cf.forkTitle("Тема", ["Тема ⑂", "Тема ⑂ 2"])).toBe("Тема ⑂ 3");
  });
});

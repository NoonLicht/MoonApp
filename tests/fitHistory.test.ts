import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

describe("подрезка истории под окно контекста", () => {
  it("старые сообщения отбрасываются, system и последнее остаются", () => {
    const { fitHistory } = req("../server/llamacpp/fit");
    const long = "я".repeat(4000);
    const msgs = [
      { role: "system", text: "правила" },
      { role: "user", text: long },
      { role: "assistant", text: long },
      { role: "user", text: "новый вопрос" },
    ];
    const out = fitHistory(msgs, 1500);
    expect(out.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
    expect(out[out.length - 1].text).toBe("новый вопрос");
  });

  it("если всё влезает — история не меняется", () => {
    const { fitHistory } = req("../server/llamacpp/fit");
    const msgs = [
      { role: "user", text: "а" },
      { role: "assistant", text: "б" },
      { role: "user", text: "в" },
    ];
    expect(fitHistory(msgs, 5000)).toEqual(msgs);
  });

  it("единственное огромное сообщение не удаляется", () => {
    const { fitHistory } = req("../server/llamacpp/fit");
    const msgs = [{ role: "user", text: "я".repeat(50000) }];
    expect(fitHistory(msgs, 100)).toHaveLength(1);
  });
});

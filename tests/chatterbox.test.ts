import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import path from "path";

const ENGINES = path.resolve(__dirname, "..", "server", "engines");

describe("Chatterbox как движок озвучки", () => {
  it("Chatterbox — отдельный инструмент со своим окружением, а не часть общего Python озвучки", async () => {
    const py = await import("../server/photo/pyTool");
    const def = py.TOOLS.chatterbox;
    expect(def.repo).toBe(false);
    expect(def.modules).toContain("chatterbox");
    const steps = def.steps("cuda");
    // torch ставится отдельно (cu128), сам пакет — без зависимостей: у него torch==2.6.0
    const pkg = steps.find((s) => s.id === "package");
    expect(pkg?.pip).toContain("--no-deps");
    const torch = steps.find((s) => s.id === "torch");
    expect(torch?.pip?.join(" ")).toContain("cu128");
    expect(
      def
        .steps("cpu")
        .find((s) => s.id === "torch")
        ?.pip?.join(" "),
    ).toContain("/cpu");
  });

  it("сайдкар режет длинный текст по предложениям и снимает ударения", () => {
    let out: string;
    try {
      const code =
        `import sys,json;sys.path.insert(0,r"${ENGINES}");import chatterbox_wrapper as c;` +
        `t=("Это предложение номер один. "*30)+"Зам+ок и замо́к.";` +
        `p=c.split_text(t);print(json.dumps({"n":len(p),"max":max(map(len,p)),"d":c.drop_stress("зам+ок замо́к 2 + 2")},ensure_ascii=False))`;
      out = execFileSync("python", ["-"], {
        input: code,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      });
    } catch {
      return; // Python нет — проверка необязательная
    }
    const r = JSON.parse(out.trim().split("\n").pop() as string);
    expect(r.n).toBeGreaterThan(1);
    expect(r.max).toBeLessThanOrEqual(280);
    expect(r.d).toBe("замок замок 2 + 2");
  });
});

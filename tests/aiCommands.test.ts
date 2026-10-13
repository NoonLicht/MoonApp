// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import {
  aiCommandExtension,
  parseCommand,
  type AiCommandHooks,
} from "@/pages/myspace/parts/aiCommands";

const press = (v: EditorView, key: string): boolean =>
  runScopeHandlers(v, new KeyboardEvent("keydown", { key }), "editor");

function make(doc: string, hooks: AiCommandHooks): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: aiCommandExtension(() => hooks),
    }),
    parent: document.body,
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("команды ИИ в заметке", () => {
  it("разбор строки: команда, синоним, свободный запрос", () => {
    expect(parseCommand("...факт про луну")).toMatchObject({ command: "fact", args: "про луну" });
    expect(parseCommand("…переведи en")).toMatchObject({ command: "translate", args: "en" });
    expect(parseCommand("...оформи")).toMatchObject({ command: "format", args: "" });
    expect(parseCommand("...напиши стих про осень")).toMatchObject({
      command: "ask",
      args: "напиши стих про осень",
    });
    expect(parseCommand("...")).toBeNull();
    expect(parseCommand("обычный текст")).toBeNull();
  });

  it("порождающая команда заменяет строку результатом", async () => {
    let got: { command: string; content: string } | null = null;
    const v = make("Про космос\n...факт про луну", {
      run: async (r) => {
        got = r;
        return { mode: "insert", target: "note", text: "Луна удаляется от Земли." };
      },
      onError: () => {},
    });
    expect(press(v, "Enter")).toBe(true);
    expect(v.state.doc.toString()).toMatch(/⏳/);
    await tick();
    expect(v.state.doc.toString()).toBe("Про космос\nЛуна удаляется от Земли.");
    expect(got).toMatchObject({ command: "fact", content: "Про космос" });
    v.destroy();
  });

  it("преобразующая команда заменяет заметку; ошибка возвращает строку команды", async () => {
    const ok = make("сырой текст\n...формат", {
      run: async () => ({ mode: "replace", target: "note", text: "# Чистый текст" }),
      onError: () => {},
    });
    press(ok, "Enter");
    await tick();
    expect(ok.state.doc.toString()).toBe("# Чистый текст");
    ok.destroy();

    let err = "";
    const bad = make("текст\n...кратко", {
      run: async () => {
        throw new Error("llamacpp_model_missing");
      },
      onError: (m) => (err = m),
    });
    press(bad, "Enter");
    await tick();
    expect(bad.state.doc.toString()).toBe("текст\n...кратко");
    expect(err).toBe("llamacpp_model_missing");
    bad.destroy();
  });

  it("обычный Enter на непустой строке не перехватывается", () => {
    const v = make("просто строка", {
      run: async () => ({ mode: "insert", target: "note", text: "" }),
      onError: () => {},
    });
    expect(press(v, "Enter")).toBe(false);
    v.destroy();
  });
});

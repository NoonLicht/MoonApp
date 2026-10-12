import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Меню Проводника Windows (server/ts/contextMenu.ts). */
const req = createRequire(import.meta.url);
let cm: any;
beforeAll(() => {
  cm = req("../server/contextMenu");
});

describe("regEntries", () => {
  const labels = { note: "В заметки", folder: "Снимок" };
  it("по записи на расширение заметок и на папки, только HKCU", () => {
    const e = cm.regEntries("C:\\Apps\\MoonApp\\MoonApp.exe", labels);
    expect(e.length).toBe(4);
    expect(e.every((x: any) => x.key.startsWith("HKCU\\"))).toBe(true);
    expect(e.filter((x: any) => x.key.includes("\\Directory\\")).length).toBe(1);
  });

  it("команда содержит путь в кавычках, флаг действия и %1", () => {
    const e = cm.regEntries("C:\\Apps\\Moon App\\MoonApp.exe", labels);
    const note = e.find((x: any) => x.key.includes(".md"));
    expect(note.command).toBe('"C:\\Apps\\Moon App\\MoonApp.exe" --moonapp-action=add-note "%1"');
    const dir = e.find((x: any) => x.key.includes("Directory"));
    expect(dir.command).toContain("--moonapp-action=folder-snapshot");
  });

  it("кавычки в пути не ломают команду", () => {
    const e = cm.regEntries('C:\\a"b\\x.exe', labels);
    expect(e[0].command.startsWith('"C:\\ab\\x.exe"')).toBe(true);
  });
});

describe("parseArgv", () => {
  it("находит действие и путь", () => {
    expect(cm.parseArgv(["app.exe", "--moonapp-action=add-note", "C:\\a.md"])).toEqual({
      action: "add-note",
      target: "C:\\a.md",
    });
  });
  it("ссылка moonapp://clip распознаётся как веб-клип", () => {
    const u = "moonapp://clip?title=t&url=https%3A%2F%2Fa.b";
    expect(cm.parseArgv(["app.exe", u])).toEqual({ action: "web-clip", target: u });
    expect(cm.parseArgv(["app.exe", "moonapp://other?x=1"])).toBeNull();
  });
  it("неизвестное действие, нет пути, нет флага — null", () => {
    expect(cm.parseArgv(["app.exe", "--moonapp-action=format-c", "C:\\"])).toBeNull();
    expect(cm.parseArgv(["app.exe", "--moonapp-action=add-note"])).toBeNull();
    expect(cm.parseArgv(["app.exe"])).toBeNull();
  });
});

describe("install в dev-сборке", () => {
  it("отказывает для electron.exe", async () => {
    if (process.platform !== "win32") return;
    await expect(cm.install("C:\\x\\electron.exe", { note: "a", folder: "b" })).rejects.toThrow("dev_build");
  });
});

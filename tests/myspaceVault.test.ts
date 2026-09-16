import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * Контракт server/myspace-vault, переведённого на TS (server/ts/myspace-vault.ts
 * → server/myspace-vault.js).
 *
 * Vault — это файловое хранилище MySpace: заметки .md в storage/vault/notes и
 * canvas .holst в storage/vault/holts. Здесь проверяем то, на чём держатся роуты
 * (server/routes/myspace.js): форму require() без { default }, контейнмент путей
 * (path traversal), разбор frontmatter/тегов/вики-ссылок, дерево и поиск, а также
 * санитизацию имён canvas — из неё следует, что fs.unlinkSync там безопасен.
 */
const req = createRequire(import.meta.url);

let storage: string;
let vault: any;
let fsUtil: any;

const notesDir = (): string => path.join(storage, "vault", "notes");
const holtsDir = (): string => path.join(storage, "vault", "holts");

/** Чистит дерево между тестами: удаляем через fsUtil.removePath (кириллица!). */
function resetTree(): void {
  for (const dir of [notesDir(), holtsDir()]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      continue;
    }
    for (const entry of fs.readdirSync(dir)) fsUtil.removePath(path.join(dir, entry));
  }
}

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pa-vault-"));
  process.env.MOONAPP_STORAGE = storage;
});

beforeEach(() => {
  vault = req("../server/myspace-vault");
  fsUtil = req("../server/fsUtil");
  resetTree();
});

describe("server/myspace-vault — форма модуля", () => {
  it("require() отдаёт функции напрямую (без { default }) и те же ключи, что в .js", () => {
    expect(vault.default).toBeUndefined();
    expect(Object.keys(vault).sort()).toEqual(
      [
        "buildTree",
        "createFolder",
        "deleteFile",
        "deleteHolst",
        "getAllTags",
        "getBacklinks",
        "getOutline",
        "HOLST_DIR",
        "listHolsts",
        "NOTEBOOK_DIR",
        "readFile",
        "readHolst",
        "renameFile",
        "searchFiles",
        "VAULT_DIR",
        "writeFile",
        "writeHolst",
      ].sort(),
    );
  });

  it("каталоги указывают внутрь storage (vault/notes, vault/holts)", () => {
    expect(vault.NOTEBOOK_DIR).toBe(notesDir());
    expect(vault.HOLST_DIR).toBe(holtsDir());
  });
});
describe("server/myspace-vault — заметки (.md)", () => {
  it("writeFile пишет frontmatter, readFile отделяет тело и собирает теги/вики-ссылки", () => {
    const r = vault.writeFile("Папка/Тема.md", "текст #матан см. [[Другая]]", {
      title: "Тема",
      id: 5,
    });
    expect(r).toEqual({ path: "Папка/Тема.md", ok: true });

    const raw = fs.readFileSync(path.join(notesDir(), "Папка", "Тема.md"), "utf8");
    expect(raw).toContain('title: "Тема"');
    expect(raw).toContain('id: "5"');

    const file = vault.readFile("Папка/Тема.md");
    expect(file.name).toBe("Тема.md");
    expect(file.ext).toBe(".md");
    expect(file.frontmatter).toEqual({ title: "Тема", id: "5" });
    expect(file.content).toBe("текст #матан см. [[Другая]]");
    expect(file.tags).toEqual(["#матан"]);
    expect(file.wikiLinks).toEqual(["Другая"]);
  });

  it("writeFile без frontmatter не добавляет блок ---", () => {
    vault.writeFile("Простая.md", "тело");
    expect(fs.readFileSync(path.join(notesDir(), "Простая.md"), "utf8")).toBe("тело");
  });

  it("readFile несуществующего файла отдаёт null", () => {
    expect(vault.readFile("нет-такого.md")).toBeNull();
  });

  it("путь с .. отклоняется, файл за пределами vault не создаётся", () => {
    expect(vault.writeFile("../снаружи.md", "x")).toEqual({
      ok: false,
      error: "forbidden path",
    });
    expect(fs.existsSync(path.join(storage, "vault", "снаружи.md"))).toBe(false);
    expect(vault.readFile("../снаружи.md")).toBeNull();
    expect(vault.deleteFile("../../data.json")).toEqual({ ok: false, error: "forbidden path" });
  });

  it("deleteFile убирает .md с русским именем, а на отсутствующем отдаёт not found", () => {
    vault.writeFile("Удаляемая заметка.md", "текст");
    expect(fs.existsSync(path.join(notesDir(), "Удаляемая заметка.md"))).toBe(true);
    expect(vault.deleteFile("Удаляемая заметка.md")).toEqual({ ok: true });
    expect(fs.existsSync(path.join(notesDir(), "Удаляемая заметка.md"))).toBe(false);
    expect(vault.deleteFile("Удаляемая заметка.md")).toEqual({ ok: false, error: "not found" });
  });

  it("renameFile переименовывает (создавая папку) и возвращает новый путь", () => {
    vault.writeFile("Старое.md", "текст");
    expect(vault.renameFile("Старое.md", "Папка/Новое.md")).toEqual({
      ok: true,
      newPath: "Папка/Новое.md",
    });
    expect(vault.readFile("Папка/Новое.md").content).toBe("текст");
    expect(vault.readFile("Старое.md")).toBeNull();
  });

  it("createFolder создаёт вложенную папку, а buildTree отдаёт note/folder", () => {
    expect(vault.createFolder("Курс/Лекции")).toEqual({ ok: true, path: "Курс/Лекции" });
    vault.writeFile("Курс/Лекции/Тема.md", "текст");

    const tree = vault.buildTree();
    expect(tree.map((n: any) => [n.name, n.type])).toEqual([["Курс", "folder"]]);
    const kurs = tree[0];
    expect(kurs.children.map((n: any) => [n.name, n.type])).toEqual([["Лекции", "folder"]]);
    expect(kurs.children[0].children[0]).toMatchObject({
      name: "Тема.md",
      path: "Курс/Лекции/Тема.md",
      type: "note",
      ext: ".md",
    });
  });
});
describe("server/myspace-vault — поиск, теги, ссылки, оглавление", () => {
  it("searchFiles ищет без учёта регистра и отдаёт сниппет с позицией", () => {
    vault.writeFile("А.md", "Введение. Алгоритм сортировки описан ниже.");
    vault.writeFile("Б.md", "здесь ничего нет");

    const hits = vault.searchFiles("АЛГОРИТМ");
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe("А.md");
    expect(hits[0].snippet.toLowerCase()).toContain("алгоритм");
    expect(hits[0].matchStart).toBe(
      "Введение. Алгоритм сортировки описан ниже.".indexOf("Алгоритм"),
    );

    expect(vault.searchFiles("")).toEqual([]);
    expect(vault.searchFiles("   ")).toEqual([]);
  });

  it("getAllTags считает теги по всем заметкам и сортирует по частоте", () => {
    vault.writeFile("А.md", "раз #матан");
    vault.writeFile("Б.md", "два #матан #физика");
    expect(vault.getAllTags()).toEqual([
      { tag: "#матан", count: 2 },
      { tag: "#физика", count: 1 },
    ]);
  });

  it("getBacklinks различает [[ссылку]] и простое упоминание имени", () => {
    vault.writeFile("Цель.md", "тело");
    vault.writeFile("Ссылка.md", "см. [[Цель]]");
    vault.writeFile("Упоминание.md", "тут сказано про цель без ссылки");

    const links = vault.getBacklinks("Цель.md");
    expect(links.map((b: any) => [b.path, b.type]).sort()).toEqual([
      ["Ссылка.md", "linked"],
      ["Упоминание.md", "unlinked"],
    ]);
    expect(links.find((b: any) => b.type === "linked").name).toBe("Ссылка");
  });

  it("getOutline отдаёт заголовки с уровнем и номером строки", () => {
    expect(vault.getOutline("# H1\nтекст\n### H3")).toEqual([
      { level: 1, text: "H1", line: 1 },
      { level: 3, text: "H3", line: 3 },
    ]);
  });
});
describe("server/myspace-vault — canvas (.holst)", () => {
  it("writeHolst → listHolsts → readHolst → deleteHolst", () => {
    const w = vault.writeHolst("holst-A1", { shapes: [{ id: "s1" }] });
    expect(w).toEqual({ ok: true, name: "holst-A1" });
    expect(fs.existsSync(path.join(holtsDir(), "holst-A1.holst"))).toBe(true);

    const list = vault.listHolsts();
    expect(list.map((h: any) => h.path)).toEqual(["holst-A1.holst"]);
    expect(list[0].name).toBe("holst-A1");
    expect(typeof list[0].updatedAt).toBe("string");
    expect(list[0].thumbnail).toBeNull();

    const read = vault.readHolst("holst-A1");
    expect(read.data).toEqual({ meta: read.data.meta, shapes: [{ id: "s1" }] });
    expect(read.data.meta.name).toBe("holst-A1");

    expect(vault.deleteHolst("holst-A1")).toEqual({ ok: true });
    expect(vault.listHolsts()).toEqual([]);
    expect(vault.deleteHolst("holst-A1")).toEqual({ ok: false, error: "Not found" });
    expect(vault.readHolst("holst-A1")).toBeNull();
  });

  it("имя canvas санитизируется до ASCII: кириллица и слэши заменяются на _", () => {
    const w = vault.writeHolst("тест/злой", {});
    expect(w.name).toBe("_".repeat("тест/злой".length));
    // Файл лежит ровно в holts — «/» не создаёт вложенность.
    expect(fs.readdirSync(holtsDir())).toEqual([`${w.name}.holst`]);
  });

  it("битый JSON: listHolsts пропускает файл, readHolst отдаёт error", () => {
    // Имя тоже санитизируется: «битый» (5 символов) → «_____».
    fs.writeFileSync(path.join(holtsDir(), "_____.holst"), "{ это не json", "utf8");
    expect(vault.listHolsts()).toEqual([]);
    expect(vault.readHolst("битый")).toEqual({
      name: "_____",
      data: null,
      error: "Invalid JSON",
    });
  });

  it("meta из data перекрывает служебную meta (updatedAt теряется)", () => {
    // Тот же порядок сборки, что в .js: { meta: {updatedAt, name}, ...data }.
    // Если клиент присылает своё meta (например, с thumbnail), updatedAt сервера
    // затирается, и поле updatedAt в списке становится null.
    vault.writeHolst("holst-B", { meta: { thumbnail: "data:image/png;base64,AAA" } });
    const item = vault.listHolsts().find((h: any) => h.name === "holst-B");
    expect(item.updatedAt).toBeNull();
    expect(item.thumbnail).toBe("data:image/png;base64,AAA");
  });
});

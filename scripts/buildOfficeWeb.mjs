#!/usr/bin/env node
/**
 * Собирает веб-версии WordCraft, GridCraft, DeckCraft и PdfCraft (wasm) и кладёт их в public/office/<имя>, откуда Vite
 * переносит их в dist. Сборки (~40 МБ) в git не хранятся. К исходникам применяется патч
 * native/office-web/<имя>-web.patch: мост со страницей MoonApp (см. native/office-web/README.md).
 *
 * Нужны rustup (цель wasm32-unknown-unknown) и trunk (`cargo install trunk --locked`).
 *
 *   node scripts/buildOfficeWeb.mjs word|sheet|deck|pdf
 *
 * Исходники клонируются в короткую папку (Windows MAX_PATH) на ревизию, с которой собрано ядро;
 * при каждом запуске папка возвращается к этой ревизии и патч накладывается заново.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPS = {
  word: {
    repo: "https://github.com/storytold/wordcraft.git",
    rev: "eae242176108d328c5dd81fbc10370c51ab90706", // та же, что в native/wordcore/Cargo.toml
    dir: "apps/wordcraft-web",
    patch: "wordcraft-web.patch",
  },
  sheet: {
    repo: "https://github.com/storytold/gridcraft.git",
    rev: "8ffff19dda63d85348d4b4ec552b8857b82109b1", // та же, что в native/gridcore/Cargo.toml
    dir: "apps/gridcraft-web",
    patch: "gridcraft-web.patch",
  },
  deck: {
    repo: "https://github.com/storytold/deckcraft.git",
    rev: "354087ecd56305842582e9e410cf24d595849789", // ревизия на 2026-10-22; ядра для слайдов в приложении пока нет
    dir: "apps/deckcraft-web",
    patch: "deckcraft-web.patch",
    // epaint (раскладка текста egui) копируется рядом с исходниками и правится: хук перевода интерфейса
    vendor: { crate: "epaint", patch: "deckcraft-epaint.patch" },
  },
  pdf: {
    repo: "https://github.com/storytold/pdfcraft.git",
    rev: "8555d6f159a7b2d7d420185642b8901719b457a6", // ревизия на 2026-10-22; русский интерфейс уже в ядре (ui-egui/src/i18n/ru.tsv)
    dir: "apps/pdfcraft-web",
    patch: "pdfcraft-web.patch",
  },
};

const name = process.argv[2];
const app = APPS[name];
if (!app?.rev) {
  console.error(`Использование: node scripts/buildOfficeWeb.mjs <${Object.keys(APPS).filter((k) => APPS[k].rev).join("|")}>`);
  process.exit(1);
}
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

/** Копия крейта из реестра cargo в `<src>-<крейт>` (корневой Cargo.toml патча берёт её через [patch.crates-io]) + правка. */
function vendorCrate({ crate, patch }) {
  const lock = fs.readFileSync(path.join(src, "Cargo.lock"), "utf8");
  const version = new RegExp(`name = "${crate}"\r?\nversion = "([^"]+)"`).exec(lock)?.[1];
  if (!version) throw new Error(`${crate} не найден в Cargo.lock`);
  const registry = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo"), "registry", "src");
  const find = () => fs.existsSync(registry) && fs.readdirSync(registry).map((d) => path.join(registry, d, `${crate}-${version}`)).find((d) => fs.existsSync(d));
  if (!find()) run("cargo", ["fetch"], src);
  const from = find();
  if (!from) throw new Error(`${crate}-${version} нет в ${registry}`);
  const dest = `${src}-${crate}`;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(from, dest, { recursive: true });
  run("git", ["apply", "--ignore-whitespace", path.join(root, "native", "office-web", patch)], dest);
}

const src = path.join(process.platform === "win32" ? "C:\\" : os.tmpdir(), "wcb", name);
if (!fs.existsSync(path.join(src, ".git"))) {
  fs.mkdirSync(path.dirname(src), { recursive: true });
  run("git", ["clone", "--quiet", app.repo, src], root);
}
run("git", ["checkout", "--quiet", "--force", app.rev], src);
run("git", ["clean", "-fdq"], src); // весь клон: патч может добавлять файлы и вне папки приложения (ignored: target, dist — остаются)
run("git", ["apply", "--ignore-whitespace", path.join(root, "native", "office-web", app.patch)], src);
if (app.vendor) vendorCrate(app.vendor);

run("rustup", ["target", "add", "wasm32-unknown-unknown"], root);
run("trunk", ["build", "--release"], path.join(src, app.dir));

const out = path.join(root, "public", "office", name);
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(src, "dist", "web"), out, { recursive: true });
fs.rmSync(path.join(out, ".trunk-lock"), { force: true });
console.log(`Готово: ${path.relative(root, out)}`);

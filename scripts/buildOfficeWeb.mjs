#!/usr/bin/env node
/**
 * Собирает веб-версии WordCraft, GridCraft, DeckCraft, PdfCraft, PhotoCraft, SoundCraft, FigCraft, EffectCraft, FilmCraft, LightCraft и CadCraft (wasm) и кладёт их в public/office/<имя>, откуда Vite
 * переносит их в dist. Сборки (~40 МБ) в git не хранятся. К исходникам применяется патч
 * native/office-web/<имя>-web.patch: мост со страницей MoonApp (см. native/office-web/README.md).
 *
 * Нужны rustup (цель wasm32-unknown-unknown) и trunk (`cargo install trunk --locked`).
 *
 *   node scripts/buildOfficeWeb.mjs word|sheet|deck|pdf|photo|sound|fig|effect|film|light|cad
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
  photo: {
    repo: "https://github.com/storytold/photocraft.git",
    rev: "ce2a1e337a2fa68bf56c793a70c09477deccf63e", // ревизия на 2026-10-22; русский интерфейс уже в ядре (ui-egui/src/i18n/ru.tsv)
    dir: "apps/photocraft-web",
    patch: "photocraft-web.patch",
  },
  // Без моста: страница показывает сборку как есть (src/components/office/AppFrame.tsx). Язык — `?lang=` (патч, если он есть).
  sound: {
    repo: "https://github.com/storytold/soundcraft.git",
    rev: "e85a4801e9029c9a1f5ce536b11be65aea832ed8", // ревизия на 2026-10-22; интерфейс только на английском
    dir: "apps/soundcraft-web",
  },
  cad: {
    repo: "https://github.com/storytold/cadcraft.git",
    rev: "8f988f630dd63ce5d9c997f5ef28a09dd1bdfcde", // ревизия на 2026-10-22; русский интерфейс уже в ядре (i18n/ru.tsv)
    dir: "apps/cadcraft-web",
  },
  effect: {
    repo: "https://github.com/storytold/effectcraft.git",
    rev: "15b8a916c528e73d48f7a9cb4ff58276c7a2d3dd", // ревизия на 2026-10-22; wasm ~58 МБ
    xtask: "target/web/dist", // cargo xtask web (нужен wasm-bindgen-cli той же версии, что в Cargo.lock)
  },
  film: {
    repo: "https://github.com/storytold/filmcraft.git",
    rev: "74242b51d675514da12d9bbf6b331ef2e6399211", // ревизия на 2026-10-22
    xtask: "target/web/dist",
  },
  light: {
    repo: "https://github.com/storytold/lightcraft.git",
    rev: "479a05a0be4756be460859c4d42b4fbb7a60e99d", // ревизия на 2026-10-22
    xtask: "target/web-site",
    // Сборка ждёт китайский шрифт `lightcraft_zh_hans.otf` (его кладёт CRAFT_FONTS_DIR); без файла сервер отдал бы страницу вместо шрифта и приложение остановилось бы. Подойдёт любой корректный шрифт: берём Inter (есть кириллица).
    extra: [["assets/fonts/Inter-Regular.ttf", "lightcraft_zh_hans.otf"]],
  },
  fig: {
    repo: "https://github.com/storytold/figcraft.git",
    rev: "80f916326fb94f3a88cb24e64f396f564a0ebc06", // ревизия на 2026-10-22; русский интерфейс уже в ядре (locales/ru.toml)
    dir: "apps/figcraft-web",
    patch: "figcraft-web.patch",
  },
};

/** Сборки с мостом `wc` язык получают от своего патча; остальные — подмена `navigator.language(s)` по `?lang=` в index.html. */
const APP_BRIDGE = new Set(["word", "sheet", "deck", "pdf", "photo"]);
function injectLanguage(file) {
  const shim =
    "<script>(function(){var m=/[?&]lang=([\w-]+)/.exec(location.search);if(!m)return;var l=m[1];" +
    "try{Object.defineProperty(navigator,'language',{get:function(){return l}});" +
    "Object.defineProperty(navigator,'languages',{get:function(){return [l]}})}catch(e){}})();</script>";
  const html = fs.readFileSync(file, "utf8");
  if (!html.includes("<head>") || html.includes("navigator,'language'")) return;
  fs.writeFileSync(file, html.replace("<head>", `<head>${shim}`));
}

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
if (app.patch) run("git", ["apply", "--ignore-whitespace", path.join(root, "native", "office-web", app.patch)], src);
if (app.vendor) vendorCrate(app.vendor);

run("rustup", ["target", "add", "wasm32-unknown-unknown"], root);
if (app.xtask) run("cargo", ["xtask", "web"], src);
else run("trunk", ["build", "--release"], path.join(src, app.dir));

const out = path.join(root, "public", "office", name);
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(src, app.xtask ?? path.join("dist", "web")), out, { recursive: true });
fs.rmSync(path.join(out, ".trunk-lock"), { force: true });
// Сжатые копии (.br, .gz) не нужны: статику отдаёт наш сервер, а копия index.html устарела бы после правки.
for (const f of fs.readdirSync(out)) if (/\.(br|gz)$/.test(f)) fs.rmSync(path.join(out, f));
for (const [from, to] of app.extra ?? []) fs.cpSync(path.join(src, from), path.join(out, to));
if (!APP_BRIDGE.has(name)) injectLanguage(path.join(out, "index.html"));
console.log(`Готово: ${path.relative(root, out)}`);

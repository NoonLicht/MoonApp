#!/usr/bin/env node
/**
 * Собирает веб-версии WordCraft и GridCraft (wasm) и кладёт их в public/office/<имя>, откуда Vite
 * переносит их в dist. Сборки (~40 МБ) в git не хранятся. К исходникам применяется патч
 * native/office-web/<имя>-web.patch: мост со страницей MoonApp (см. native/office-web/README.md).
 *
 * Нужны rustup (цель wasm32-unknown-unknown) и trunk (`cargo install trunk --locked`).
 *
 *   node scripts/buildOfficeWeb.mjs word|sheet
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
    rev: "", // заполняется вместе с патчем GridCraft (ревизия из native/gridcore/Cargo.toml)
    dir: "apps/gridcraft-web",
    patch: "gridcraft-web.patch",
  },
};

const name = process.argv[2];
const app = APPS[name];
if (!app?.rev) {
  console.error(`Использование: node scripts/buildOfficeWeb.mjs <${Object.keys(APPS).filter((k) => APPS[k].rev).join("|")}>`);
  process.exit(1);
}
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

const src = path.join(process.platform === "win32" ? "C:\\" : os.tmpdir(), "wcb", name);
if (!fs.existsSync(path.join(src, ".git"))) {
  fs.mkdirSync(path.dirname(src), { recursive: true });
  run("git", ["clone", "--quiet", app.repo, src], root);
}
run("git", ["checkout", "--quiet", "--force", app.rev], src);
run("git", ["clean", "-fdq", app.dir], src);
run("git", ["apply", path.join(root, "native", "office-web", app.patch)], src);

run("rustup", ["target", "add", "wasm32-unknown-unknown"], root);
run("trunk", ["build", "--release"], path.join(src, app.dir));

const out = path.join(root, "public", "office", name);
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(src, "dist", "web"), out, { recursive: true });
fs.rmSync(path.join(out, ".trunk-lock"), { force: true });
console.log(`Готово: ${path.relative(root, out)}`);

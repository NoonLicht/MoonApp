#!/usr/bin/env node
/**
 * Собирает веб-версию WordCraft (wasm) и кладёт её в public/office/word, откуда Vite переносит её в dist.
 * Сборка ~40 МБ в git не хранится. Нужны rustup (цель wasm32-unknown-unknown) и trunk (`cargo install trunk --locked`).
 *
 *   node scripts/buildOfficeWeb.mjs word [путь-к-исходникам-WordCraft]
 *
 * Без пути исходники клонируются в короткую папку (Windows MAX_PATH) на ревизию, с которой собрано ядро.
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
  },
};

const name = process.argv[2];
const app = APPS[name];
if (!app) {
  console.error(`Использование: node scripts/buildOfficeWeb.mjs <${Object.keys(APPS).join("|")}> [исходники]`);
  process.exit(1);
}
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

let src = process.argv[3];
if (!src) {
  src = path.join(process.platform === "win32" ? "C:\\" : os.tmpdir(), "wcb", name);
  if (!fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(src), { recursive: true });
    run("git", ["clone", "--quiet", app.repo, src], root);
  }
  run("git", ["checkout", "--quiet", app.rev], src);
}

run("rustup", ["target", "add", "wasm32-unknown-unknown"], root);
run("trunk", ["build", "--release"], path.join(src, app.dir));

const out = path.join(root, "public", "office", name);
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(src, "dist", "web"), out, { recursive: true });
fs.rmSync(path.join(out, ".trunk-lock"), { force: true });
console.log(`Готово: ${path.relative(root, out)}`);

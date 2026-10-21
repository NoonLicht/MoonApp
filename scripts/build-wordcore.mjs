/**
 * Сборка ядра текстового редактора (native/wordcore, на WordCraft): `npm run build:wordcore`.
 * Нужен Rust 1.95+ (https://rustup.rs). Результат — native/wordcore/target/release/wordcore(.exe),
 * сервер находит его сам; можно положить копию в storage/office/ или указать MOONAPP_WORDCORE.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "native", "wordcore", "Cargo.toml");
const exe = process.platform === "win32" ? "wordcore.exe" : "wordcore";
const cargo = spawnSync("cargo", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
});
if (cargo.status !== 0) {
    console.error("cargo не найден: установите Rust (https://rustup.rs) и повторите.");
    process.exit(1);
}
const r = spawnSync("cargo", ["build", "--release", "--manifest-path", manifest], {
    stdio: "inherit",
    shell: process.platform === "win32",
});
if (r.status !== 0)
    process.exit(r.status ?? 1);
const out = path.join(root, "native", "wordcore", "target", "release", exe);
console.log(fs.existsSync(out) ? `Готово: ${out}` : "Сборка завершилась, но бинарник не найден.");

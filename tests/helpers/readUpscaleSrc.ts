import fs from "fs";
import path from "path";

/**
 * Исходник движка апскейла раньше был одним файлом server/ts/upscale.ts —
 * часть тестов сверяет его текст (сигнатуры функций, ключевые строки). После
 * декомпозиции на подмодули (server/ts/upscale/*.ts) движок остаётся тем же
 * поведением, но текст расползся по файлам — читаем и склеиваем их все, чтобы
 * такие текстовые проверки продолжали работать независимо от того, в каком
 * именно подмодуле теперь живёт нужный фрагмент.
 */
export function readUpscaleSrc(root: string): string {
  const facade = fs.readFileSync(path.join(root, "server", "ts", "upscale.ts"), "utf8");
  const dir = path.join(root, "server", "ts", "upscale");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  const parts = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
  return [facade, ...parts].join("\n");
}

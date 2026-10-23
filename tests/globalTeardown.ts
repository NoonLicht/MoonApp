import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Тесты создают временные хранилища `%TEMP%\moonapp-*` (mkdtemp) и сами их не удаляют;
 * часть из них — гигабайты. После прогона удаляем всё, что появилось за время запуска.
 * Старые папки (созданные до запуска) не трогаем.
 */
let startedAt = 0;

export function setup(): void {
  startedAt = Date.now();
}

export function teardown(): void {
  const tmp = os.tmpdir();
  let names: string[];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("moonapp-")) continue;
    const p = path.join(tmp, name);
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory() || st.birthtimeMs < startedAt - 1000) continue;
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* занято другим процессом — пропускаем */
    }
  }
}

/**
 * Профилирование памяти сервера на длинной сессии.
 *
 * Поднимает `server/index.js` отдельным процессом (временный storage, открытый dev-режим),
 * гоняет по лёгким GET-маршрутам и раз в SAMPLE_SEC замеряет RSS. В конце печатает
 * таблицу и вердикт «похоже на утечку» (устойчивый рост выше порога МБ/час).
 *
 *   node scripts/memProfile.js [минуты=10] [порог МБ/час=30]
 *
 * Порт API фиксирован (4000): закройте приложение перед запуском.
 */
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { analyze, type MemSample } from "./memStats";

const ROOT = path.resolve(__dirname, "..");
const PORT = 4000;
const SAMPLE_SEC = 5;
const ROUTES = ["/api/health", "/api/settings", "/api/monitor", "/api/tasks", "/api/problems"];

function rssMb(pid: number): number {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
    { encoding: "utf8" },
  );
  return Number(out.trim()) / 1024 / 1024;
}

async function waitHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch {
      /* сервер ещё поднимается */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("сервер не поднялся за 30 секунд (порт 4000 занят приложением?)");
}

async function main(): Promise<void> {
  const minutes = Number(process.argv[2]) || 10;
  const threshold = Number(process.argv[3]) || 30;
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-mem-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    env: { ...process.env, MOONAPP_STORAGE: storage, MOONAPP_INSECURE_DEV: "1" },
    stdio: "ignore",
  });
  const samples: MemSample[] = [];
  try {
    await waitHealth();
    const t0 = Date.now();
    while (Date.now() - t0 < minutes * 60_000) {
      for (const r of ROUTES) {
        try {
          await fetch(`http://127.0.0.1:${PORT}${r}`);
        } catch {
          /* ошибка запроса не мешает замеру */
        }
      }
      samples.push({ t: (Date.now() - t0) / 1000, rssMb: rssMb(child.pid as number) });
      await new Promise((r) => setTimeout(r, SAMPLE_SEC * 1000));
    }
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 1500)); // дать процессу отпустить файлы БД
    try {
      fs.rmSync(storage, { recursive: true, force: true });
    } catch {
      /* временный каталог уберёт ОС; на результат замера это не влияет */
    }
  }
  const v = analyze(samples, { thresholdMbPerHour: threshold });
  console.log(
    `Замеров: ${samples.length}, старт ${v.startMb.toFixed(0)} МБ, конец ${v.endMb.toFixed(0)} МБ, пик ${v.peakMb.toFixed(0)} МБ`,
  );
  console.log(`Тренд после прогрева: ${v.slopeMbPerHour} МБ/час (порог ${threshold})`);
  console.log(v.leaking ? "ВЕРДИКТ: похоже на утечку" : "ВЕРДИКТ: устойчиво");
  process.exit(v.leaking ? 1 : 0);
}

main().catch((e) => {
  console.error("[memProfile] ошибка:", e.message);
  process.exit(1);
});

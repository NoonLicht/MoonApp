/**
 * «Паспорт ПК»: живой документ о компьютере — железо, драйверы, история
 * изменений и твиков, когда и что ломалось. Чистая логика: сборка данных,
 * сравнение снимков и вывод в Markdown. Сбор данных ОС — в routes/passport.ts.
 */

import fs from "fs";
import path from "path";

export interface PassportDriver {
  cls: string;
  name: string;
  vendor: string;
  version: string;
  /** YYYY-MM-DD или "". */
  date: string;
}

export interface PassportData {
  generatedAt: number;
  system: { hostname: string; osName: string; osVersion: string; osBuild: string; arch: string; uptimeSec: number };
  cpu: { model: string; coresPhysical: number | null; coresLogical: number };
  memoryMb: number;
  gpus: { name: string; memoryMb: number | null }[];
  disks: { name: string; totalGb: number | null; fs: string }[];
  drivers: PassportDriver[];
  tuning: { applied: { id: string; at: number }[]; history: { at: number; kind: string; ok: boolean; detail: string }[] };
  problems: { source: string; message: string; count: number; firstAt: number; lastAt: number; level: string }[];
}

export interface Change {
  at: number;
  kind: "hardware" | "driver" | "system";
  text: string;
}

const DAY = 86_400_000;

const key = (d: PassportDriver): string => `${d.cls}|${d.name}`;

/** Что изменилось между двумя снимками паспорта. */
export function diffPassports(prev: PassportData | null, next: PassportData): Change[] {
  if (!prev) return [];
  const at = next.generatedAt;
  const out: Change[] = [];
  if (prev.memoryMb && next.memoryMb && Math.abs(prev.memoryMb - next.memoryMb) > 256)
    out.push({ at, kind: "hardware", text: `RAM: ${Math.round(prev.memoryMb / 1024)} → ${Math.round(next.memoryMb / 1024)} ГБ` });
  if (prev.cpu.model !== next.cpu.model && prev.cpu.model)
    out.push({ at, kind: "hardware", text: `CPU: ${prev.cpu.model} → ${next.cpu.model}` });
  const pg = new Set(prev.gpus.map((g) => g.name));
  const ng = new Set(next.gpus.map((g) => g.name));
  for (const g of ng) if (!pg.has(g)) out.push({ at, kind: "hardware", text: `GPU добавлена: ${g}` });
  for (const g of pg) if (!ng.has(g)) out.push({ at, kind: "hardware", text: `GPU пропала: ${g}` });
  const pd = new Set(prev.disks.map((d) => d.name));
  const nd = new Set(next.disks.map((d) => d.name));
  for (const d of nd) if (!pd.has(d)) out.push({ at, kind: "hardware", text: `Диск добавлен: ${d}` });
  for (const d of pd) if (!nd.has(d)) out.push({ at, kind: "hardware", text: `Диск пропал: ${d}` });
  if (prev.system.osBuild && prev.system.osBuild !== next.system.osBuild)
    out.push({ at, kind: "system", text: `Windows: сборка ${prev.system.osBuild} → ${next.system.osBuild}` });
  const pm = new Map(prev.drivers.map((d) => [key(d), d]));
  for (const d of next.drivers) {
    const old = pm.get(key(d));
    if (old && old.version !== d.version)
      out.push({ at, kind: "driver", text: `Драйвер «${d.name}»: ${old.version} → ${d.version}` });
  }
  return out;
}

/** Драйверы важных классов, которым больше `years` лет. */
export function staleDrivers(drivers: PassportDriver[], now: number, years = 3): PassportDriver[] {
  const important = /^(DISPLAY|NET|MEDIA|BLUETOOTH|HDC|SCSIADAPTER)$/i;
  return drivers
    .filter((d) => important.test(d.cls) && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .filter((d) => now - Date.parse(`${d.date}T00:00:00Z`) > years * 365 * DAY)
    .sort((a, b) => a.date.localeCompare(b.date));
}

const d2 = (ts: number): string => new Date(ts).toISOString().slice(0, 16).replace("T", " ");

export interface PassportOptions {
  /** Накопленная история изменений между снимками паспорта. */
  changes: Change[];
  /** Скрыть имя ПК — когда документ отдают постороннему. */
  anonymize?: boolean;
}

/** Документ в Markdown: пригоден для печати и пересылки мастеру. */
export function toMarkdown(p: PassportData, o: PassportOptions): string {
  const L: string[] = [];
  const host = o.anonymize ? "—" : p.system.hostname;
  L.push(`# Паспорт ПК`, "", `_Сформирован ${d2(p.generatedAt)}_`, "");
  L.push("## Система", "");
  L.push(`- Имя: ${host}`);
  L.push(`- ОС: ${p.system.osName} ${p.system.osVersion} (сборка ${p.system.osBuild}, ${p.system.arch})`);
  L.push(`- Аптайм: ${Math.round(p.system.uptimeSec / 3600)} ч`, "");
  L.push("## Железо", "");
  L.push(
    `- Процессор: ${p.cpu.model} — ${p.cpu.coresPhysical ?? "?"} ядер / ${p.cpu.coresLogical} потоков`,
  );
  L.push(`- Память: ${(p.memoryMb / 1024).toFixed(1)} ГБ`);
  for (const g of p.gpus) L.push(`- Видеокарта: ${g.name}${g.memoryMb ? `, ${Math.round(g.memoryMb / 1024)} ГБ` : ""}`);
  for (const d of p.disks) L.push(`- Диск ${d.name}: ${d.totalGb ?? "?"} ГБ${d.fs ? `, ${d.fs}` : ""}`);
  L.push("");

  L.push("## Драйверы", "");
  const stale = staleDrivers(p.drivers, p.generatedAt);
  if (stale.length) {
    L.push("Давно не обновлялись (старше 3 лет):", "");
    for (const d of stale.slice(0, 10)) L.push(`- ${d.name} — ${d.version} (${d.date})`);
    L.push("");
  }
  const main = p.drivers.filter((d) => /^(DISPLAY|NET|MEDIA|BLUETOOTH)$/i.test(d.cls)).slice(0, 25);
  if (main.length) {
    L.push("| Класс | Устройство | Версия | Дата |", "|---|---|---|---|");
    for (const d of main) L.push(`| ${d.cls} | ${d.name} | ${d.version} | ${d.date || "—"} |`);
    L.push("");
  }

  L.push("## История изменений", "");
  const events: { at: number; text: string }[] = [
    ...o.changes.map((c) => ({ at: c.at, text: c.text })),
    ...p.tuning.history.map((h) => ({ at: h.at, text: `Твик «${h.kind}»${h.ok ? "" : " (ошибка)"}: ${h.detail}` })),
  ].sort((a, b) => b.at - a.at);
  if (!events.length) L.push("Пока без изменений.");
  for (const e of events.slice(0, 40)) L.push(`- ${d2(e.at)} — ${e.text}`);
  L.push("");

  L.push("## Что ломалось", "");
  if (!p.problems.length) L.push("Сбоев не зафиксировано.");
  for (const pr of [...p.problems].sort((a, b) => b.lastAt - a.lastAt).slice(0, 25)) {
    L.push(
      `- ${d2(pr.lastAt)} · ${pr.source}${pr.count > 1 ? ` ×${pr.count}` : ""}: ${pr.message.replace(/\s+/g, " ").slice(0, 160)}`,
    );
  }
  L.push("");
  return L.join("\n");
}

// ---------------- хранение снимков ----------------

function file(): string {
  const config = require("./config") as { DIRS: { storage: string } };
  return path.join(config.DIRS.storage, "pc-passport.json");
}

export interface PassportStore {
  last: PassportData | null;
  changes: Change[];
}

export function load(f = file()): PassportStore {
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    return { last: raw?.last ?? null, changes: Array.isArray(raw?.changes) ? raw.changes : [] };
  } catch {
    return { last: null, changes: [] };
  }
}

export function save(s: PassportStore, f = file()): void {
  fs.writeFileSync(f, JSON.stringify({ last: s.last, changes: s.changes.slice(-200) }), "utf8");
}

/** Обновляет хранилище новым снимком; возвращает хранилище и новые изменения. */
export function update(s: PassportStore, next: PassportData): { store: PassportStore; added: Change[] } {
  const added = diffPassports(s.last, next);
  return { store: { last: next, changes: [...s.changes, ...added] }, added };
}

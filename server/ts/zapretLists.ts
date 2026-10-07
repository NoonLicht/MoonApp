/**
 * Выделено из zapret.ts при разбиении крупного файла (поведение не менялось).
 */
import path from "path";
import fs from "fs";
import logger from "./logger";
import { stmts } from "./db";
import { runElevated } from "./elevate";
import { engineStatus, installDir } from "./zapret";

/* ------------------------- Списки доменов (lists/) ------------------------- */

export const USER_LISTS = [
  "list-general-user.txt",
  "list-exclude-user.txt",
  "ipset-exclude-user.txt",
];

function listFilePath(name: any) {
  if (!USER_LISTS.includes(name)) throw new Error("unknown_list");
  const st = engineStatus();
  const dir = st.listsDir || path.join(installDir(), "lists");
  return path.join(dir, name);
}

export function readList(name: any) {
  try {
    return fs.readFileSync(listFilePath(name), "utf8");
  } catch {
    return "";
  }
}

export function writeList(name: any, content: any) {
  const p = listFilePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(content || "").replace(/\r\n/g, "\n"), "utf8");
  logger.action("zapret.list.write", { name, size: String(content || "").length });
  return true;
}

/** Синхронизация пользовательских доменов из БД → list-*-user.txt. */
export function syncCustomDomains() {
  const rows = stmts.bcdAll.all().filter((r) => r.is_enabled);
  for (const name of ["list-general-user.txt", "list-exclude-user.txt"]) {
    const type = name.startsWith("list-general") ? "include" : "exclude";
    const domains = rows.filter((r) => r.type === type).map((r) => r.domain);
    if (!domains.length) continue;
    const existing = readList(name)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    writeList(name, [...new Set([...existing, ...domains])].join("\n") + "\n");
  }
  return stmts.bcdAll.all();
}

/** Список .bin fake-payload (bin/). */
export function listPayloads() {
  const st = engineStatus();
  if (!st.binDir) return [];
  try {
    return fs
      .readdirSync(st.binDir)
      .filter((f) => /\.bin$/i.test(f))
      .map((f) => ({
        name: f,
        path: path.join(st.binDir, f),
        sizeKb: Math.round(fs.statSync(path.join(st.binDir, f)).size / 102.4) / 10,
      }));
  } catch {
    return [];
  }
}

/* ------------------------- Очистка (Discord cache / DNS) ------------------------- */

export function clearDiscordCache() {
  const appdata = process.env.APPDATA || "";
  const variants = ["discord", "discordcanary", "discordptb", "discorddevelopment"];
  let freed = 0;
  for (const v of variants) {
    for (const sub of ["Cache", "Code Cache", "GPUCache", "DawnCache"]) {
      const p = path.join(appdata, v, sub);
      try {
        if (fs.existsSync(p)) {
          freed += dirSize(p);
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }
  }
  logger.action("zapret.cache.clear", { freedKb: freed });
  return { freedKb: freed };
}

function dirSize(p: any) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, f.name);
      if (f.isDirectory()) total += dirSize(fp);
      else {
        try {
          total += Math.ceil(fs.statSync(fp).size / 1024);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

export async function flushDns() {
  const r = await runElevated("ipconfig.exe", ["/flushdns"], { timeoutMs: 30000 });
  return { ok: r.ok, error: r.error };
}

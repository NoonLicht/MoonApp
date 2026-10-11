/**
 * Снимки заметок перед рискованными правками (ИИ-оформление): копия лежит в
 * скрытой папке .history хранилища и не показывается в дереве заметок.
 * На заметку хранится не больше MAX_PER_NOTE последних снимков.
 */
import fs from "fs";
import path from "path";
import config from "./config";

const MAX_PER_NOTE = 20;
const root = (): string => path.join(config.DIRS.vaultNotes, ".history");

/** Папка снимков конкретной заметки; путь заметки приводится к безопасному виду. */
function dirFor(notePath: string): string | null {
  const parts = notePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return null;
  return path.join(root(), ...parts);
}

export interface Snapshot {
  id: string;
  at: number;
  size: number;
  reason: string;
}

const NAME = /^(\d+)(?:-([a-z0-9-]+))?\.md$/;

export function snapshot(notePath: string, content: string, reason = "manual"): Snapshot | null {
  const dir = dirFor(notePath);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  // уникальная метка даже при нескольких снимках за одну миллисекунду
  let at = Date.now();
  while (fs.existsSync(path.join(dir, `${at}-${reason}.md`))) at++;
  const id = `${at}-${reason.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "manual"}`;
  fs.writeFileSync(path.join(dir, `${id}.md`), content, "utf8");
  const all = list(notePath);
  for (const old of all.slice(MAX_PER_NOTE)) {
    try {
      fs.unlinkSync(path.join(dir, `${old.id}.md`));
    } catch {
      /* уже удалён */
    }
  }
  return { id, at, size: Buffer.byteLength(content), reason };
}

/** Снимки заметки, новые первыми. */
export function list(notePath: string): Snapshot[] {
  const dir = dirFor(notePath);
  if (!dir || !fs.existsSync(dir)) return [];
  const out: Snapshot[] = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(NAME);
    if (!m) continue;
    out.push({
      id: f.replace(/\.md$/, ""),
      at: Number(m[1]),
      size: fs.statSync(path.join(dir, f)).size,
      reason: m[2] ?? "manual",
    });
  }
  return out.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}

export function read(notePath: string, id: string): string | null {
  const dir = dirFor(notePath);
  if (!dir || !/^\d+(-[a-z0-9-]+)?$/.test(id)) return null;
  const file = path.join(dir, `${id}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

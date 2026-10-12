/**
 * «Машина времени» (логика — в timeMachine.ts). Только чтение, кроме явного
 * восстановления заметки копией.
 *
 *  GET  /api/time-machine/range            — { from, to, commits }
 *  GET  /api/time-machine/state?date=      — состояние на дату: заметки, доски, задачи, траты, дневник
 *  GET  /api/time-machine/file?oid=&path=  — текст файла из снимка
 *  POST /api/time-machine/restore          — { oid, path, date } → копия рядом с оригиналом
 *  POST /api/time-machine/snapshot         — сделать снимок сейчас
 */
import express from "express";
import fs from "fs";
import path from "path";
import config from "../config";
import * as notesGit from "../notesGit";
import * as budget from "../budget";
import * as diary from "../diary";
import * as tm from "../timeMachine";
import * as backup from "../backup";

const router = express.Router();
const OID = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function readTasks(): tm.TaskLite[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.DIRS.vault, "tasks.json"), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Путь внутри vault без выхода за его пределы; только notes/ и holts/. */
function safeVaultPath(p: unknown): string | null {
  const rel = String(p ?? "").replace(/\\/g, "/");
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) return null;
  if (!/^(notes|holts)\//.test(rel)) return null;
  return rel;
}

async function commits(): Promise<tm.CommitInfo[]> {
  const list = await notesGit.log(500);
  return list.map((c) => ({ oid: c.oid, timestamp: c.timestamp, message: c.message }));
}

router.get("/range", async (_req, res) => {
  try {
    const cs = await commits();
    const range = tm.rangeOf({
      commits: cs,
      txDates: budget.list().map((t) => t.date),
      taskCreated: readTasks()
        .map((t) => t.created_at)
        .filter((x): x is string => !!x),
      diaryDates: diary.listEntries().map((e) => e.date),
    });
    // Ползунок ходит только по дням, где реально есть снимок: коммит заметок
    // или полная резервная копия приложения.
    // Каждый снимок — отдельная точка (а не день): несколько снимков за день
    // остаются разными позициями ползунка.
    const pts = new Set<number>();
    for (const c of cs) pts.add(c.timestamp);
    for (const b of backup.list()) {
      const t = Date.parse(b.at);
      if (Number.isFinite(t)) pts.add(t);
    }
    res.json({ ...range, commits: cs.length, points: [...pts].sort((a, b) => a - b) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/state", async (req, res) => {
  try {
    const date = String(req.query.date ?? "");
    if (!DATE.test(date)) return res.status(400).json({ error: "bad_date" });
    // ts — момент конкретного снимка; без него берётся конец дня.
    const tsQ = Number(req.query.ts);
    const end = Number.isFinite(tsQ) && tsQ > 0 ? tsQ : tm.endOfDay(date);
    const commit = tm.pickCommit(await commits(), end);

    let notes: { path: string; title: string }[] = [];
    let boards: { path: string; title: string }[] = [];
    if (commit) {
      const files = [...(await notesGit.listTreeFiles(commit.oid))].sort();
      const title = (p: string) => path.basename(p).replace(/\.[^.]+$/, "");
      notes = files
        .filter((p) => /^notes\/.+\.md$/i.test(p) && !p.includes("/.history/"))
        .map((p) => ({ path: p, title: title(p) }));
      boards = files.filter((p) => /^holts\//.test(p)).map((p) => ({ path: p, title: title(p) }));
    }

    // Ближайшая полная копия приложения не позже этого дня.
    let fullBackup: { id: string; at: string } | null = null;
    for (const b of backup.list()) {
      const t = Date.parse(b.at);
      if (!Number.isFinite(t) || t > end || !b.id) continue;
      if (!fullBackup || t > Date.parse(fullBackup.at)) fullBackup = { id: b.id, at: b.at };
    }

    const tasks = tm.tasksAsOf(readTasks(), date);
    const entry = diary.isValidDate(date) ? diary.readEntry(date) : null;
    res.json({
      date,
      snapshot: commit ? { oid: commit.oid, at: commit.timestamp, message: commit.message } : null,
      backup: fullBackup,
      notes: notes.slice(0, 500),
      notesTotal: notes.length,
      boards: boards.slice(0, 200),
      tasks: {
        open: tasks.filter((t) => t.status === "open").length,
        done: tasks.filter((t) => t.status === "done").length,
        items: tasks.slice(0, 200),
      },
      budget: tm.budgetAsOf(budget.list(), date),
      diary: entry && entry.exists ? { content: String(entry.content).slice(0, 4000) } : null,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get("/file", async (req, res) => {
  try {
    const oid = String(req.query.oid ?? "");
    const rel = safeVaultPath(req.query.path);
    if (!OID.test(oid) || !rel) return res.status(400).json({ error: "bad_params" });
    const text = await notesGit.readTextAt(oid, rel);
    if (text === null) return res.status(404).json({ error: "not_found" });
    res.json({ path: rel, text });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/restore", async (req, res) => {
  try {
    const oid = String(req.body?.oid ?? "");
    const rel = safeVaultPath(req.body?.path);
    const date = String(req.body?.date ?? "");
    if (!OID.test(oid) || !rel || !DATE.test(date)) return res.status(400).json({ error: "bad_params" });
    const text = await notesGit.readTextAt(oid, rel);
    if (text === null) return res.status(404).json({ error: "not_found" });
    const root = path.resolve(config.DIRS.vault);
    const exists = (p: string) => fs.existsSync(path.join(root, p));
    const target = tm.restoredName(rel, date, exists);
    const full = path.resolve(root, target);
    if (!full.startsWith(root + path.sep)) return res.status(400).json({ error: "bad_path" });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, "utf8");
    res.json({ ok: true, path: target });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/snapshot", async (_req, res) => {
  try {
    // Снимок всего приложения: заметки/доски (git) + полная копия БД, настроек,
    // дневника, закладок и т. д. (резервная копия).
    const notes = await notesGit.snapshot("MoonApp: снимок вручную");
    const full = backup.createBackup("time-machine");
    res.json({ ...notes, committed: !!notes.committed || !!full, backup: full ? path.basename(full) : null });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export = router;

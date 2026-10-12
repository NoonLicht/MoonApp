/**
 * Дополнительные подсказки «Контекста» помимо семантического поиска: дневник,
 * договорённости, буфер обмена, пароли (только названия), ближайшие сроки,
 * правила и расписание, время в приложениях, траты по теме и т. д.
 *
 * Каждый провайдер независим и безопасен: ошибка одного не ломает остальные.
 */
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
import * as diary from "./diary";
import * as budget from "./budget";
import * as clipboard from "./clipboardHistory";
import * as vault from "./passwordVault";
import * as rules from "./automationRules";
import * as automation from "./automation";
import * as tracker from "./appTimeTracker";
import * as shots from "./screenshots";
import * as selfContracts from "./selfContracts";
import * as semantic from "./semantic";

export interface ExtraHit {
  source: string;
  ref: string;
  title: string;
  snippet: string;
  score: number;
  at?: number;
}
export interface ExtraGroup {
  source: string;
  items: ExtraHit[];
}

const MAX_PER = 3;

function safe<T>(name: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    logger.warn("ghost.extras_failed", { provider: name, error: (e as Error).message });
    return fallback;
  }
}

/** Текст содержит хотя бы одно ключевое слово (регистр не важен). */
function matches(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => w.length >= 3 && t.includes(w));
}

function around(text: string, words: string[], len = 110): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const from = Math.max(0, (at < 0 ? 0 : at) - 30);
  return flat.slice(from, from + len);
}

function readTasks(): { id: string; title: string; status?: string; dueDate?: string | null }[] {
  const raw = JSON.parse(fs.readFileSync(path.join(config.DIRS.vault, "tasks.json"), "utf8"));
  return Array.isArray(raw) ? raw : [];
}

const todayKey = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function group(source: string, items: ExtraHit[]): ExtraGroup | null {
  return items.length ? { source, items: items.slice(0, MAX_PER) } : null;
}

export async function collect(query: string, text: string): Promise<ExtraGroup[]> {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  const out: (ExtraGroup | null)[] = [];
  const empty: ExtraHit[] = [];

  // 2. Дневник: записи, где встречается тема.
  out.push(
    group(
      "diary",
      safe(
        "diary",
        () => {
          if (!words.length) return empty;
          const hits: ExtraHit[] = [];
          for (const it of diary.listEntries().slice(-120).reverse()) {
            const e = diary.readEntry(it.date);
            if (e.exists && matches(String(e.content), words)) {
              hits.push({
                source: "diary",
                ref: it.date,
                title: it.date,
                snippet: around(String(e.content), words),
                score: 1,
              });
              if (hits.length >= MAX_PER) break;
            }
          }
          return hits;
        },
        empty,
      ),
    ),
  );

  // 3. Договорённости с собой, связанные с темой.
  out.push(
    group(
      "contract",
      safe(
        "contract",
        () =>
          selfContracts
            .load()
            .filter((c) => matches(`${c.label} ${c.target}`, words))
            .map((c) => ({
              source: "contract",
              ref: c.id,
              title: c.label,
              snippet: `${c.target} · ${c.limit}`,
              score: 1,
            })),
        empty,
      ),
    ),
  );

  // 7. Свежие снимки экрана и записи (за сутки).
  out.push(
    group(
      "shot",
      safe(
        "shot",
        () => {
          if (!words.length) return empty;
          const since = Date.now() - 86_400_000;
          return shots
            .list()
            .filter((m) => m.createdAt >= since)
            .slice(0, MAX_PER)
            .map((m) => ({
              source: "shot",
              ref: m.id,
              title: m.file,
              snippet: m.type === "video" ? "video" : "image",
              score: 1,
              at: m.createdAt,
            }));
        },
        empty,
      ),
    ),
  );

  // 9. Буфер обмена (секреты там уже не хранятся).
  out.push(
    group(
      "clip",
      safe(
        "clip",
        () =>
          words.length
            ? clipboard
                .load()
                .filter((c) => matches(c.text, words))
                .slice(0, MAX_PER)
                .map((c) => ({
                  source: "clip",
                  ref: c.id,
                  title: c.text.replace(/\s+/g, " ").slice(0, 60),
                  snippet: c.text,
                  score: 1,
                  at: c.at,
                }))
            : empty,
        empty,
      ),
    ),
  );

  // 10. Менеджер паролей: только названия и логин, пароль не отдаётся.
  out.push(
    group(
      "vault",
      safe(
        "vault",
        () =>
          words.length
            ? vault
                .list()
                .filter((p) => matches(`${p.title} ${p.url} ${p.tags.join(" ")}`, words))
                .map((p) => ({
                  source: "vault",
                  ref: p.id,
                  title: p.title,
                  snippet: p.username || p.url,
                  score: 1,
                }))
            : empty,
        empty,
      ),
    ),
  );

  // 11. Ближайшие сроки задач (не зависит от темы).
  out.push(
    group(
      "due",
      safe(
        "due",
        () => {
          const today = todayKey();
          return readTasks()
            .filter((t) => t.dueDate && t.status !== "completed" && t.status !== "done")
            .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
            .slice(0, MAX_PER)
            .map((t) => ({
              source: "due",
              ref: t.id,
              title: t.title,
              snippet: `${t.dueDate}${String(t.dueDate) < today ? " ⚠" : ""}`,
              score: 1,
            }));
        },
        empty,
      ),
    ),
  );

  // 12. Правила автоматизации и запланированные задачи.
  const sched: ExtraHit[] = safe(
    "rules",
    () =>
      rules
        .listRules()
        .filter((r) => r.enabled)
        .slice(0, 2)
        .map((r) => ({ source: "schedule", ref: r.id, title: r.name, snippet: r.folder, score: 1 })),
    empty,
  );
  try {
    const tasks = await Promise.race([
      automation.listScheduledTasks(),
      new Promise<automation.ScheduledTask[]>((r) => setTimeout(() => r([]), 1200)),
    ]);
    for (const t of tasks.slice(0, 2)) {
      sched.push({
        source: "schedule",
        ref: t.name,
        title: t.name,
        snippet: t.nextRun || t.schedule,
        score: 1,
      });
    }
  } catch {
    /* расписание Windows недоступно — остаются правила */
  }
  out.push(group("schedule", sched));

  // 15. Время в приложениях сегодня.
  out.push(
    group(
      "app",
      safe(
        "app",
        () =>
          tracker
            .todayStats()
            .apps.slice(0, MAX_PER)
            .map((a) => ({
              source: "app",
              ref: a.name,
              title: a.name,
              snippet: `${Math.round(a.seconds / 60)} min`,
              score: 1,
            })),
        empty,
      ),
    ),
  );

  // 18. Траты по теме за текущий месяц.
  out.push(
    group(
      "spend",
      safe(
        "spend",
        () => {
          if (!words.length) return empty;
          const month = todayKey().slice(0, 7);
          const rows = budget
            .list()
            .filter(
              (t) =>
                t.type === "expense" &&
                t.date.startsWith(month) &&
                matches(`${t.note} ${t.category}`, words),
            );
          if (!rows.length) return empty;
          const sum = rows.reduce((s, t) => s + t.amount, 0);
          return [
            {
              source: "spend",
              ref: month,
              title: String(Math.round(sum)),
              snippet: `${rows.length} · ${rows[0].note || rows[0].category}`,
              score: 1,
            },
          ];
        },
        empty,
      ),
    ),
  );

  // 17. Теги и люди: #тег и @имя из выделения → заметки с тем же словом.
  const marks = [...new Set((text.match(/[#@][\p{L}\p{N}_-]{2,}/gu) ?? []).slice(0, 3))];
  if (marks.length) {
    try {
      const items: ExtraHit[] = [];
      for (const m of marks) {
        const hits = await semantic.search(m.slice(1), { sources: ["note"], limit: 3 });
        for (const h of hits) {
          items.push({
            source: "note",
            ref: h.ref,
            title: `${m} · ${h.title}`,
            snippet: h.snippet,
            score: 1,
          });
        }
      }
      out.push(group("tag", items));
    } catch {
      /* индекс недоступен */
    }
  }

  return out.filter((g): g is ExtraGroup => g !== null);
}

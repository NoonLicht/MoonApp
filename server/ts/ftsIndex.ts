/**
 * Полнотекстовый индекс (SQLite FTS5, BM25) для семантического поиска.
 *
 * Хранит ПОЛНЫЙ текст кусков (в meta.json лежит только сниппет в 260 символов),
 * поэтому находит слова из любого места документа. Таблица живёт в data.db —
 * попадает в бэкапы и не требует отдельных файлов. Работает и без модели
 * эмбеддингов: пока модель не скачана, поиск остаётся лексическим.
 *
 * Таблица создаётся лениво (CREATE VIRTUAL TABLE IF NOT EXISTS), без миграции
 * схемы: индекс — производные данные, его всегда можно пересобрать.
 */
import type Database from "better-sqlite3";
import { connection } from "./db";
import { ftsMatch } from "./hybridRank";

export interface FtsHit {
  source: string;
  ref: string;
  title: string;
  snippet: string;
  /** bm25: чем меньше (отрицательнее), тем релевантнее. */
  bm25: number;
}

let ready: Database.Database | null = null;

function tbl(): Database.Database {
  const c = connection();
  if (ready === c) return c;
  c.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS sem_fts USING fts5(
    source UNINDEXED, ref UNINDEXED, title, body,
    tokenize = 'unicode61 remove_diacritics 2'
  )`);
  ready = c;
  return c;
}

/** Есть ли уже записи этого источника в индексе (для дозаполнения старых индексов). */
export function ftsHas(source: string, ref: string): boolean {
  const row = tbl()
    .prepare(`SELECT 1 AS x FROM sem_fts WHERE source = ? AND ref = ? LIMIT 1`)
    .get(source, ref);
  return !!row;
}

/** Заменяет все куски источника. */
export function ftsPut(source: string, ref: string, title: string, parts: string[]): void {
  const c = tbl();
  const del = c.prepare(`DELETE FROM sem_fts WHERE source = ? AND ref = ?`);
  const ins = c.prepare(`INSERT INTO sem_fts (source, ref, title, body) VALUES (?, ?, ?, ?)`);
  c.transaction(() => {
    del.run(source, ref);
    for (const p of parts) ins.run(source, ref, title, p);
  })();
}

export function ftsRemove(source: string, ref: string): void {
  tbl().prepare(`DELETE FROM sem_fts WHERE source = ? AND ref = ?`).run(source, ref);
}

/** Сколько кусков в индексе. */
export function ftsCount(): number {
  const row = tbl().prepare(`SELECT count(*) AS n FROM sem_fts`).get() as { n: number };
  return row.n;
}

/** Поиск по BM25; лучший кусок каждого источника. Заголовок весит больше тела. */
export function ftsSearch(query: string, o: { sources?: string[]; limit?: number } = {}): FtsHit[] {
  const match = ftsMatch(query);
  if (!match) return [];
  const limit = o.limit ?? 10;
  const c = tbl();
  let sql = `SELECT source, ref, title, snippet(sem_fts, 3, '', '', '…', 24) AS snip,
                    bm25(sem_fts, 0.0, 0.0, 4.0, 1.0) AS score
             FROM sem_fts WHERE sem_fts MATCH ?`;
  const args: unknown[] = [match];
  if (o.sources?.length) {
    sql += ` AND source IN (${o.sources.map(() => "?").join(",")})`;
    args.push(...o.sources);
  }
  sql += ` ORDER BY score LIMIT ?`;
  args.push(limit * 4); // куски одного документа схлопнем ниже
  let rows: { source: string; ref: string; title: string; snip: string; score: number }[];
  try {
    rows = c.prepare(sql).all(...args) as typeof rows;
  } catch {
    return []; // некорректный запрос не должен ронять поиск
  }
  const seen = new Set<string>();
  const out: FtsHit[] = [];
  for (const r of rows) {
    const k = `${r.source}\u0000${r.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ source: r.source, ref: r.ref, title: r.title, snippet: r.snip, bm25: r.score });
    if (out.length >= limit) break;
  }
  return out;
}

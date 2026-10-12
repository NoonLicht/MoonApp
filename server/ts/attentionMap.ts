/**
 * Карта внимания: неделя × 24 часа. В каждой клетке — время в приложениях,
 * лекции и выполненные задачи; отдельно оценивается сон (самый долгий
 * промежуток без активности ночью). Чистая логика; данные подают маршруты.
 *
 * Сон — оценка по отсутствию активности за компьютером, а не измерение: если
 * вы не за компьютером вечером, он тоже «спит». Поэтому показывается как
 * «вероятный сон» и только когда пауза ≥ 4 часов.
 */

/** Секунды по приложениям: дата (локальная) → час → приложение → секунды. */
export type HourStats = Record<string, Record<string, Record<string, number>>>;

export type AppCategory = "browser" | "dev" | "chat" | "media" | "game" | "office" | "other";

const CATEGORY_RULES: [AppCategory, RegExp][] = [
  ["game", /steam|epicgames|valorant|dota|csgo|cs2|minecraft|fortnite|genshin|league|gta|roblox|game/i],
  ["dev", /code|devenv|idea|pycharm|webstorm|rider|clion|studio|terminal|powershell|cmd|git|node|sublime|vim|cursor/i],
  ["chat", /telegram|discord|whatsapp|slack|teams|zoom|skype|viber|signal/i],
  ["media", /vlc|spotify|mpc|potplayer|music|youtube|netflix|kinopoisk|mpv|obs/i],
  ["browser", /chrome|firefox|msedge|opera|brave|vivaldi|yandex|browser|safari/i],
  ["office", /winword|excel|powerpnt|onenote|notion|obsidian|acrobat|libreoffice|soffice|notepad|outlook/i],
];

export function categoryOf(app: string): AppCategory {
  for (const [c, re] of CATEGORY_RULES) if (re.test(app)) return c;
  return "other";
}

export interface Cell {
  appSec: number;
  topApp: string;
  lectureSec: number;
  tasks: number;
}

export interface DayRow {
  date: string;
  cells: Cell[];
  activeHours: number;
  sleep: { from: number; to: number; hours: number } | null;
}

export interface WeekMap {
  from: string;
  to: string;
  days: DayRow[];
  /** Максимум секунд приложений в клетке — для нормировки цвета. */
  maxAppSec: number;
}

export interface LectureSpan {
  startMs: number;
  durationMs: number;
}

const pad = (n: number): string => String(n).padStart(2, "0");
export const dayKey = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function lastDays(end: string, n: number): string[] {
  const [y, m, d] = end.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(y, m - 1, d - i, 12).getTime()));
  return out;
}

/** Самая длинная серия пустых часов; ищем среди 0…23 текущего дня и 0…11 следующего (ночь целиком). */
export function longestQuiet(hoursActive: boolean[], nextDay: boolean[] | null): { from: number; to: number; hours: number } | null {
  const seq = [...hoursActive.slice(18), ...(nextDay ? nextDay.slice(0, 12) : new Array(0).fill(false))];
  let best = { start: -1, len: 0 };
  let cur = { start: -1, len: 0 };
  seq.forEach((active, i) => {
    if (!active) {
      if (cur.len === 0) cur.start = i;
      cur.len++;
      if (cur.len > best.len) best = { ...cur };
    } else cur = { start: -1, len: 0 };
  });
  if (best.len < 4) return null;
  const from = (18 + best.start) % 24;
  return { from, to: (from + best.len) % 24, hours: best.len };
}

export function buildWeek(p: {
  end: string;
  stats: HourStats;
  lectures: LectureSpan[];
  /** Метки времени выполненных задач (мс). */
  tasksDone: number[];
  days?: number;
  /** С какого порога секунд час считается активным. */
  activeFromSec?: number;
}): WeekMap {
  const days = lastDays(p.end, p.days ?? 7);
  const thr = p.activeFromSec ?? 60;
  const rows: DayRow[] = days.map((date) => ({
    date,
    cells: Array.from({ length: 24 }, () => ({ appSec: 0, topApp: "", lectureSec: 0, tasks: 0 })),
    activeHours: 0,
    sleep: null,
  }));
  const byDate = new Map(rows.map((r) => [r.date, r]));
  let maxAppSec = 0;

  for (const r of rows) {
    const day = p.stats[r.date] ?? {};
    for (let h = 0; h < 24; h++) {
      const apps = day[String(h)];
      if (!apps) continue;
      let sum = 0;
      let top = "";
      let topSec = 0;
      for (const [app, sec] of Object.entries(apps)) {
        sum += sec;
        if (sec > topSec) {
          topSec = sec;
          top = app;
        }
      }
      r.cells[h].appSec = Math.min(sum, 3600);
      r.cells[h].topApp = top;
      maxAppSec = Math.max(maxAppSec, r.cells[h].appSec);
    }
  }

  // Лекции: распределяем длительность по часам, которые они пересекают.
  for (const l of p.lectures) {
    let t = l.startMs;
    const end = l.startMs + Math.max(0, l.durationMs);
    while (t < end) {
      const d = new Date(t);
      const hourEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      const seg = Math.min(end, hourEnd) - t;
      const row = byDate.get(dayKey(t));
      if (row) row.cells[d.getHours()].lectureSec += Math.round(seg / 1000);
      t += seg || 1;
    }
  }

  for (const ts of p.tasksDone) {
    const row = byDate.get(dayKey(ts));
    if (row) row.cells[new Date(ts).getHours()].tasks++;
  }

  rows.forEach((r, i) => {
    const active = r.cells.map((c) => c.appSec >= thr || c.lectureSec >= thr);
    r.activeHours = active.filter(Boolean).length;
    const next = rows[i + 1];
    const nextActive = next ? next.cells.map((c) => c.appSec >= thr || c.lectureSec >= thr) : null;
    // последний день: следующей ночи ещё нет — сон не оцениваем
    r.sleep = nextActive ? longestQuiet(active, nextActive) : null;
  });

  return { from: days[0], to: days[days.length - 1], days: rows, maxAppSec };
}

// ---------------- факты для ответа «почему вечером не хватает сил» ----------------

export interface Facts {
  avgActiveHours: number;
  peakHour: number | null;
  /** Доля времени в приложениях после 18:00. */
  eveningShare: number;
  lateNightDays: number;
  avgSleepHours: number | null;
  longestStreakHours: number;
  lectureHours: number;
  tasksDone: number;
  categories: { category: AppCategory; hours: number }[];
  topApps: { app: string; hours: number }[];
}

export function factsOf(week: WeekMap, stats: HourStats): Facts {
  const perHour = new Array(24).fill(0);
  const cat = new Map<AppCategory, number>();
  const app = new Map<string, number>();
  let total = 0;
  let evening = 0;
  let lectureSec = 0;
  let tasks = 0;
  let late = 0;
  let longest = 0;
  for (const r of week.days) {
    let streak = 0;
    let lateDay = false;
    r.cells.forEach((c, h) => {
      perHour[h] += c.appSec;
      total += c.appSec;
      if (h >= 18) evening += c.appSec;
      if ((h >= 23 || h < 4) && c.appSec >= 600) lateDay = true;
      lectureSec += c.lectureSec;
      tasks += c.tasks;
      if (c.appSec >= 60 || c.lectureSec >= 60) {
        streak++;
        longest = Math.max(longest, streak);
      } else streak = 0;
    });
    if (lateDay) late++;
    for (const [hr, apps] of Object.entries(stats[r.date] ?? {})) {
      void hr;
      for (const [name, sec] of Object.entries(apps)) {
        app.set(name, (app.get(name) ?? 0) + sec);
        const c = categoryOf(name);
        cat.set(c, (cat.get(c) ?? 0) + sec);
      }
    }
  }
  const n = week.days.length || 1;
  const sleeps = week.days.map((d) => d.sleep?.hours).filter((x): x is number => typeof x === "number");
  const peak = perHour.reduce((b, v, h) => (v > perHour[b] ? h : b), 0);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    avgActiveHours: r1(week.days.reduce((s, d) => s + d.activeHours, 0) / n),
    peakHour: total > 0 ? peak : null,
    eveningShare: total > 0 ? Math.round((evening / total) * 100) / 100 : 0,
    lateNightDays: late,
    avgSleepHours: sleeps.length ? r1(sleeps.reduce((a, b) => a + b, 0) / sleeps.length) : null,
    longestStreakHours: longest,
    lectureHours: r1(lectureSec / 3600),
    tasksDone: tasks,
    categories: [...cat.entries()]
      .map(([category, s]) => ({ category, hours: r1(s / 3600) }))
      .sort((a, b) => b.hours - a.hours),
    topApps: [...app.entries()]
      .map(([a, s]) => ({ app: a, hours: r1(s / 3600) }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 6),
  };
}

/** Выводы без модели: простые правила по фактам. */
export function insightsFrom(f: Facts): string[] {
  const out: string[] = [];
  if (f.eveningShare >= 0.45) out.push(`evening:${Math.round(f.eveningShare * 100)}`);
  if (f.longestStreakHours >= 8) out.push(`streak:${f.longestStreakHours}`);
  if (f.lateNightDays >= 2) out.push(`late:${f.lateNightDays}`);
  if (f.avgSleepHours !== null && f.avgSleepHours < 6.5) out.push(`sleep:${f.avgSleepHours}`);
  return out;
}

export function buildAskPrompt(question: string, week: WeekMap, f: Facts): string {
  const lines = week.days.map((d) => {
    const hours = d.cells.map((c) => (c.appSec >= 60 || c.lectureSec >= 60 ? "█" : "·")).join("");
    return `${d.date} ${hours} активных часов: ${d.activeHours}` +
      (d.sleep ? `, вероятный сон ${pad(d.sleep.from)}:00–${pad(d.sleep.to)}:00 (${d.sleep.hours} ч)` : "");
  });
  return (
    `Вот данные об использовании компьютера за неделю (строка = день, 24 символа = часы 0…23, █ — была активность):\n` +
    lines.join("\n") +
    `\n\nСводка (JSON): ${JSON.stringify(f)}\n\n` +
    `Вопрос пользователя: ${question.trim()}\n\n` +
    `Ответь по-русски, кратко и по делу, опираясь только на эти данные: назови 2–4 наблюдения с цифрами и одну практичную рекомендацию. ` +
    `Если данных мало для вывода — скажи об этом. Сон — оценка по паузам в активности, не измерение.`
  );
}

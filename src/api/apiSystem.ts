/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { req } from "@/api/apiHttp";
import type {
  AppItem,
  GameEntry,
  GameInput,
  SaveVersion,
  LauncherEntry,
  LauncherInput,
  ScheduledTask,
  ScheduledTaskInput,
  Transaction,
  TransactionInput,
  MonthSummary,
  BudgetCategories,
  BudgetImportResult,
  AppTimeToday,
  AppTimeHistoryDay,
  TmTask,
} from "@/api/types";

export const systemApi = {
  wingetSearch: (q: string) =>
    req<AppItem[]>("GET", `/apps/winget/search?q=${encodeURIComponent(q)}`),
  wingetStatus: () => req<{ state: string; cached: number }>("GET", "/apps/winget/status"),
  wingetIndex: () => req("POST", "/apps/winget/index"),
  comssCategories: () => req("GET", "/apps/comss/categories"),
  comssScrape: (categories: string[], limit: number) =>
    req<{ ok: boolean; jobId: string }>("POST", "/apps/comss/scrape", { categories, limit }),
  comssProgress: (jobId: string) =>
    req("GET", `/apps/comss/progress?job=${encodeURIComponent(jobId)}`),
  comssImport: (items: unknown[]) =>
    req<{ added: number; skipped: number }>("POST", "/apps/comss/import", { items }),
  logReports: () => req<{ file: string; size: number; mtime: string }[]>("GET", "/backup/logs"),
  logAction: (event: string, data?: unknown) => req("POST", "/log", { event, data }),

  // --- Игры (лаунчер) ---
  gamesList: () => req<GameEntry[]>("GET", "/games"),
  gamesCreate: (payload: GameInput) => req<GameEntry>("POST", "/games", payload),
  gamesUpdate: (id: string, payload: Partial<GameInput>) =>
    req<GameEntry>("PUT", `/games/${id}`, payload),
  gamesDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/games/${id}`),
  gamesLaunch: (id: string) => req<{ ok: boolean; error?: string }>("POST", `/games/${id}/launch`),
  gamesAutoScan: () =>
    req<{ added: number; scanned: { steam: number; epic: number } }>("POST", "/games/autoscan"),
  gamesSaveBackup: (id: string) =>
    req<{ ok: boolean; error?: string; file?: string }>("POST", `/games/${id}/save/backup`),
  gamesSaveVersions: (id: string) => req<SaveVersion[]>("GET", `/games/${id}/save/versions`),
  gamesSaveRestore: (id: string, file: string) =>
    req<{ ok: boolean; error?: string }>("POST", `/games/${id}/save/restore`, { file }),
  gamesSaveFindPath: (id: string) =>
    req<{ found: boolean; savePath: string | null; entry?: GameEntry }>(
      "POST",
      `/games/${id}/save/find-path`,
    ),

  // --- Автоматизация (быстрый лаунчер + планировщик заданий) ---
  automationLaunchers: () => req<LauncherEntry[]>("GET", "/automation/launchers"),
  automationCreateLauncher: (payload: LauncherInput) =>
    req<LauncherEntry>("POST", "/automation/launchers", payload),
  automationDeleteLauncher: (id: string) =>
    req<{ ok: boolean }>("DELETE", `/automation/launchers/${id}`),
  automationRunLauncher: (id: string) =>
    req<{ ok: boolean; error?: string }>("POST", `/automation/launchers/${id}/run`),
  automationTasks: () => req<ScheduledTask[]>("GET", "/automation/tasks"),
  automationCreateTask: (payload: ScheduledTaskInput) =>
    req<{ ok: boolean; error?: string }>("POST", "/automation/tasks", payload),
  automationDeleteTask: (name: string) =>
    req<{ ok: boolean; error?: string }>("DELETE", `/automation/tasks/${encodeURIComponent(name)}`),
  automationRunTask: (name: string) =>
    req<{ ok: boolean; error?: string }>(
      "POST",
      `/automation/tasks/${encodeURIComponent(name)}/run`,
    ),

  // --- Бюджет/финансы ---
  budgetList: (displayCurrency?: string) =>
    req<Transaction[]>(
      "GET",
      `/budget/transactions${displayCurrency ? `?currency=${displayCurrency}` : ""}`,
    ),
  budgetCreate: (payload: TransactionInput) =>
    req<Transaction>("POST", "/budget/transactions", payload),
  budgetDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/budget/transactions/${id}`),
  budgetSummary: (period: "day" | "week" | "month" = "month", count = 6, currency = "RUB") =>
    req<MonthSummary[]>(
      "GET",
      `/budget/summary?period=${period}&count=${count}&currency=${currency}`,
    ),
  budgetCategories: () => req<BudgetCategories>("GET", "/budget/categories"),
  budgetCurrencies: () => req<string[]>("GET", "/budget/currencies"),
  budgetImportCsv: (csv: string) => req<BudgetImportResult>("POST", "/budget/import", { csv }),

  // --- Сетевые утилиты (страница Bypass) ---
  netPing: (host: string) =>
    req<{ ok: boolean; output: string }>("GET", `/nettools/ping?host=${encodeURIComponent(host)}`),
  netTraceroute: (host: string) =>
    req<{ ok: boolean; output: string }>(
      "GET",
      `/nettools/traceroute?host=${encodeURIComponent(host)}`,
    ),
  netPortScan: (host: string, from: number, to: number) =>
    req<{ host: string; results: { port: number; open: boolean }[] }>(
      "GET",
      `/nettools/portscan?host=${encodeURIComponent(host)}&from=${from}&to=${to}`,
    ),
  netPublicIp: () => req<{ ip: string }>("GET", "/nettools/publicip"),
  netWifiNetworks: () => req<{ ok: boolean; output: string }>("GET", "/nettools/wifi/networks"),
  netWifiCurrent: () => req<{ ok: boolean; output: string }>("GET", "/nettools/wifi/current"),
  netSpeedTest: () =>
    req<{ ok: boolean; mbps?: number; bytes?: number; ms?: number; error?: string }>(
      "GET",
      "/nettools/speedtest",
    ),

  // --- Трекер времени за приложениями ---
  appTrackerStart: () => req<{ ok: boolean; error?: string }>("POST", "/apptracker/start"),
  appTrackerStop: () => req<{ ok: boolean }>("POST", "/apptracker/stop"),
  appTrackerStatus: () => req<{ tracking: boolean }>("GET", "/apptracker/status"),
  appTrackerToday: () => req<AppTimeToday>("GET", "/apptracker/today"),
  appTrackerHistory: (days: number) =>
    req<AppTimeHistoryDay[]>("GET", `/apptracker/history?days=${days}`),

  // --- Диспетчер фоновых задач (компрессия/апскейл/озвучка/лекции/архив) ---
  // Названы bgTasks*, а не tasks* — это имя уже занято тудушками MySpace выше
  // (api.tasksList/тип TaskItem — заметки-задачи, не имеют отношения к фоновым
  // job'ам движков).
  bgTasksList: () => req<{ tasks: TmTask[] }>("GET", "/tasks"),
  bgTasksCancel: (engine: string, id: string) =>
    req<{ ok: boolean }>("POST", `/tasks/${engine}/${encodeURIComponent(id)}/cancel`),
  bgTasksPause: (engine: string, id: string) =>
    req<{ ok: boolean }>("POST", `/tasks/${engine}/${encodeURIComponent(id)}/pause`),
  bgTasksResume: (engine: string, id: string) =>
    req<{ ok: boolean }>("POST", `/tasks/${engine}/${encodeURIComponent(id)}/resume`),
};

/**
 * Выделено из client.ts при разбиении крупного файла (поведение не менялось).
 */
import { req, multipart, tokenHeaders, pageHeaders, BASE } from "@/api/apiHttp";

/** След решения («Мышление»): контекст «почему я так решил» и позднейшая оценка. */
export interface MindTrace {
  id: string;
  kind: "note" | "expense";
  ref: string;
  title: string;
  decision: string;
  reason: string;
  context: { kind: string; title: string; text: string }[];
  createdAt: number;
  reviewAt: number;
  verdict: "right" | "partly" | "wrong" | null;
  reviewNote: string;
}
import type {
  AppItem,
  GameEntry,
  GameBenchRun,
  BudgetInsights,
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
  RecurringPayment,
  RecurringInput,
  UpcomingPayment,
  BudgetForecast,
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
  gamesInsights: () =>
    req<{
      items: {
        id: string;
        name: string;
        status: "backlog" | "playing" | "done" | "dropped";
        playSeconds: number;
        createdAt: number;
      }[];
    }>("GET", "/games/insights"),
  gamesRecommend: (gpu: string, fps: number, height: number, vram?: number) =>
    req<{
      preset: "low" | "medium" | "high" | "ultra";
      renderScale: number;
      upscaler: "none" | "quality" | "balanced" | "performance";
      frameGen: boolean;
      notes: string[];
    }>(
      "GET",
      `/games/recommend?gpu=${encodeURIComponent(gpu)}&fps=${fps}&height=${height}${vram ? `&vram=${vram}` : ""}`,
    ),
  gamesBenchList: (gameId?: string) =>
    req<{ runs: GameBenchRun[] }>("GET", `/games/bench${gameId ? `?gameId=${gameId}` : ""}`),
  gamesBenchAdd: (gameId: string, label: string, csv: string) =>
    req<GameBenchRun>("POST", "/games/bench", { gameId, label, csv }),
  gamesBenchDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/games/bench/${id}`),
  gamesBenchCompare: (before: string, after: string) =>
    req<{
      before: GameBenchRun;
      after: GameBenchRun;
      diff: {
        avgFpsDelta: number;
        avgFpsPct: number;
        p1LowDelta: number;
        p1LowPct: number;
        verdict: "better" | "worse" | "same";
      };
    }>("GET", `/games/bench/compare?before=${before}&after=${after}`),
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
  automationRules: () =>
    req<{
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        folder: string;
        createdAt: number;
        steps: {
          id: string;
          type: "if" | "move" | "copy" | "rename" | "zip";
          params: Record<string, string>;
        }[];
      }[];
      log: {
        at: number;
        ruleId: string;
        ruleName: string;
        file: string;
        ok: boolean;
        completed: boolean;
        message: string;
      }[];
    }>("GET", "/automation-rules"),
  automationRuleSave: (rule: unknown) =>
    req<{
      id: string;
      name: string;
      enabled: boolean;
      folder: string;
      createdAt: number;
      steps: {
        id: string;
        type: "if" | "move" | "copy" | "rename" | "zip";
        params: Record<string, string>;
      }[];
    }>("POST", "/automation-rules", rule),
  automationRuleDelete: (id: string) =>
    req<{ ok: boolean }>("DELETE", `/automation-rules/${id}`),
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
  budgetInsights: (q: { currency?: string; payday?: string; available?: number; monthA?: string; monthB?: string }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    return req<BudgetInsights>("GET", `/budget/insights?${p.toString()}`);
  },
  clipboardHistory: (q = "") =>
    req<{ items: { id: string; text: string; at: number; pinned: boolean }[] }>(
      "GET",
      `/clipboard-history?q=${encodeURIComponent(q)}`,
    ),
  clipboardPin: (id: string, pinned: boolean) =>
    req("POST", `/clipboard-history/${encodeURIComponent(id)}/pin`, { pinned }),
  clipboardDelete: (id: string) => req("DELETE", `/clipboard-history/${encodeURIComponent(id)}`),
  clipboardClear: () => req("DELETE", "/clipboard-history"),
  folderVersions: (folder: string) =>
    req<{ items: { id: string; at: number; files: number; bytes: number; label: string }[] }>(
      "GET",
      `/folder-versions?folder=${encodeURIComponent(folder)}`,
    ),
  folderVersionCreate: (folder: string, label = "") =>
    req<{ id: string }>("POST", "/folder-versions", { folder, label }),
  folderVersionRestore: (folder: string, id: string) =>
    req<{ path: string }>("POST", "/folder-versions/restore", { folder, id }),
  folderVersionDelete: (folder: string, id: string) =>
    req("DELETE", "/folder-versions", { folder, id }),
  appModes: () => req<{ modes: { id: string }[]; active: string | null }>("GET", "/app-modes"),
  appModeActivate: (id: string) =>
    req<{ active: string | null; settings: unknown }>("POST", "/app-modes/activate", { id }),
  appModeDeactivate: () =>
    req<{ active: string | null; settings: unknown }>("POST", "/app-modes/deactivate", {}),
  contextMenuStatus: () =>
    req<{ supported: boolean; installed: boolean }>("GET", "/context-menu"),
  contextMenuInstall: (labels: { note: string; folder: string }) =>
    req<{ installed: boolean }>("POST", "/context-menu/install", { labels }),
  contextMenuRemove: () => req<{ installed: boolean }>("DELETE", "/context-menu"),
  plugins: () =>
    req<{ items: { id: string; name: string; version: string; skills: number; templates: number }[] }>(
      "GET",
      "/plugins",
    ),
  pluginInstall: (manifest: unknown) =>
    req<{ id: string; name: string }>("POST", "/plugins", { manifest }),
  pluginRemove: (id: string) => req("DELETE", `/plugins/${encodeURIComponent(id)}`),
  p2pStatus: () =>
    req<{ listening: boolean; port: number | null; addresses: string[]; key: string | null }>(
      "GET",
      "/p2p",
    ),
  p2pEnable: () =>
    req<{ listening: boolean; port: number | null; addresses: string[]; key: string | null }>(
      "POST",
      "/p2p/enable",
      {},
    ),
  p2pDisable: () =>
    req<{ listening: boolean; port: number | null; addresses: string[]; key: string | null }>(
      "POST",
      "/p2p/disable",
      {},
    ),
  p2pRotateKey: () =>
    req<{ listening: boolean; port: number | null; addresses: string[]; key: string | null }>(
      "POST",
      "/p2p/rotate-key",
      {},
    ),
  p2pSync: (host: string, port: number, key: string) =>
    req<{ pulled: number; pushed: number; conflicts: number; same: number; failed: string[] }>(
      "POST",
      "/p2p/sync",
      { host, port, key },
    ),
  pcPassportFile: async (anonymize: boolean): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/diagnostics/passport.md${anonymize ? "?anonymize=1" : ""}`, {
      headers: { ...tokenHeaders(), ...pageHeaders() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },
  slowdownStart: (seconds = 30) => req<{ id: string }>("POST", "/diagnostics/slowdown", { seconds }),
  slowdownStatus: (id: string) =>
    req<{
      running: boolean;
      elapsed: number;
      seconds: number;
      samples: number;
      error: string;
      verdict: {
        main: "cpu" | "disk" | "memory" | "none";
        findings: { cause: "cpu" | "disk" | "memory"; severity: "low" | "medium" | "high"; value: number; why: string | null }[];
        culprits: { name: string; avgCpu: number; peakCpu: number; avgIoMbs: number; memMb: number; peakAt: number }[];
        avg: { cpu: number; diskPct: number; memAvailMb: number; diskQueue: number };
        peak: { cpu: number; cpuAt: number; diskPct: number; diskAt: number };
        samples: number;
        seconds: number;
      } | null;
    }>("GET", `/diagnostics/slowdown/${encodeURIComponent(id)}`),
  pcPassport: () =>
    req<{
      data: { generatedAt: number };
      changes: { at: number; kind: string; text: string }[];
      stale: { cls: string; name: string; version: string; date: string }[];
      markdown: string;
    }>("GET", "/diagnostics/passport"),
  montageBuild: (query: string, maxSeconds = 600, order: "relevance" | "chronological" = "relevance") =>
    req<{
      id: string | null;
      seconds: number;
      clips: { title: string; ref: string; startMs: number; endMs: number; snippet: string }[];
      captions: { at: string; title: string; from: string; snippet: string }[];
    }>("POST", "/montage", { query, maxSeconds, order }),
  scanPhotoTasks: async (file: File, createTasks = true) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("createTasks", createTasks ? "1" : "0");
    return multipart<{
      imageUrl: string;
      text: string;
      confidence: number;
      checklist: { title: string; items: { text: string; done: boolean; important: boolean }[]; dropped: number };
      note: string;
      tasks: number;
    }>("/scan/photo-tasks", fd);
  },
  scanPdf: async (files: File[], title = "") => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    if (title) fd.append("title", title);
    return multipart<{ file: string; pages: number; chars: number; note: string | null }>("/scan/pdf", fd);
  },
  scanList: () => req<{ items: { name: string; size: number; at: number }[] }>("GET", "/scan/list"),
  selfContracts: () =>
    req<{
      items: {
        contract: { id: string; label: string; metric: string; target: string; limit: number };
        value: number;
        ratio: number;
        status: "ok" | "near" | "over";
        unit: "min" | "money";
      }[];
    }>("GET", "/self-contracts"),
  selfContractCreate: (b: { label: string; metric: string; target: string; limit: number }) =>
    req<{ id: string }>("POST", "/self-contracts", b),
  selfContractDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/self-contracts/${encodeURIComponent(id)}`),
  mindContradictions: (path: string, text: string) =>
    req<{
      claims: number;
      model: "ok" | "failed" | "skipped";
      findings: { claim: string; source: string; ref: string; passage: string; why: string; by: "model" | "heuristic" }[];
    }>("POST", "/mind/contradictions", { path, text }),
  mindReview: (text: string, focus: "general" | "evidence" | "audience" | "logic" = "general") =>
    req<{ questions: { quote: string; question: string }[] }>("POST", "/mind/review", { text, focus }),
  mindConfidenceSync: (path?: string, text?: string) =>
    req<{ added: number; total: number }>("POST", "/mind/confidence/sync", { path, text }),
  mindConfidence: () =>
    req<{
      entries: { id: string; path: string; claim: string; pct: number; due: string; outcome: boolean | null }[];
      due: { id: string; path: string; claim: string; pct: number; due: string; outcome: boolean | null }[];
      calibration: {
        resolved: number;
        brier: number | null;
        bias: number | null;
        buckets: { from: number; to: number; n: number; predicted: number; actual: number }[];
      };
    }>("GET", "/mind/confidence"),
  mindConfidenceResolve: (id: string, outcome: boolean) =>
    req<{ ok: boolean }>("POST", `/mind/confidence/${encodeURIComponent(id)}/resolve`, { outcome }),
  mindProvenanceRecord: (path: string, text: string, origin: "copied" | "ai") =>
    req<{ ok: boolean }>("POST", "/mind/provenance/record", { path, text, origin }),
  mindProvenanceClassify: (path: string, text: string) =>
    req<{
      paragraphs: { start: number; end: number; words: number; origin: "own" | "copied" | "ai" }[];
      summary: { own: number; copied: number; ai: number; pct: { own: number; copied: number; ai: number } };
    }>("POST", "/mind/provenance/classify", { path, text }),
  mindTraces: () =>
    req<{
      items: MindTrace[];
      due: MindTrace[];
      track: { reviewed: number; right: number; partly: number; wrong: number; score: number | null };
    }>("GET", "/mind/traces"),
  mindTraceCreate: (b: {
    kind: "note" | "expense";
    ref: string;
    title: string;
    decision: string;
    reason?: string;
    reviewInDays?: number;
  }) => req<MindTrace>("POST", "/mind/traces", b),
  mindTraceUpdate: (id: string, patch: { reason?: string; reviewInDays?: number }) =>
    req<{ ok: boolean }>("PATCH", `/mind/traces/${encodeURIComponent(id)}`, patch),
  mindTraceReview: (id: string, verdict: "right" | "partly" | "wrong", note = "") =>
    req<{ ok: boolean }>("POST", `/mind/traces/${encodeURIComponent(id)}/review`, { verdict, note }),
  mindTraceDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/mind/traces/${encodeURIComponent(id)}`),
  gaps: () =>
    req<{
      notes: number;
      topics: { term: string; docs: number }[];
      dangling: { target: string; mentions: number; from: string[] }[];
    }>("GET", "/gaps"),
  gapsSuggest: (topic: string) =>
    req<{ topic: string; covered: number; items: { topic: string; docs: number; gap: boolean }[] }>(
      "POST",
      "/gaps/suggest",
      { topic },
    ),
  drift: (months = 12) =>
    req<{
      docs: number;
      topOverall: string | null;
      persistent: string[];
      biggestShift: { month: string; shift: number } | null;
      months: {
        month: string;
        docs: number;
        bySource: Record<string, number>;
        top: { term: string; score: number }[];
        emerging: string[];
        fading: string[];
        shift: number | null;
      }[];
    }>("GET", `/drift?months=${months}`),
  attentionWeek: (end?: string) =>
    req<{
      week: {
        from: string;
        to: string;
        maxAppSec: number;
        days: {
          date: string;
          activeHours: number;
          sleep: { from: number; to: number; hours: number } | null;
          cells: { appSec: number; topApp: string; lectureSec: number; tasks: number }[];
        }[];
      };
      facts: {
        avgActiveHours: number;
        peakHour: number | null;
        eveningShare: number;
        lateNightDays: number;
        avgSleepHours: number | null;
        longestStreakHours: number;
        lectureHours: number;
        tasksDone: number;
      };
      insights: string[];
      hasData: boolean;
    }>("GET", `/attention/week${end ? `?end=${encodeURIComponent(end)}` : ""}`),
  attentionAsk: (question: string) =>
    req<{ answer: string }>("POST", "/attention/ask", { question }),
  voiceVaultSearch: (q: string, limit = 12) =>
    req<{
      items: {
        kind: "lecture" | "quick";
        ref: string;
        title: string;
        snippet: string;
        score: number;
        startMs: number;
        endMs: number;
        chunkIds: number[];
        audioUrl: string | null;
      }[];
    }>("GET", `/voice-vault/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  examBuild: (lectureId: number, conspectus = false) =>
    req<{ conspectus: boolean; cards: number; quiz: number }>("POST", `/exam/${lectureId}/build`, {
      conspectus,
    }),
  examDeck: (lectureId: number) =>
    req<{
      cards: { id: string; q: string; a: string; topic: string; ms: number; due: number }[];
      quiz: { q: string; options: string[]; answer: number; topic: string; ms: number }[];
      lastResult: {
        total: number;
        correct: number;
        percent: number;
        weak: { topic: string; wrong: number; of: number; ms: number }[];
        wrongIdx: number[];
      } | null;
    }>("GET", `/exam/${lectureId}`),
  examDue: (lectureId?: number, limit = 20) =>
    req<{
      items: {
        id: string;
        lectureId: number;
        q: string;
        a: string;
        topic: string;
        ms: number;
        intervals: Record<1 | 2 | 3 | 4, number>;
      }[];
    }>("GET", `/exam/due?limit=${limit}${lectureId !== undefined ? `&lectureId=${lectureId}` : ""}`),
  examReview: (cardId: string, grade: 1 | 2 | 3 | 4) =>
    req<{ card: { id: string; due: number } }>("POST", "/exam/review", { cardId, grade }),
  examSubmitQuiz: (lectureId: number, answers: number[]) =>
    req<{
      total: number;
      correct: number;
      percent: number;
      weak: { topic: string; wrong: number; of: number; ms: number }[];
      wrongIdx: number[];
    }>("POST", `/exam/${lectureId}/quiz`, { answers }),
  examStats: () =>
    req<{
      total: number;
      due: number;
      fresh: number;
      learned: number;
      schedule: { date: string; count: number }[];
    }>("GET", "/exam/stats"),
  timeMachineRange: () => req<{ from: string; to: string; commits: number }>("GET", "/time-machine/range"),
  timeMachineState: (date: string) =>
    req<{
      date: string;
      snapshot: { oid: string; at: number; message: string } | null;
      notes: { path: string; title: string }[];
      notesTotal: number;
      boards: { path: string; title: string }[];
      tasks: {
        open: number;
        done: number;
        items: { id: string; title: string; status: "open" | "done"; dueDate: string | null }[];
      };
      budget: {
        count: number;
        income: number;
        expense: number;
        balance: number;
        monthByCategory: { category: string; amount: number }[];
      };
      diary: { content: string } | null;
    }>("GET", `/time-machine/state?date=${encodeURIComponent(date)}`),
  timeMachineFile: (oid: string, path: string) =>
    req<{ path: string; text: string }>(
      "GET",
      `/time-machine/file?oid=${encodeURIComponent(oid)}&path=${encodeURIComponent(path)}`,
    ),
  timeMachineRestore: (oid: string, path: string, date: string) =>
    req<{ ok: boolean; path: string }>("POST", "/time-machine/restore", { oid, path, date }),
  timeMachineSnapshot: () =>
    req<{ committed: boolean; oid?: string }>("POST", "/time-machine/snapshot", {}),
  ghostActive: () => req<{ title: string; process: string }>("GET", "/ghost/active"),
  ghostContext: (title: string, text: string, exclude?: { source: string; ref: string }) =>
    req<{
      query: string;
      groups: {
        source: string;
        items: { source: string; ref: string; title: string; snippet: string; score: number; at?: number }[];
      }[];
    }>("POST", "/ghost/context", { title, text, exclude }),
  aiShieldAudit: (limit = 100) =>
    req<{
      items: {
        at: number;
        provider: string;
        model: string;
        local: boolean;
        messages: number;
        chars: number;
        images: number;
        hidden: Record<string, number>;
        preview: string;
      }[];
      summary: {
        total: number;
        cloud: number;
        local: number;
        chars: number;
        hidden: number;
        byProvider: { provider: string; requests: number; chars: number; hidden: number; local: boolean }[];
      };
    }>("GET", `/ai-shield/audit?limit=${limit}`),
  aiShieldClear: () => req<{ ok: boolean }>("DELETE", "/ai-shield/audit"),
  aiShieldPreview: (text: string) =>
    req<{ text: string; found: Record<string, number> }>("POST", "/ai-shield/preview", { text }),
  budgetHours: (o: { currency?: string; month?: string; monthlyIncome?: number; workHours?: number }) =>
    req<{
      rates: {
        monthlyIncome: number;
        workHoursPerMonth: number;
        perWorkHour: number;
        perLifeHour: number;
        basedOnMonths: number;
      };
      month: string;
      totalExpense: number;
      totalWorkHours: number;
      byCategory: { category: string; amount: number; workHours: number }[];
      top: {
        date: string;
        note: string;
        category: string;
        amount: number;
        workHours: number;
        lifeHours: number;
      }[];
    }>(
      "GET",
      "/budget/hours?" +
        Object.entries(o)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join("&"),
    ),
  budgetSavingForecast: (o: { currency?: string; target: number; have?: number; date?: string }) =>
    req<{
      monthlySaving: number;
      monthsUsed: number;
      remaining: number;
      monthsNeeded: number | null;
      reachedOn: string | null;
      byDate?: { date: string; monthsLeft: number; requiredPerMonth: number; feasible: boolean };
    }>(
      "GET",
      "/budget/saving-forecast?" +
        Object.entries(o)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join("&"),
    ),
  budgetTaxDeductions: (currency = "RUB") =>
    req<{
      limit: number;
      rate: number;
      years: {
        year: number;
        byKind: { medicine: number; education: number; sport: number };
        total: number;
        eligible: number;
        refund: number;
        overLimit: number;
      }[];
    }>("GET", `/budget/tax-deductions?currency=${encodeURIComponent(currency)}`),
  budgetWhatIf: (cut: Record<string, number>, currency = "RUB") =>
    req<{ perMonth: number; perYear: number; byCategory: { category: string; perMonth: number }[] }>(
      "POST",
      "/budget/what-if",
      { cut, currency },
    ),
  budgetParseReceipt: (text: string) =>
    req<{
      merchant: string;
      date: string;
      total: number | null;
      mismatch: number | null;
      items: { name: string; amount: number; category: string }[];
    }>("POST", "/budget/receipt-parse", { text }),
  budgetCategories: () => req<BudgetCategories>("GET", "/budget/categories"),
  budgetCurrencies: () => req<string[]>("GET", "/budget/currencies"),
  budgetImportCsv: (csv: string) => req<BudgetImportResult>("POST", "/budget/import", { csv }),
  budgetImportOfx: (ofx: string) => req<BudgetImportResult>("POST", "/budget/import-ofx", { ofx }),
  budgetRecurringList: () => req<RecurringPayment[]>("GET", "/budget/recurring"),
  budgetRecurringCreate: (payload: RecurringInput) =>
    req<RecurringPayment>("POST", "/budget/recurring", payload),
  budgetRecurringToggle: (id: string, active: boolean) =>
    req<RecurringPayment>("PATCH", `/budget/recurring/${id}`, { active }),
  budgetRecurringDelete: (id: string) =>
    req<{ ok: boolean }>("DELETE", `/budget/recurring/${id}`),
  budgetUpcoming: (days = 30) =>
    req<UpcomingPayment[]>("GET", `/budget/recurring/upcoming?days=${days}`),
  budgetRecurringPay: (id: string) => req<Transaction>("POST", `/budget/recurring/${id}/pay`),
  budgetForecast: (currency = "RUB") =>
    req<BudgetForecast>("GET", `/budget/forecast?currency=${currency}`),

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
  netWifiAnalyze: () =>
    req<{
      ok: boolean;
      nets: { ssid: string; signal: number; channel: number | null; band: string | null }[];
      channels: { channel: number; networks: number; interference: number }[];
      recommended: number | null;
      error?: string;
    }>("GET", "/nettools/wifi/analyze"),
  netDns: () =>
    req<{ servers: { ip: string; kind: string; provider: string | null }[] }>(
      "GET",
      "/nettools/dns",
    ),
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

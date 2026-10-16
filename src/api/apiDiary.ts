/**
 * API дневника (server/ts/routes/diary.ts).
 */
import { req } from "@/api/apiHttp";
import type {
  DiaryEntry,
  DiaryListItem,
  DigestLabels as DiaryLabels,
  SavedWeekSummary as DiarySavedSummary,
  WeekSummaryResult as DiaryWeekSummary,
} from "@contracts/diary";

export type { DiaryEntry, DiaryListItem, DiaryLabels, DiaryWeekSummary, DiarySavedSummary };

export const diaryApi = {
  diaryEntries: (from?: string, to?: string) =>
    req<{ items: DiaryListItem[]; streak: number }>(
      "GET",
      `/diary/entries?from=${from ?? ""}&to=${to ?? ""}`,
    ),
  diaryGet: (date: string) => req<DiaryEntry>("GET", `/diary/entry/${date}`),
  diarySave: (date: string, content: string) =>
    req<DiaryEntry>("PUT", `/diary/entry/${date}`, { content }),
  diaryTemplate: () => req<{ template: string | null }>("GET", "/diary/template"),
  diarySaveTemplate: (template: string) =>
    req<{ template: string | null }>("PUT", "/diary/template", { template }),
  diarySummary: (date: string) => req<DiarySavedSummary>("GET", `/diary/summary/${date}`),
  diarySaveSummary: (date: string, markdown: string) =>
    req<DiarySavedSummary>("PUT", `/diary/summary/${date}`, { markdown }),
  diaryDaySummary: (date: string) => req<DiarySavedSummary>("GET", `/diary/day-summary/${date}`),
  diarySaveDaySummary: (
    date: string,
    markdown: string,
    meta: { ai?: boolean; provider?: string; model?: string } = {},
  ) => req<DiarySavedSummary>("PUT", `/diary/day-summary/${date}`, { markdown, ...meta }),
  diaryDeleteDaySummary: (date: string) =>
    req<{ ok: boolean }>("DELETE", `/diary/day-summary/${date}`),
  diaryWeekSummary: (date: string, language: string, labels: DiaryLabels) =>
    req<DiaryWeekSummary>("POST", "/diary/week-summary", { date, language, labels }),
};

/** Семантический поиск (EmbeddingGemma через llama.cpp). Сервер: server/ts/routes/semantic.ts. */
import { req } from "@/api/apiHttp";

export type SemSource = "note" | "bookmark";

export interface SemHit {
  source: SemSource;
  ref: string;
  title: string;
  snippet: string;
  score: number;
}
export interface SemJob {
  running: boolean;
  done: number;
  total: number;
  error: string;
  startedAt: number;
}
export interface SemStatus {
  model: string | null;
  indexed: { note: number; bookmark: number };
  chunks: number;
  job: SemJob;
}
export interface SemDup {
  a: { ref: string; title: string };
  b: { ref: string; title: string };
  score: number;
}
export interface SemCluster {
  refs: { ref: string; title: string }[];
}
export interface SemSuggest {
  tags: string[];
  folder: string;
  near: SemHit[];
}

const q = (o: Record<string, string | number | undefined>): string =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export const semanticApi = {
  semStatus: () => req<SemStatus>("GET", "/semantic/status"),
  semSync: () => req<SemJob>("POST", "/semantic/sync"),
  semSearch: (query: string, sources?: SemSource[], limit = 12) =>
    req<SemHit[]>("GET", `/semantic/search?${q({ q: query, sources: sources?.join(","), limit })}`),
  semRelated: (source: SemSource, ref: string, limit = 6) =>
    req<SemHit[]>("GET", `/semantic/related?${q({ source, ref, limit })}`),
  semLinks: (text: string, exclude: string) =>
    req<SemHit[]>("GET", `/semantic/links?${q({ q: text, exclude })}`),
  semSuggest: (ref: string) => req<SemSuggest>("GET", `/semantic/suggest?${q({ ref })}`),
  semDuplicates: (source: SemSource) =>
    req<SemDup[]>("GET", `/semantic/duplicates?${q({ source })}`),
  semClusters: (source: SemSource) =>
    req<SemCluster[]>("GET", `/semantic/clusters?${q({ source })}`),
  semSimilarBookmarks: (title: string, url: string) =>
    req<SemHit[]>("GET", `/semantic/bookmarks/similar?${q({ title, url })}`),
};

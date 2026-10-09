/** Семантический поиск (EmbeddingGemma через llama.cpp). Сервер: server/ts/routes/semantic.ts. */
import { req } from "@/api/apiHttp";

export type SemSource =
  | "note"
  | "bookmark"
  | "lecture"
  | "chat"
  | "task"
  | "canvas"
  | "quick"
  | "budget"
  | "movie"
  | "book"
  | "m3e"
  | "archive";

export interface SemHit {
  source: SemSource;
  ref: string;
  title: string;
  snippet: string;
  score: number;
  /** Метка внутри источника (лекция — мс от начала). */
  at?: number;
}
export interface SemJob {
  running: boolean;
  done: number;
  total: number;
  error: string;
  startedAt: number;
}
export interface SemStatus {
  enabled: boolean;
  device: "cpu" | "gpu" | "auto";
  model: string | null;
  models: string[];
  runtime: { file: string; gpu: boolean; build: string } | null;
  indexed: Record<string, number>;
  chunks: number;
  job: SemJob;
}
export interface SemConfig {
  enabled: boolean;
  model: string;
  device: "cpu" | "gpu" | "auto";
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

const q_ = (o: Record<string, string | number | undefined>): string =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export const semanticApi = {
  semStatus: () => req<SemStatus>("GET", "/semantic/status"),
  semConfig: (patch: Partial<SemConfig>) => req<SemConfig>("POST", "/semantic/config", patch),
  semUnload: () => req<{ ok: boolean }>("POST", "/semantic/unload"),
  semSync: () => req<SemJob>("POST", "/semantic/sync"),
  semSearch: (query: string, sources?: SemSource[], limit = 12) =>
    req<SemHit[]>(
      "GET",
      `/semantic/search?${q_({ q: query, sources: sources?.join(","), limit })}`,
    ),
  semRelated: (source: SemSource, ref: string, limit = 6) =>
    req<SemHit[]>("GET", `/semantic/related?${q_({ source, ref, limit })}`),
  semLinks: (text: string, exclude: string) =>
    req<SemHit[]>("GET", `/semantic/links?${q_({ q: text, exclude })}`),
  semSuggest: (ref: string) => req<SemSuggest>("GET", `/semantic/suggest?${q_({ ref })}`),
  semDuplicates: (source: SemSource) =>
    req<SemDup[]>("GET", `/semantic/duplicates?${q_({ source })}`),
  semClusters: (source: SemSource) =>
    req<SemCluster[]>("GET", `/semantic/clusters?${q_({ source })}`),
  semGroup: (texts: string[], threshold = 0.7) =>
    req<number[][]>("POST", "/semantic/group", { texts, threshold }),
  semClassify: (q: string) =>
    req<{ category: string; score: number }[]>("GET", `/semantic/classify?${q_({ q })}`),
  semNotesFor: (text: string, limit = 5) =>
    req<SemHit[]>("GET", `/semantic/notes-for?${q_({ q: text, limit })}`),
  semRank: (query: string, texts: string[]) =>
    req<number[]>("POST", "/semantic/rank", { query, texts }),
  semTaskMeta: (text: string) =>
    req<{ project: string; tags: string[] }>("GET", `/semantic/task-meta?${q_({ q: text })}`),
  semMovieReco: () =>
    req<{ ref: string; title: string; score: number }[]>("GET", "/semantic/movies/recommend"),
  semBooksSimilar: (
    books: { bid: number; title: string; author: string; genres: string[]; description: string }[],
  ) =>
    req<{ bid: number; score: number; like: string }[]>("POST", "/semantic/books/similar", {
      books,
    }),
  semSimilarBookmarks: (title: string, url: string) =>
    req<SemHit[]>("GET", `/semantic/bookmarks/similar?${q_({ title, url })}`),
};

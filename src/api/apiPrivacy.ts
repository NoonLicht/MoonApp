/**
 * API вкладки «Приватность» (server/ts/routes/privacy.ts).
 */
import { req } from "@/api/apiHttp";

export type PrivacyCategory =
  "history" | "recent" | "cache" | "logs" | "usb" | "clipboard" | "network" | "browser";

export interface PrivacyItem {
  id: string;
  category: PrivacyCategory;
  risk: 0 | 1 | 2;
  admin: boolean;
}

export interface PrivacyHistoryEntry {
  at: number;
  ids: string[];
  removed: number;
  bytes: number;
  failed: string[];
}

export interface PrivacyOverview {
  platform: string;
  admin: boolean;
  items: PrivacyItem[];
  history: PrivacyHistoryEntry[];
}

export interface WipeOutcome {
  ok: boolean;
  removed: number;
  bytes: number;
  error?: string;
}

export interface WipeResult {
  results: Record<string, WipeOutcome>;
  removed: number;
  bytes: number;
  failed: string[];
}

export const privacyApi = {
  privacyOverview: () => req<PrivacyOverview>("GET", "/privacy/overview"),
  privacyWipe: (ids: string[]) => req<WipeResult>("POST", "/privacy/wipe", { ids }),
  privacyPanic: () => req<WipeResult>("POST", "/privacy/panic"),
};

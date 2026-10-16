/**
 * API отключаемых страниц (server/ts/routes/features.ts): профили и список страниц,
 * что остановится вместе со страницей и что останется ради других.
 */
import { req } from "@/api/apiHttp";

export interface FeaturePage {
  id: string;
  enabled: boolean;
  /** Страницу нельзя отключить («Настройки»). */
  locked: boolean;
  /** Серверные функции (префиксы роутов), которые остановятся вместе со страницей. */
  stops: string[];
  /** Функции страницы, которые останутся: ими пользуется ещё кто-то (`shell` — сама оболочка). */
  keeps: { prefix: string; by: string[] }[];
}

export interface FeaturesState {
  /** all | media | study | minimal | custom */
  profile: string;
  disabled: string[];
  pages: FeaturePage[];
  /** Профиль → какие страницы он оставляет включёнными. */
  profiles: Record<string, string[]>;
}

export const featuresApi = {
  features: () => req<FeaturesState>("GET", "/features"),
  /** Профиль целиком (`profile`) либо точный список отключённых страниц (`disabled`). */
  featuresSet: (body: { profile?: string; disabled?: string[] }) =>
    req<FeaturesState>("PUT", "/features", body),
};

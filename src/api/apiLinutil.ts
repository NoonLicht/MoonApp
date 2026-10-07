/**
 * API Linux-инструментов (server/ts/routes/linutil.ts, каталог — ChrisTitusTech/linutil, MIT).
 */
import { req } from "@/api/apiHttp";

export interface LinutilNode {
  id?: string;
  name: string;
  desc?: string;
  script?: string;
  tasks?: string;
  children?: LinutilNode[];
}

export interface LinutilTab {
  id: string;
  name: string;
  groups: LinutilNode[];
}

export interface LinutilOverview {
  tabs: LinutilTab[];
  terminal: string | null;
  distro: string;
}

export interface LinutilRunResult {
  ok: boolean;
  error?: string;
  terminal?: string;
}

export const linutilApi = {
  linutilOverview: () => req<LinutilOverview>("GET", "/linutil/overview"),
  linutilRun: (id: string) => req<LinutilRunResult>("POST", "/linutil/run", { id }),
};

/** M3E Canvas: набор страниц-проектов в «Моём пространстве». Сервер: server/ts/routes/m3e.ts. */
import { BASE, req, tokenHeaders, pageHeaders } from "@/api/apiHttp";

export interface M3ePageMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  screens: number;
  parts: number;
  pinned?: boolean;
  color?: string;
}
export interface M3eTrashMeta extends M3ePageMeta {
  deletedAt: number;
}
export interface M3eWorkbook {
  activeId: string | null;
  pages: M3ePageMeta[];
  trash: M3eTrashMeta[];
}
export interface M3ePatch {
  activeId?: string;
  order?: string[];
  pages?: Record<string, { pinned?: boolean; color?: string | null }>;
}

/** Документ идёт текстом: общий JSON-парсер сервера ограничен 2 МБ. */
async function text(
  method: string,
  url: string,
  body?: string,
  keepalive = false,
): Promise<Response> {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { ...tokenHeaders(), ...pageHeaders(), "Content-Type": "text/plain;charset=utf-8" },
    body,
    keepalive: keepalive && (body?.length ?? 0) < 60_000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

export const m3eApi = {
  m3eList: () => req<M3eWorkbook>("GET", "/m3e"),
  m3ePatch: (p: M3ePatch) => req<M3eWorkbook>("PATCH", "/m3e", p),
  m3eRead: async (id: string): Promise<string> => (await text("GET", `/m3e/pages/${id}`)).text(),
  m3eWrite: async (id: string, doc: string, keepalive = false): Promise<M3ePageMeta> =>
    (await text("PUT", `/m3e/pages/${id}`, doc, keepalive)).json() as Promise<M3ePageMeta>,
  m3eCreate: async (doc = "", after?: string): Promise<M3ePageMeta> =>
    (
      await text("POST", `/m3e/pages${after ? `?after=${after}` : ""}`, doc)
    ).json() as Promise<M3ePageMeta>,
  m3eDuplicate: (id: string, title: string) =>
    req<M3ePageMeta>("POST", `/m3e/pages/${id}/duplicate`, { title }),
  m3eDelete: (id: string) => req<M3eWorkbook>("DELETE", `/m3e/pages/${id}`),
  m3eRestore: (id: string) => req<M3eWorkbook>("POST", `/m3e/trash/${id}/restore`, {}),
  m3ePurge: (id: string) => req<M3eWorkbook>("DELETE", `/m3e/trash/${id}`),
};

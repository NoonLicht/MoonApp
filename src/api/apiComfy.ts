/**
 * API вкладки ComfyUI: управление установкой и процессом (server/ts/routes/comfy.ts) и клиент к самому
 * ComfyUI через прокси `/api/comfy/ui` (очередь, результаты, список узлов и моделей).
 */
import { BASE, pageHeaders, req, tokenHeaders } from "@/api/apiHttp";

export type ComfyFlavor = "nvidia" | "amd" | "intel";

export interface ComfySetupState {
  kind: string | null;
  state: "idle" | "working" | "done" | "error";
  id: string | null;
  progress: number;
  phase: string;
  error: string;
  received: number;
  total: number;
}

export interface ComfyStatus {
  supported: boolean;
  installed: boolean;
  flavor: ComfyFlavor | null;
  running: boolean;
  ready: boolean;
  port: number;
  gguf: boolean;
  error: string;
  log: string[];
  setup: ComfySetupState;
  flavors: { id: ComfyFlavor; sizeMb: number }[];
}

export interface ComfyModelFile {
  folder: string;
  file: string;
  sizeMb: number;
}
export interface ComfyRecommended {
  id: string;
  folder: string;
  repo: string;
  file: string;
  sizeMb: number;
  for: string[];
}
export interface ComfyDownload {
  status: "idle" | "downloading" | "done" | "error";
  file: string;
  index: number;
  count: number;
  bytes: number;
  total: number;
  error: string;
}
export interface ComfyModels {
  models: ComfyModelFile[];
  recommended: ComfyRecommended[];
  download: ComfyDownload;
}
export interface ComfyHf {
  repo: string;
  rev: string;
  file: string | null;
  files: { file: string; sizeMb: number }[];
}

/** Воркфлоу в API-формате: id узла → класс и входы. */
export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }>;

export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}
export interface ComfyHistoryItem {
  id: string;
  ok: boolean;
  status: string;
  images: ComfyImageRef[];
  prompt?: ComfyGraph;
}

const UI = "/api/comfy/ui";

async function ui<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${UI}${path}`, {
    method,
    headers: { ...tokenHeaders(), ...pageHeaders(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = (await r.json()) as { error?: string | { message?: string }; node_errors?: Record<string, unknown> };
      msg = typeof j.error === "string" ? j.error : (j.error?.message ?? msg);
      if (j.node_errors && Object.keys(j.node_errors).length) msg += `: ${JSON.stringify(j.node_errors).slice(0, 300)}`;
    } catch {
      /* не JSON */
    }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

export const comfyApi = {
  comfyStatus: () => req<ComfyStatus>("GET", "/comfy/status"),
  comfyInstall: (flavor: ComfyFlavor) => req<ComfySetupState>("POST", "/comfy/install", { flavor }),
  comfyInstallCancel: () => req<ComfySetupState>("POST", "/comfy/install/cancel"),
  comfyGgufNode: () => req<ComfySetupState>("POST", "/comfy/gguf-node"),
  comfyRemove: () => req<{ ok: boolean }>("DELETE", "/comfy/install"),
  comfyStart: (cpu = false) => req<ComfyStatus>("POST", "/comfy/start", { cpu }),
  comfyPrepare: () => req<{ ok: boolean }>("POST", "/comfy/prepare"),
  comfyStop: () => req<{ ok: boolean }>("POST", "/comfy/stop"),
  comfyModels: () => req<ComfyModels>("GET", "/comfy/models"),
  comfyHf: (url: string) => req<ComfyHf>("GET", `/comfy/hf?url=${encodeURIComponent(url)}`),
  comfyModelDownload: (body: { recommended?: string; repo?: string; rev?: string; folder?: string; files?: string[] }) =>
    req<ComfyDownload>("POST", "/comfy/models/download", body),
  comfyModelCancel: () => req<{ ok: boolean }>("POST", "/comfy/models/cancel"),
  comfyModelRemove: (folder: string, file: string) =>
    req<{ ok: boolean }>("DELETE", `/comfy/models?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}`),
  comfyWorkflows: () => req<{ workflows: { id: string; at: number }[] }>("GET", "/comfy/workflows"),
  comfyWorkflowGet: (id: string) => req<unknown>("GET", `/comfy/workflows/${encodeURIComponent(id)}`),
  comfyWorkflowSave: (id: string, wf: unknown) => req<{ ok: boolean }>("PUT", `/comfy/workflows/${encodeURIComponent(id)}`, wf),
  comfyWorkflowDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/comfy/workflows/${encodeURIComponent(id)}`),
  comfyAssist: (body: { request: string; current?: ComfyGraph; model?: string }) =>
    req<{ workflow: ComfyGraph; notes: string[]; attempts: number }>("POST", "/comfy/assist", body),

  // ── сам ComfyUI ──
  comfyObjectInfo: () => ui<Record<string, ComfyNodeInfo>>("GET", "/object_info"),
  /** Ставит граф в очередь, возвращает id задания. */
  comfySubmit: async (graph: ComfyGraph, clientId: string): Promise<string> => {
    const r = await ui<{ prompt_id: string }>("POST", "/prompt", { prompt: graph, client_id: clientId });
    return r.prompt_id;
  },
  comfyInterrupt: () => ui<unknown>("POST", "/interrupt", {}),
  comfyQueue: () => ui<{ queue_running: unknown[][]; queue_pending: unknown[][] }>("GET", "/queue"),
  comfyHistory: async (max = 40): Promise<ComfyHistoryItem[]> => {
    const h = await ui<Record<string, ComfyRawHistory>>("GET", `/history?max_items=${max}`);
    return Object.entries(h)
      .map(([id, v]) => toHistory(id, v))
      .reverse();
  },
  comfyHistoryOne: async (id: string): Promise<ComfyHistoryItem | null> => {
    const h = await ui<Record<string, ComfyRawHistory>>("GET", `/history/${encodeURIComponent(id)}`);
    return h[id] ? toHistory(id, h[id]) : null;
  },
  comfyImageUrl: (r: ComfyImageRef): string =>
    `${BASE}${UI}/view?${new URLSearchParams({ filename: r.filename, subfolder: r.subfolder, type: r.type })}`,
  comfyImageBlob: async (r: ComfyImageRef): Promise<Blob> => {
    const res = await fetch(`${BASE}${UI}/view?${new URLSearchParams({ filename: r.filename, subfolder: r.subfolder, type: r.type })}`, {
      headers: { ...tokenHeaders() },
    });
    if (!res.ok) throw new Error(`view_${res.status}`);
    return res.blob();
  },
  comfyUpload: async (file: File): Promise<string> => {
    const fd = new FormData();
    fd.append("image", file, file.name);
    fd.append("overwrite", "true");
    const res = await fetch(`${BASE}${UI}/upload/image`, { method: "POST", headers: { ...tokenHeaders() }, body: fd });
    if (!res.ok) throw new Error(`upload_${res.status}`);
    const j = (await res.json()) as { name: string; subfolder?: string };
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  },
};

export interface ComfyNodeInfo {
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
  output?: string[];
  display_name?: string;
  category?: string;
}

interface ComfyRawHistory {
  prompt?: unknown[];
  outputs?: Record<string, { images?: ComfyImageRef[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[][] };
}

function toHistory(id: string, v: ComfyRawHistory): ComfyHistoryItem {
  const images = Object.values(v.outputs ?? {}).flatMap((o) => o.images ?? []);
  const failed = v.status?.status_str === "error";
  return {
    id,
    ok: !failed && !!v.status?.completed,
    status: v.status?.status_str ?? "",
    images,
    prompt: (v.prompt?.[2] as ComfyGraph | undefined) ?? undefined,
  };
}

/** Прогресс выполнения по WebSocket ComfyUI: {value,max} и номер текущего узла. Ошибки сети тихо игнорируются. */
export function comfyWatch(
  clientId: string,
  on: (e: { type: string; data: Record<string, unknown> }) => void,
): () => void {
  let ws: WebSocket | null = null;
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}${UI}/ws?clientId=${encodeURIComponent(clientId)}`);
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      try {
        on(JSON.parse(m.data) as { type: string; data: Record<string, unknown> });
      } catch {
        /* не наше сообщение */
      }
    };
  } catch {
    /* без прогресса */
  }
  return () => {
    try {
      ws?.close();
    } catch {
      /* уже закрыт */
    }
  };
}

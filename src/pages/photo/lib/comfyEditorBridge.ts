/**
 * Связь с редактором ComfyUI во встроенной рамке. Рамка открыта с того же origin (прокси приложения),
 * поэтому объект `app` фронтенда ComfyUI доступен напрямую: через него графы загружаются, сохраняются
 * и превращаются в API-формат. Это и даёт полную совместимость: разбор любых воркфлоу, включая
 * чужие узлы, группы и подграфы, делает родной фронтенд ComfyUI, а не наш код.
 */
import type { ComfyGraph } from "@/api/apiComfy";

interface EditorApp {
  graph?: { serialize?: () => unknown; clear?: () => void };
  loadGraphData?: (data: unknown, clean?: boolean, restore?: boolean, name?: string | null) => Promise<void> | void;
  loadApiJson?: (data: unknown, name?: string) => Promise<void> | void;
  graphToPrompt?: () => Promise<{ workflow: unknown; output: ComfyGraph }>;
  handleFile?: (file: File) => Promise<void> | void;
}

export function editorApp(frame: HTMLIFrameElement | null): EditorApp | null {
  try {
    const w = frame?.contentWindow as (Window & { app?: EditorApp }) | null | undefined;
    return w?.app && typeof w.app.graphToPrompt === "function" ? w.app : null;
  } catch {
    return null;
  }
}

/** Ждёт, пока фронтенд ComfyUI загрузится в рамке (до `timeoutMs`). */
export async function waitEditor(frame: HTMLIFrameElement | null, timeoutMs = 60000): Promise<EditorApp | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const app = editorApp(frame);
    if (app?.graph) return app;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** Загружает воркфлоу любого вида: граф редактора или API-формат. */
export async function loadWorkflow(frame: HTMLIFrameElement | null, wf: unknown, name?: string): Promise<boolean> {
  const app = await waitEditor(frame);
  if (!app) return false;
  const isEditor = !!wf && typeof wf === "object" && Array.isArray((wf as { nodes?: unknown }).nodes);
  if (isEditor) await app.loadGraphData?.(wf, true, true, name ?? null);
  else await app.loadApiJson?.(wf, name);
  return true;
}

/** Текущий граф редактора в двух видах: для хранения (workflow) и для запуска (output). */
export async function readWorkflow(
  frame: HTMLIFrameElement | null,
): Promise<{ workflow: unknown; output: ComfyGraph } | null> {
  const app = editorApp(frame);
  if (!app?.graphToPrompt) return null;
  return app.graphToPrompt();
}

/** PNG/WebP/MP4/JSON с вшитым воркфлоу — как перетаскивание файла в окно ComfyUI. */
export async function loadFile(frame: HTMLIFrameElement | null, file: File): Promise<boolean> {
  const app = await waitEditor(frame);
  if (!app?.handleFile) return false;
  await app.handleFile(file);
  return true;
}

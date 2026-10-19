/**
 * Помощник по воркфлоу: локальная модель (Gemma 4 E4B/E2B и любая другая чат-модель llama.cpp)
 * собирает или правит граф ComfyUI в API-формате по описанию на обычном языке.
 *
 * Модель видит сжатый каталог узлов именно этой установки (из /object_info) с точными именами
 * установленных моделей, поэтому пишет рабочий граф, а не выдуманный. Результат проверяется
 * (все узлы существуют, обязательные входы заполнены, ссылки ведут на реальные узлы и выходы);
 * при ошибке модель получает список проблем и исправляет граф ещё раз.
 */
import { runTurn, type TurnMessage } from "../assistant/llm";
import { comfyPort, comfyReady, freeComfyGpu } from "./engine";

type Json = Record<string, unknown>;
export type ApiGraph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }>;

/** Узлы, которые стоит показать модели (остальное — в каталоге по ключевым словам запроса). */
const CORE = [
  "CheckpointLoaderSimple",
  "UNETLoader",
  "UnetLoaderGGUF",
  "CLIPLoader",
  "CLIPLoaderGGUF",
  "VAELoader",
  "LoraLoader",
  "CLIPTextEncode",
  "TextEncodeQwenImage21",
  "EmptyLatentImage",
  "EmptySD3LatentImage",
  "KSampler",
  "KSamplerSelect",
  "BasicScheduler",
  "ManualSigmas",
  "RandomNoise",
  "CFGGuider",
  "SamplerCustomAdvanced",
  "ModelSamplingAuraFlow",
  "FluxGuidance",
  "VAEDecode",
  "VAEEncode",
  "LoadImage",
  "ImageScale",
  "ImageScaleBy",
  "SaveImage",
  "PreviewImage",
  "UpscaleModelLoader",
  "ImageUpscaleWithModel",
  "LatentUpscaleBy",
  "SetLatentNoiseMask",
  "VAEEncodeForInpaint",
  "ControlNetLoader",
  "ControlNetApplyAdvanced",
];

async function objectInfo(): Promise<Record<string, Json>> {
  if (!comfyReady()) throw new Error("comfy_not_running");
  const r = await fetch(`http://127.0.0.1:${comfyPort()}/object_info`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`object_info_${r.status}`);
  return (await r.json()) as Record<string, Json>;
}

type InputDef = [unknown, Json?] | unknown;

const PRIMITIVE = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

/** Варианты выпадающего входа: старый вид — массив, новый (V3) — `["COMBO", {options}]`. */
function comboOptions(def: InputDef): string[] | null {
  const t = Array.isArray(def) ? def[0] : def;
  if (Array.isArray(t)) return t.map(String);
  const o = Array.isArray(def) ? (def[1] as Json | undefined)?.options : undefined;
  return t === "COMBO" && Array.isArray(o) ? o.map(String) : null;
}
/** Тип входа, который задаётся ссылкой на другой узел (а не значением). */
const isLinkType = (t: unknown): t is string =>
  typeof t === "string" && !PRIMITIVE.has(t) && !t.startsWith("COMFY_");

function typeOf(def: InputDef): string {
  const t = Array.isArray(def) ? def[0] : def;
  const list = comboOptions(def);
  if (list) {
    return `one of [${list.slice(0, 24).join(" | ")}${list.length > 24 ? " | …" : ""}]`;
  }
  if (isLinkType(t)) return `LINK ${t}`;
  const opts = Array.isArray(def) ? (def[1] as Json | undefined) : undefined;
  const bits: string[] = [];
  if (opts && "default" in opts && typeof opts.default !== "object") bits.push(`def ${String(opts.default)}`);
  if (opts && typeof opts.min === "number") bits.push(`${opts.min}..${String(opts.max ?? "")}`);
  return `${String(t)}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

function describe(name: string, info: Json): string {
  const inp = (info.input ?? {}) as { required?: Record<string, InputDef>; optional?: Record<string, InputDef> };
  const req = Object.entries(inp.required ?? {}).map(([k, v]) => `${k}: ${typeOf(v)}`);
  const opt = Object.entries(inp.optional ?? {}).map(([k, v]) => `${k}?: ${typeOf(v)}`);
  const outs = ((info.output as string[]) ?? []).map((o, i) => `${i}:${o}`).join(", ");
  return `${name}(${[...req, ...opt].join("; ")}) -> [${outs}]`;
}

/** Сжатый каталог узлов для запроса: основа плюс узлы, чьи имена совпали со словами запроса. */
export function catalogFor(info: Record<string, Json>, request: string, graph?: ApiGraph): string {
  const names = new Set(CORE.filter((n) => info[n]));
  for (const n of Object.values(graph ?? {})) if (info[n.class_type]) names.add(n.class_type);
  const words = request
    .toLowerCase()
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length > 3);
  if (words.length) {
    const extra = Object.keys(info)
      .filter((n) => words.some((w) => n.toLowerCase().includes(w)))
      .slice(0, 12);
    for (const n of extra) names.add(n);
  }
  return [...names].map((n) => describe(n, info[n])).join("\n");
}

const SYSTEM = `You are an expert in ComfyUI. You write workflows in ComfyUI API format.
Reply with ONE JSON object and nothing else (no markdown, no comments).
Format: {"1":{"class_type":"NodeName","inputs":{"param":value,"other":["3",0]}}, "2":{...}}
- Keys are node ids (strings). A link is ["<source node id>", <output index>].
- Plain values (text, numbers, model file names) are written directly. Use model file names EXACTLY as listed.
- Fill every required input. End the graph with SaveImage (or PreviewImage).
- Use only the nodes from the catalog. Prefer simple, correct graphs.
- If a current workflow is given, change only what the request asks and return the whole workflow.`;

function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const src = (fence ? fence[1] : text).trim();
  const a = src.indexOf("{");
  const b = src.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no_json");
  return JSON.parse(src.slice(a, b + 1));
}

/**
 * Небольшие модели часто пишут ссылку просто номером узла ("3") вместо ["3", 0]. Такие значения
 * чинятся сами: выход выбирается по типу, который ожидает вход.
 */
export function normalizeGraph(g: unknown, info: Record<string, Json>): void {
  if (!g || typeof g !== "object" || Array.isArray(g)) return;
  const nodes = g as ApiGraph;
  for (const n of Object.values(nodes)) {
    const def = n && typeof n.class_type === "string" ? info[n.class_type] : undefined;
    if (!def || !n.inputs || typeof n.inputs !== "object") continue;
    const inp = (def.input ?? {}) as { required?: Record<string, InputDef>; optional?: Record<string, InputDef> };
    const all = { ...(inp.optional ?? {}), ...(inp.required ?? {}) };
    for (const [k, v] of Object.entries(n.inputs)) {
      const d = all[k];
      const t = Array.isArray(d) ? d[0] : d;
      if (!isLinkType(t) || Array.isArray(v)) continue;
      const id = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/^node[\s_-]*/i, "") : "";
      const src = nodes[id];
      if (!src) continue;
      const outs = ((info[src.class_type]?.output as unknown[]) ?? []).map(String);
      const at = outs.indexOf(t);
      n.inputs[k] = [id, at >= 0 ? at : 0];
    }
  }
}

/** Проверка графа по каталогу узлов установки: список понятных замечаний (пусто — всё хорошо). */
export function validateGraph(g: unknown, info: Record<string, Json>): string[] {
  const errs: string[] = [];
  if (!g || typeof g !== "object" || Array.isArray(g)) return ["The workflow must be a JSON object of nodes."];
  const nodes = g as ApiGraph;
  const ids = Object.keys(nodes);
  if (!ids.length) return ["The workflow is empty."];
  for (const id of ids) {
    const n = nodes[id];
    if (!n || typeof n.class_type !== "string" || typeof n.inputs !== "object" || !n.inputs) {
      errs.push(`Node ${id}: needs class_type and inputs.`);
      continue;
    }
    const def = info[n.class_type];
    if (!def) {
      errs.push(`Node ${id}: unknown class_type "${n.class_type}".`);
      continue;
    }
    const inp = (def.input ?? {}) as { required?: Record<string, InputDef>; optional?: Record<string, InputDef> };
    for (const [k, rd] of Object.entries(inp.required ?? {}))
      if (!(k in n.inputs) && !String(Array.isArray(rd) ? rd[0] : rd).startsWith("COMFY_")) errs.push(`Node ${id} (${n.class_type}): missing required input "${k}".`);
    const all = { ...(inp.optional ?? {}), ...(inp.required ?? {}) };
    for (const [k, v] of Object.entries(n.inputs)) {
      const d = all[k];
      const t = Array.isArray(d) ? d[0] : d;
      const isLink = Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number");
      if (isLink) {
        const src = nodes[String(v[0])];
        if (!src) {
          errs.push(`Node ${id}: input "${k}" links to missing node ${String(v[0])}.`);
          continue;
        }
        const outs = (info[src.class_type]?.output as unknown[]) ?? [];
        if (outs.length && Number(v[1]) >= outs.length)
          errs.push(`Node ${id}: input "${k}" uses output ${String(v[1])} of node ${String(v[0])}, which has ${outs.length}.`);
        else if (isLinkType(t) && outs.length && String(outs[Number(v[1])]) !== t && t !== "*")
          errs.push(`Node ${id}: input "${k}" needs ${t} but node ${String(v[0])} output ${String(v[1])} is ${String(outs[Number(v[1])])}.`);
      } else if (isLinkType(t)) {
        errs.push(`Node ${id} (${n.class_type}): input "${k}" must be a link ["<node id>", <output index>] of type ${t}, not ${JSON.stringify(v)}.`);
      } else if (comboOptions(d) && !comboOptions(d)!.includes(String(v))) {
        const list = comboOptions(d)!;
        errs.push(`Node ${id} (${n.class_type}): input "${k}" value ${JSON.stringify(v)} is not one of [${list.slice(0, 12).join(", ")}${list.length > 12 ? ", …" : ""}].`);
      } else if ((t === "INT" || t === "FLOAT") && typeof v !== "number") {
        errs.push(`Node ${id} (${n.class_type}): input "${k}" must be a number.`);
      }
    }
  }
  const out = ids.some((id) => ["SaveImage", "PreviewImage", "SaveAnimatedWEBP", "SaveVideo", "SaveAnimatedPNG"].includes(nodes[id]?.class_type));
  if (!out) errs.push("There is no output node (add SaveImage).");
  return errs;
}

export async function assistWorkflow(o: {
  request: string;
  current?: ApiGraph;
  model?: string;
  signal?: AbortSignal;
}): Promise<{ workflow: ApiGraph; notes: string[]; attempts: number }> {
  const info = await objectInfo();
  await freeComfyGpu();
  const catalog = catalogFor(info, o.request, o.current);
  const msgs: TurnMessage[] = [
    { role: "system", content: `${SYSTEM}\n\nNode catalog of this installation:\n${catalog}` },
    {
      role: "user",
      content: `${o.current ? `Current workflow:\n${JSON.stringify(o.current)}\n\n` : ""}Request: ${o.request}`,
    },
  ];
  let last: ApiGraph | null = null;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await runTurn({ model: o.model, messages: msgs, maxTokens: 3000, temperature: 0.2, signal: o.signal });
    try {
      const g = extractJson(r.content);
      normalizeGraph(g, info);
      problems = validateGraph(g, info);
      last = g as ApiGraph;
      if (!problems.length) return { workflow: last, notes: [], attempts: attempt };
    } catch (e) {
      problems = [`Reply was not valid JSON (${(e as Error).message}).`];
    }
    msgs.push({ role: "assistant", content: r.content });
    msgs.push({
      role: "user",
      content: `Fix these problems and return the full corrected JSON only:\n${problems.slice(0, 12).join("\n")}`,
    });
  }
  if (last) return { workflow: last, notes: problems.slice(0, 12), attempts: 3 };
  throw new Error("assist_failed");
}

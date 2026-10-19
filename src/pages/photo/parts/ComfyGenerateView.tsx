import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Sparkles, X, Wand2, Pencil, Upload, Plus, Trash2 } from "lucide-react";
import { Glass, Btn, ProgressBar, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";
import {
  comfyWatch,
  type ComfyGraph,
  type ComfyHistoryItem,
  type ComfyNodeInfo,
} from "@/api/apiComfy";
import {
  buildGraph,
  choices,
  DEFAULTS,
  isApiGraph,
  isEditorGraph,
  missingNodes,
  PRESETS,
  type PresetDef,
  type PresetId,
  type PresetParams,
} from "@/pages/photo/lib/comfyPresets";

/** Какой узел и вход дают список файлов для поля формы. */
const SOURCES: Partial<Record<keyof PresetParams, [string, string][]>> = {
  ckpt: [["CheckpointLoaderSimple", "ckpt_name"]],
  unet: [
    ["UnetLoaderGGUF", "unet_name"],
    ["UNETLoader", "unet_name"],
  ],
  clip: [
    ["CLIPLoader", "clip_name"],
    ["CLIPLoaderGGUF", "clip_name"],
  ],
  vae: [["VAELoader", "vae_name"]],
  upscaler: [["UpscaleModelLoader", "model_name"]],
  sampler: [["KSampler", "sampler_name"]],
  scheduler: [["KSampler", "scheduler"]],
};

const NUMBERS: Partial<Record<keyof PresetParams, { min: number; max: number; step: number }>> = {
  width: { min: 256, max: 4096, step: 64 },
  height: { min: 256, max: 4096, step: 64 },
  steps: { min: 1, max: 150, step: 1 },
  cfg: { min: 0, max: 30, step: 0.5 },
  denoise: { min: 0, max: 1, step: 0.05 },
  batch: { min: 1, max: 8, step: 1 },
  seed: { min: -1, max: 2147483647, step: 1 },
  clipSkip: { min: 1, max: 12, step: 1 },
};

/** Файлы для поля формы из списков ComfyUI, без служебных (VAE в папке денойзеров, проекторы, встроенные taesd). */
function fieldOptions(info: Record<string, ComfyNodeInfo>, field: keyof PresetParams): string[] {
  const all = [...new Set((SOURCES[field] ?? []).flatMap(([n, i]) => choices(info, n, i)))];
  if (field === "unet") return all.filter((f) => !/vae/i.test(f));
  if (field === "clip") return all.filter((f) => !/mmproj/i.test(f));
  if (field === "vae") return all.filter((f) => /\.(safetensors|pt|sft)$/i.test(f));
  return all;
}

const newClientId = (): string => `moonapp-${Math.random().toString(36).slice(2, 12)}`;

export interface GenerateProps {
  info: Record<string, ComfyNodeInfo>;
  /** Открыть граф в редакторе. */
  openInEditor: (wf: unknown, name?: string) => void | Promise<void>;
  /** Превратить граф редактора в API-формат (если редактор открыт). */
  editorToApi: () => Promise<ComfyGraph | null>;
  /** Граф, присланный из библиотеки или помощника для запуска. */
  pending: ComfyGraph | null;
  onPendingUsed: () => void;
}

/** Быстрая генерация по пресетам, запуск готовых воркфлоу и история результатов. */
export default function GenerateView({
  info,
  openInEditor,
  editorToApi,
  pending,
  onPendingUsed,
}: GenerateProps) {
  const { t } = useI18n();
  const [presetId, setPresetId] = useState<PresetId>("txt2img");
  const preset: PresetDef = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const [params, setParams] = useState<PresetParams>({ ...DEFAULTS, ...PRESETS[0].defaults });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ value: number; max: number; node: string } | null>(
    null,
  );
  const [history, setHistory] = useState<ComfyHistoryItem[]>([]);
  const [view, setView] = useState<ComfyHistoryItem | null>(null);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [assistModel, setAssistModel] = useState("");
  const [chatModels, setChatModels] = useState<string[]>([]);
  const cancelled = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setHistory(await api.comfyHistory(30));
    } catch {
      /* ComfyUI ещё стартует */
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void api
      .llamaStatus()
      .then((s) =>
        setChatModels(
          s.models
            .map((m) => m.file)
            .filter((f) => !/embedding|mmproj|chandra|tts|translategemma|qwen-image/i.test(f)),
        ),
      )
      .catch(() => undefined);
  }, []);

  const pick = (id: PresetId): void => {
    const def = PRESETS.find((p) => p.id === id) ?? PRESETS[0];
    setPresetId(id);
    const ckptBased = def.id === "txt2img" || def.id === "img2img";
    setParams((p) => ({
      ...p,
      ...DEFAULTS,
      prompt: p.prompt,
      negative: p.negative,
      ...def.defaults,
      ckpt: p.ckpt,
      unet: p.unet,
      clip: p.clip,
      // У чекпоинта свой VAE: «из чекпоинта» (пусто) по умолчанию; у остальных нужен файл.
      vae: ckptBased ? "" : p.vae,
      upscaler: p.upscaler,
      loras: p.loras,
      clipDevice: p.clipDevice,
      vaeTiled: p.vaeTiled,
    }));
  };

  // Подставляем первый подходящий файл в пустые поля моделей и сэмплеров.
  useEffect(() => {
    setParams((p) => {
      const next = { ...p };
      for (const field of Object.keys(SOURCES) as (keyof PresetParams)[]) {
        // VAE у чекпоинтовых пресетов необязателен: пусто = встроенный в чекпоинт.
        if (field === "vae" && (presetId === "txt2img" || presetId === "img2img")) continue;
        const list = fieldOptions(info, field);
        const cur = String(next[field]);
        if (list.length && !list.includes(cur))
          (next as Record<string, unknown>)[field] = pickDefault(field, list, p);
      }
      return next;
    });
  }, [info, presetId]);

  const options = (field: keyof PresetParams): string[] => fieldOptions(info, field);
  const loraOptions = useMemo(
    () => [
      ...new Set([
        ...choices(info, "LoraLoader", "lora_name"),
        ...choices(info, "LoraLoaderModelOnly", "lora_name"),
      ]),
    ],
    [info],
  );
  const setLora = (i: number, patch: Partial<PresetParams["loras"][number]>): void =>
    setParams((p) => ({ ...p, loras: p.loras.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  const lacking = useMemo(() => missingNodes(preset, info), [preset, info]);
  const needModels = preset.models.filter((m) => options(m).length === 0);

  const set = <K extends keyof PresetParams>(k: K, v: PresetParams[K]): void =>
    setParams((p) => ({ ...p, [k]: v }));

  /** Запуск графа: очередь → прогресс по WebSocket → результат из истории. */
  const runGraph = useCallback(
    async (graph: ComfyGraph): Promise<void> => {
      setBusy(true);
      setError("");
      setProgress(null);
      cancelled.current = false;
      const clientId = newClientId();
      const stop = comfyWatch(clientId, (e) => {
        if (e.type === "progress")
          setProgress({
            value: Number(e.data.value),
            max: Number(e.data.max),
            node: String(e.data.node ?? ""),
          });
      });
      try {
        await api.comfyPrepare().catch(() => undefined);
        const id = await api.comfySubmit(graph, clientId);
        for (;;) {
          await new Promise((r) => setTimeout(r, 900));
          if (cancelled.current) break;
          const h = await api.comfyHistoryOne(id);
          if (h && (h.ok || h.status === "error")) {
            if (h.status === "error") setError(t("photo.comfy.runFailed"));
            else setView(h);
            break;
          }
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        stop();
        setBusy(false);
        setProgress(null);
        void refresh();
      }
    },
    [refresh, t],
  );

  const generate = async (): Promise<void> => {
    setError("");
    try {
      const p = { ...params };
      if (file && (preset.fields as string[]).includes("image"))
        p.image = await api.comfyUpload(file);
      await runGraph(buildGraph(preset.id, p, info));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Граф из библиотеки или помощника.
  useEffect(() => {
    if (!pending) return;
    onPendingUsed();
    void runGraph(pending);
  }, [pending, onPendingUsed, runGraph]);

  const importFile = async (f: File): Promise<void> => {
    setError("");
    try {
      if (/\.json$/i.test(f.name)) {
        const data = JSON.parse(await f.text()) as unknown;
        if (isApiGraph(data)) await runGraph(data);
        else if (isEditorGraph(data)) {
          await openInEditor(data, f.name);
          const api2 = await editorToApi();
          if (api2) await runGraph(api2);
        } else setError(t("photo.comfy.badWorkflow"));
      } else {
        // PNG/WebP/видео с вшитым воркфлоу: разбирает сам редактор.
        await openInEditor(f, f.name);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const assist = async (): Promise<void> => {
    if (!ask.trim()) return;
    setAsking(true);
    setError("");
    setNotes([]);
    try {
      const r = await api.comfyAssist({ request: ask.trim(), model: assistModel || undefined });
      setNotes(r.notes);
      openInEditor(r.workflow, "assistant");
      setAsk("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  const shown = view ?? history[0] ?? null;
  const num = (k: keyof PresetParams) => {
    const n = NUMBERS[k];
    return (
      <label className="field" key={k}>
        <span className="field-label">{t(`photo.comfy.f.${k}`)}</span>
        <input
          type="number"
          value={Number(params[k])}
          min={n?.min}
          max={n?.max}
          step={n?.step}
          onChange={(e) => set(k, Number(e.target.value) as never)}
        />
      </label>
    );
  };

  return (
    <div className="ph-tab">
      <Glass className="ph-card">
        <div className="ph-row">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`page-tab${presetId === p.id ? " active" : ""}`}
              onClick={() => pick(p.id)}
            >
              {t(`photo.comfy.preset.${p.id}`)}
            </button>
          ))}
        </div>
        <div className="muted-sm">{t(`photo.comfy.presetHint.${preset.id}`)}</div>
        {lacking.length > 0 && (
          <div className="ph-error">{t("photo.comfy.lackNodes", { list: lacking.join(", ") })}</div>
        )}
        {needModels.length > 0 && lacking.length === 0 && (
          <div className="ph-error">
            {t("photo.comfy.lackModels", {
              list: needModels.map((m) => t(`photo.comfy.f.${m}`)).join(", "),
            })}
          </div>
        )}
        <div className="ph-grid">
          {preset.fields.map((f) => {
            if (f === "prompt" || f === "negative")
              return (
                <label className="field" key={f} style={{ gridColumn: "1 / -1" }}>
                  <span className="field-label">{t(`photo.comfy.f.${f}`)}</span>
                  <textarea
                    rows={f === "prompt" ? 3 : 2}
                    value={params[f]}
                    onChange={(e) => set(f, e.target.value)}
                  />
                </label>
              );
            if (f === "image")
              return (
                <div className="field" key={f} style={{ gridColumn: "1 / -1" }}>
                  <span className="field-label">{t("photo.comfy.f.image")}</span>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <Btn icon={Upload} onClick={() => fileRef.current?.click()}>
                    {file ? file.name : t("photo.comfy.pickImage")}
                  </Btn>
                </div>
              );
            if (f === "vaeTiled")
              return (
                <label className="cf-check" key={f} title={t("photo.comfy.f.vaeTiledHint")}>
                  <input
                    type="checkbox"
                    checked={params.vaeTiled}
                    onChange={(e) => set("vaeTiled", e.target.checked)}
                  />
                  <span>{t("photo.comfy.f.vaeTiled")}</span>
                </label>
              );
            if (f === "clipDevice")
              return (
                <label className="field" key={f}>
                  <span className="field-label">{t("photo.comfy.f.clipDevice")}</span>
                  <Select
                    value={params.clipDevice}
                    onChange={(e) =>
                      set("clipDevice", e.target.value as PresetParams["clipDevice"])
                    }
                    options={[
                      { value: "default", label: t("photo.comfy.deviceGpu") },
                      { value: "cpu", label: t("photo.comfy.deviceCpu") },
                    ]}
                  />
                </label>
              );
            if (f === "loras") {
              const list = loraOptions;
              return (
                <div className="field" key={f} style={{ gridColumn: "1 / -1" }}>
                  <span className="field-label">{t("photo.comfy.f.loras")}</span>
                  {params.loras.map((l, i) => (
                    <div className="ph-row" key={i}>
                      <Select
                        value={l.name}
                        onChange={(e) => setLora(i, { name: e.target.value })}
                        options={[{ value: "", label: "—" }, ...list]}
                      />
                      <input
                        type="number"
                        title={t("photo.comfy.f.loraStrength")}
                        value={l.strength}
                        min={-2}
                        max={3}
                        step={0.05}
                        style={{ width: 90 }}
                        onChange={(e) => setLora(i, { strength: Number(e.target.value) })}
                      />
                      <input
                        type="number"
                        title={t("photo.comfy.f.loraClip")}
                        value={l.clip}
                        min={-2}
                        max={3}
                        step={0.05}
                        style={{ width: 90 }}
                        onChange={(e) => setLora(i, { clip: Number(e.target.value) })}
                      />
                      <Btn
                        icon={Trash2}
                        onClick={() =>
                          set(
                            "loras",
                            params.loras.filter((_, j) => j !== i),
                          )
                        }
                      />
                    </div>
                  ))}
                  <div className="ph-row">
                    <Btn
                      icon={Plus}
                      disabled={list.length === 0}
                      onClick={() =>
                        set("loras", [
                          ...params.loras,
                          { name: list[0] ?? "", strength: 1, clip: 1 },
                        ])
                      }
                    >
                      {t("photo.comfy.addLora")}
                    </Btn>
                    {list.length === 0 && (
                      <span className="muted-sm">{t("photo.comfy.noLoras")}</span>
                    )}
                  </div>
                  <div className="muted-sm">{t("photo.comfy.loraHint")}</div>
                </div>
              );
            }
            if (SOURCES[f]) {
              const list = options(f);
              return (
                <label className="field" key={f}>
                  <span className="field-label">{t(`photo.comfy.f.${f}`)}</span>
                  <Select
                    value={String(params[f])}
                    onChange={(e) => set(f, e.target.value as never)}
                    options={
                      f === "vae" && (preset.id === "txt2img" || preset.id === "img2img")
                        ? [{ value: "", label: t("photo.comfy.vaeFromCkpt") }, ...list]
                        : list.length
                          ? list
                          : [""]
                    }
                  />
                </label>
              );
            }
            return num(f);
          })}
        </div>
        <div className="ph-row">
          <Btn
            variant="primary"
            icon={Sparkles}
            disabled={
              busy ||
              lacking.length > 0 ||
              needModels.length > 0 ||
              (!params.prompt.trim() && preset.fields.includes("prompt"))
            }
            onClick={() => void generate()}
          >
            {busy ? t("photo.working") : t("photo.comfy.generate")}
          </Btn>
          {busy && (
            <Btn
              icon={X}
              onClick={() => {
                cancelled.current = true;
                void api.comfyInterrupt();
              }}
            >
              {t("photo.cancel")}
            </Btn>
          )}
          <Btn
            icon={Pencil}
            onClick={() => openInEditor(buildGraph(preset.id, params, info), preset.id)}
          >
            {t("photo.comfy.toEditor")}
          </Btn>
          <label className="btn btn-ghost" style={{ cursor: "pointer" }}>
            <Upload size={15} strokeWidth={2.1} />
            <span>{t("photo.comfy.importWorkflow")}</span>
            <input
              type="file"
              hidden
              accept=".json,.png,.webp,.jpg,.jpeg,.mp4,.webm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importFile(f);
              }}
            />
          </label>
        </div>
        {busy && (
          <>
            <ProgressBar
              value={progress && progress.max ? (progress.value / progress.max) * 100 : 3}
            />
            <div className="muted-sm">
              {progress && progress.max
                ? `${progress.value} / ${progress.max}`
                : t("photo.comfy.queued")}
            </div>
          </>
        )}
        {error && <div className="ph-error">{error}</div>}
      </Glass>

      <Glass className="ph-card">
        <b>
          <Wand2 size={14} style={{ verticalAlign: -2 }} /> {t("photo.comfy.assistTitle")}
        </b>
        <div className="muted-sm">{t("photo.comfy.assistHint")}</div>
        <textarea
          rows={2}
          value={ask}
          placeholder={t("photo.comfy.assistPlaceholder")}
          onChange={(e) => setAsk(e.target.value)}
        />
        <div className="ph-row">
          <Select
            value={assistModel}
            onChange={(e) => setAssistModel(e.target.value)}
            options={[
              { value: "", label: t("photo.comfy.assistAuto") },
              ...chatModels.map((m) => ({ value: m, label: m })),
            ]}
          />
          <Btn
            variant="primary"
            icon={Wand2}
            disabled={asking || !ask.trim()}
            onClick={() => void assist()}
          >
            {asking ? t("photo.working") : t("photo.comfy.assistBuild")}
          </Btn>
        </div>
        {notes.length > 0 && (
          <div className="muted-sm">
            {t("photo.comfy.assistNotes")}
            <pre className="ph-log">{notes.join("\n")}</pre>
          </div>
        )}
      </Glass>

      {shown && shown.images.length > 0 && (
        <Glass className="ph-card">
          <div className="cf-result">
            {shown.images.map((im) => (
              <figure key={`${im.subfolder}/${im.filename}`} className="cf-fig">
                <img src={api.comfyImageUrl(im)} alt={im.filename} />
                <figcaption className="ph-row">
                  <Btn
                    icon={Download}
                    onClick={() =>
                      void api.comfyImageBlob(im).then((b) => saveBlob(b, im.filename))
                    }
                  >
                    {t("photo.save")}
                  </Btn>
                </figcaption>
              </figure>
            ))}
          </div>
        </Glass>
      )}

      {history.length > 1 && (
        <Glass className="ph-card">
          <b>{t("photo.comfy.history")}</b>
          <div className="cf-hist">
            {history
              .filter((h) => h.images.length)
              .map((h) => (
                <button key={h.id} type="button" className="cf-thumb" onClick={() => setView(h)}>
                  <img src={api.comfyImageUrl(h.images[0])} alt="" loading="lazy" />
                </button>
              ))}
          </div>
        </Glass>
      )}
    </div>
  );
}

/** Разумный выбор по умолчанию: Turbo-модель — для пресета Turbo, euler/normal — для сэмплера. */
function pickDefault(field: keyof PresetParams, list: string[], p: PresetParams): string {
  if (field === "sampler") return list.includes("euler") ? "euler" : list[0];
  if (field === "scheduler") return list.includes("normal") ? "normal" : list[0];
  if (field === "unet")
    return list.find((f) => /turbo/i.test(f)) ?? list.find((f) => /qwen/i.test(f)) ?? list[0];
  if (field === "clip") return list.find((f) => /qwen3-?vl/i.test(f)) ?? list[0];
  if (field === "vae") return list.find((f) => /qwen/i.test(f)) ?? list[0];
  void p;
  return list[0];
}

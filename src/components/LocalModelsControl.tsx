import { useState } from "react";
import { Cpu, Loader2, Play, Power, RefreshCw } from "lucide-react";
import { Badge, Btn, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LlamaStatus } from "@/api/client";

const mb = (v: number): string => (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v} MB`);
const BUILD: Record<string, string> = { cpu: "CPU", vulkan: "Vulkan", cuda: "CUDA" };

/**
 * Управление локальными моделями llama.cpp: что в памяти, где лежат слои (видеокарта/RAM),
 * на чём считает, ручная загрузка/перезагрузка на нужном устройстве, лимит и MoE-режим.
 */
export default function LocalModelsControl({
  llama,
  onRefresh,
}: {
  llama: LlamaStatus;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const { activity: act, router } = llama;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState("");
  const [dev, setDev] = useState("auto");
  const [devs, setDevs] = useState<Record<string, string>>({});
  /** Введённое число слоёв по моделям; пусто — авто. */
  const [lay, setLay] = useState<Record<string, string>>({});

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setErr("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      onRefresh();
    }
  };

  const chatFiles = llama.models
    .map((m) => m.file)
    .filter((f) => !/embedding|mmproj|chandra|tts/i.test(f));
  const chosen = pick || chatFiles[0] || "";
  const deviceOptions = [
    { value: "auto", label: t("llama.ctl.devAuto") },
    { value: "gpu", label: t("llama.ctl.devGpu") },
    { value: "cpu", label: t("llama.ctl.devCpu") },
  ];
  const taskLabel = (x: string): string => (x ? t(`llama.task.${x}`) : t("llama.working"));

  return (
    <div className="task-mgr-section">
      <div className="task-mgr-section-title" style={{ marginBottom: 4 }}>
        <Cpu size={13} /> {t("llama.ctl.title")}
      </div>
      <div className="muted-sm">
        {t("semModel.actLimit", { n: act.limit })}
        {act.laptop ? ` · ${t("semModel.actLaptop")}` : ""}
      </div>
      {err && <div className="proxy-error">{err}</div>}

      {act.loaded.length === 0 && act.loading.length === 0 && (
        <div className="muted-sm" style={{ marginTop: 6 }}>
          {t("llama.noneLoaded")}
        </div>
      )}

      {act.loading.map((l) => (
        <div key={`l-${l.file}`} className="llama-model-card">
          <div className="llama-model-head">
            <Loader2 size={13} className="spin" />
            <b>{t("llama.loadingModel", { model: l.file })}</b>
            {l.task && <Badge tone="amber">{taskLabel(l.task)}</Badge>}
          </div>
        </div>
      ))}

      {act.loaded.map((m) => {
        const p = m.place;
        const modeTone =
          p.mode === "gpu-full" ? "teal" : p.mode === "gpu-partial" ? "amber" : "neutral";
        const modeText =
          p.mode === "gpu-full"
            ? t("llama.ctl.modeFull")
            : p.mode === "gpu-partial"
              ? t("llama.ctl.modePartial")
              : t("llama.ctl.modeCpu");
        const selDev = devs[m.file] ?? router.devices[m.file] ?? "auto";
        return (
          <div key={m.file} className="llama-model-card">
            <div className="llama-model-head">
              {m.busy ? <Loader2 size={13} className="spin" /> : <span className="llama-dot" />}
              <b className="llama-model-name" title={m.file}>
                {m.file}
              </b>
            </div>
            <div className="llama-model-badges">
              <Badge tone={modeTone}>{modeText}</Badge>
              <Badge tone="neutral">{BUILD[m.build] ?? m.build}</Badge>
              {p.moe && <Badge tone="violet">MoE</Badge>}
              {m.task && <Badge tone="neutral">{taskLabel(m.task)}</Badge>}
              {m.busy && <Badge tone="amber">{t("llama.working")}</Badge>}
            </div>
            <div className="llama-model-facts muted-sm">
              {p.mode !== "cpu" &&
                p.layersTotal > 0 &&
                (p.moe && router.layers?.[m.file] ? (
                  <span>
                    {t("llama.ctl.expertsGpu", {
                      a: Math.min(router.layers[m.file], Math.max(1, p.layersTotal - 1)),
                      b: Math.max(1, p.layersTotal - 1),
                    })}
                  </span>
                ) : (
                  <span>{t("llama.ctl.layers", { a: p.layersGpu, b: p.layersTotal })}</span>
                ))}
              {p.device && <span>{p.device}</span>}
              <span>
                {t("llama.ctl.vram")}: {mb(p.gpuMb + p.kvGpuMb)}
              </span>
              <span>
                {t("llama.ctl.ram")}: {mb(p.cpuMb + p.kvCpuMb)}
              </span>
              <span>{t("llama.ctl.ctx", { n: m.ctx })}</span>
              {m.mmproj && <span>{t("llama.ctl.vision")}</span>}
            </div>
            {p.mode === "gpu-partial" && p.moe && (
              <div className="muted-sm">{t("llama.ctl.moeNote")}</div>
            )}
            {p.fit && (
              <div className="muted-sm llama-fit" title={p.fit}>
                {p.fit}
              </div>
            )}
            <div className="llama-model-actions">
              <Select
                value={selDev}
                onChange={(e) => setDevs((d) => ({ ...d, [m.file]: e.target.value }))}
                options={deviceOptions}
              />
              {selDev !== "cpu" && (
                <label className="llama-layers" title={t("llama.ctl.layersHint")}>
                  <span className="muted-sm">{t("llama.ctl.layersSet")}</span>
                  <input
                    className="text-input"
                    type="number"
                    min={0}
                    max={p.layersTotal || 512}
                    placeholder={t("llama.ctl.layersAuto")}
                    value={lay[m.file] ?? (router.layers?.[m.file] ? String(router.layers[m.file]) : "")}
                    onChange={(e) => setLay((l) => ({ ...l, [m.file]: e.target.value }))}
                  />
                  {p.layersTotal > 0 && <span className="muted-sm">/ {p.layersTotal}</span>}
                </label>
              )}
              <Btn
                icon={RefreshCw}
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api.llamaLoad(
                      m.file,
                      selDev,
                      Math.max(
                        0,
                        Math.round(
                          Number(lay[m.file] ?? router.layers?.[m.file] ?? 0) || 0,
                        ),
                      ),
                    ),
                  )
                }
              >
                {t("llama.ctl.reload")}
              </Btn>
              <Btn
                icon={Power}
                disabled={busy}
                onClick={() => void run(() => api.llamaStop(m.file))}
              >
                {t("llama.unload")}
              </Btn>
            </div>
          </div>
        );
      })}

      {chatFiles.length > 0 && (
        <div className="llama-model-actions" style={{ marginTop: 10 }}>
          <Select
            value={chosen}
            onChange={(e) => setPick(e.target.value)}
            options={chatFiles.map((f) => ({ value: f, label: f }))}
          />
          <Select value={dev} onChange={(e) => setDev(e.target.value)} options={deviceOptions} />
          <Btn
            icon={Play}
            disabled={busy || !chosen}
            onClick={() => void run(() => api.llamaLoad(chosen, dev))}
          >
            {t("llama.ctl.load")}
          </Btn>
        </div>
      )}

      <label className="llama-check" style={{ marginTop: 10 }}>
        <input
          type="checkbox"
          checked={router.moeOffload}
          onChange={(e) => void run(() => api.llamaSetRouter({ moeOffload: e.target.checked }))}
        />
        <span>
          <b>{t("llama.moe")}</b>
          <span className="muted-sm">{t("llama.moeHint")}</span>
        </span>
      </label>
      <div className="llama-model-actions" style={{ marginTop: 8 }} title={t("llama.ctxHint")}>
        <span className="muted-sm">{t("llama.ctxLabel")}</span>
        <Select
          value={String(router.ctx ?? 16384)}
          onChange={(e) => void run(() => api.llamaSetRouter({ ctx: Number(e.target.value) }))}
          options={[4096, 8192, 16384, 32768, 65536, 131072].map((n) => ({
            value: String(n),
            label: `${n / 1024}k`,
          }))}
        />
      </div>
      <div className="muted-sm">{t("llama.ctxHint")}</div>
      <div className="llama-model-actions" style={{ marginTop: 8 }}>
        <span className="muted-sm">{t("llama.maxLoaded")}</span>
        <Select
          value={String(router.maxLoaded)}
          onChange={(e) =>
            void run(() => api.llamaSetRouter({ maxLoaded: Number(e.target.value) }))
          }
          options={[
            { value: "0", label: t("llama.maxAuto", { n: act.limit }) },
            ...[1, 2, 3, 4, 6].map((n) => ({ value: String(n), label: String(n) })),
          ]}
        />
      </div>
    </div>
  );
}

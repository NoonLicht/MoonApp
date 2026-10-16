import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Cpu, Download, Loader2, Power, RefreshCw, Sparkles } from "lucide-react";
import { Badge, Btn, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LlamaStatus } from "@/api/client";
import type { AiBindingsData } from "@/api/apiLlama";

const mb = (v: number): string => (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v} MB`);
const BUILD: Record<string, string> = { cpu: "CPU", vulkan: "Vulkan", cuda: "CUDA" };

/**
 * Выключатели ИИ-функций (заметки, почта, лекторий, «Контекст» и т.д.). Выключенная функция
 * не обращается к модели вообще. Эмбеддинги, перевод и голосовые модели сюда не входят.
 */
function FeatureSwitches() {
  const { t } = useI18n();
  const [data, setData] = useState<AiBindingsData | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api
      .aiBindings()
      .then(setData)
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(() => load(), [load]);
  if (!data) return err ? <div className="proxy-error">{err}</div> : null;

  const list = data.features.filter((f) => f.switchable);
  const isOn = (id: string): boolean => data.bindings[id]?.enabled !== false;
  const set = async (ids: string[], enabled: boolean): Promise<void> => {
    setErr("");
    try {
      for (const id of ids) {
        const next = await api.aiBindingSet(id, { enabled });
        setData((d) => (d ? { ...d, bindings: { ...d.bindings, [id]: next } } : d));
      }
    } catch (e) {
      setErr((e as Error).message);
      load();
    }
  };
  const onCount = list.filter((f) => isOn(f.id)).length;
  const allOn = onCount === list.length;

  return (
    <div className="aifeat">
      <div className="aifeat-head">
        <b>
          <Sparkles size={13} /> {t("llama.feat.title")}
        </b>
        <span className="muted-sm">{t("llama.feat.count", { a: onCount, b: list.length })}</span>
        <Btn
          onClick={() =>
            void set(
              list.map((f) => f.id),
              !allOn,
            )
          }
        >
          {allOn ? t("llama.feat.offAll") : t("llama.feat.onAll")}
        </Btn>
      </div>
      <div className="muted-sm">{t("llama.feat.hint")}</div>
      {err && <div className="proxy-error">{err}</div>}
      <div className="aifeat-list">
        {list.map((f) => {
          const on = isOn(f.id);
          return (
            <div key={f.id} className={`aifeat-row${on ? "" : " is-off"}`}>
              <span className="aifeat-name" title={t(`aibind.h_${f.id.replaceAll(".", "_")}`)}>
                {t(`aibind.f_${f.id.replaceAll(".", "_")}`)}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={t(`aibind.f_${f.id.replaceAll(".", "_")}`)}
                className={`switch${on ? " is-on" : ""}`}
                onClick={() => void set([f.id], !on)}
              >
                <span className="switch-knob" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
  const [devs, setDevs] = useState<Record<string, string>>({});

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

  const deviceOptions = [
    { value: "auto", label: t("llama.ctl.devAuto") },
    { value: "gpu", label: t("llama.ctl.devGpu") },
    { value: "cpu", label: t("llama.ctl.devCpu") },
  ];
  const taskLabel = (x: string): string => (x ? t(`llama.task.${x}`) : t("llama.working"));

  // Видеокарту система видит, а сборки llama.cpp для неё нет — всё считается на процессоре.
  const hasGpuBuild = llama.builds.some((b) => b.installed && b.id !== "cpu");
  const vulkan = llama.builds.find((b) => b.id === "vulkan");
  const failed = act.failed ?? [];
  const bad = act.badBuilds ?? [];
  const failText = (f: { code: string; detail: string }): string => {
    const known = ["memory", "build", "model", "gpu_build_missing", "gpu_build_failed", "build_missing"];
    return t(known.includes(f.code) ? `llama.err.${f.code}` : "llama.err.model", { detail: f.detail });
  };

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

      {act.gpu?.present && !hasGpuBuild && vulkan && (
        <div className="llama-alert">
          <AlertTriangle size={14} />
          <span>{t("llama.ctl.gpuNoBuild", { name: act.gpu.name })}</span>
          <Btn
            icon={Download}
            disabled={busy || llama.install.state === "working"}
            onClick={() => void run(() => api.llamaBuildInstall("vulkan"))}
          >
            {t("llama.ctl.installVulkan", { size: mb(vulkan.sizeMb) })}
          </Btn>
        </div>
      )}

      {bad.length > 0 && (
        <div className="llama-alert">
          <AlertTriangle size={14} />
          <span>{t("llama.ctl.badBuilds", { list: bad.map((b) => BUILD[b] ?? b).join(", ") })}</span>
          <Btn icon={RefreshCw} disabled={busy} onClick={() => void run(() => api.llamaResetBuilds())}>
            {t("llama.ctl.badReset")}
          </Btn>
        </div>
      )}

      {failed.map((f) => (
        <div key={`f-${f.file}`} className="llama-model-card llama-model-failed">
          <div className="llama-model-head">
            <AlertTriangle size={13} />
            <b className="llama-model-name" title={f.file}>
              {t("llama.ctl.failedTitle", { model: f.file })}
            </b>
          </div>
          <div className="muted-sm">{failText(f)}</div>
          <div className="llama-model-actions">
            <Btn
              icon={RefreshCw}
              disabled={busy}
              onClick={() => void run(() => api.llamaLoad(f.file, f.device))}
            >
              {t("llama.ctl.retry")}
            </Btn>
          </div>
        </div>
      ))}

      {act.loaded.length === 0 && act.loading.length === 0 && failed.length === 0 && (
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
              {p.mode !== "cpu" && p.layersTotal > 0 && (
                <span>{t("llama.ctl.layers", { a: p.layersGpu, b: p.layersTotal })}</span>
              )}
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
              <Btn
                icon={RefreshCw}
                disabled={busy}
                onClick={() => void run(() => api.llamaLoad(m.file, selDev))}
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

      <FeatureSwitches />

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

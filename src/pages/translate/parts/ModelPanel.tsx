import { Cpu, Download, Trash2, X, Power } from "lucide-react";
import { Glass, Btn, Badge, Select, ProgressBar } from "@/components/ui";
import LlamaPanel from "@/components/LlamaPanel";
import { useI18n } from "@/app/i18n";
import { useState } from "react";
import { api } from "@/api/client";
import type { LlamaStatus, TrProvider, TrStatus, TrVariant } from "@/api/client";
import type { TrSettings } from "@/pages/translate/parts/useTranslate";

const VARIANTS: { id: TrVariant; mb: number }[] = [
  { id: "q4", mb: 3112 },
  { id: "q4f16", mb: 2725 },
  { id: "dml", mb: 3660 },
];
const PROVIDERS: TrProvider[] = ["auto", "cpu", "dml", "cuda", "llamacpp"];

const fmtGb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;

/**
 * Модель и устройство вычислений. Выбор провайдера — тот же набор, что на странице
 * апскейла (auto/cpu/dml/cuda): рантайм ONNX и GPU-пак общие.
 */
export default function ModelPanel({
  status,
  settings,
  set,
  refresh,
  notify,
}: {
  status: TrStatus;
  settings: TrSettings;
  set: (p: Partial<TrSettings>) => void;
  refresh: () => void;
  notify: (text: string, ok?: boolean) => void;
}) {
  const { t } = useI18n();
  const [llama, setLlama] = useState<LlamaStatus | null>(null);
  const dl = status.download;
  const downloading = dl?.status === "downloading";

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message, false);
    }
    refresh();
  };

  const providers = PROVIDERS.filter((p) => p !== "dml" || status.platform === "win32");
  const ggufs = (llama?.models ?? []).filter((m) => /translategemma/i.test(m.file));
  const missing = (p: TrProvider): boolean =>
    p === "llamacpp"
      ? !llama || !llama.builds.some((b) => b.installed) || !ggufs.length
      : p !== "auto" && p !== "cpu" && !status.backends.includes(p);
  const isLlama = settings.provider === "llamacpp";

  return (
    <Glass style={{ padding: 14 }}>
      <div className="tn-sub">
        <b className="tn-card-title">
          <Cpu size={14} /> {t("translate.modelTitle")}
        </b>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {status.loaded && (
            <Badge tone="teal">
              {t("translate.inMemory", {
                provider: status.loaded.provider,
                variant: status.loaded.variant,
              })}
            </Badge>
          )}
          {status.loaded && (
            <Btn icon={Power} onClick={() => void act(() => api.trUnload())}>
              {t("translate.unload")}
            </Btn>
          )}
        </div>
      </div>
      <div className="muted-sm">{t("translate.modelHint")}</div>

      {status.restart && (
        <div className="tn-note" style={{ marginTop: 10 }}>
          {t("translate.restartNeeded")}
        </div>
      )}

      {!status.runtime.available && (
        <div className="tn-note" style={{ marginTop: 10 }}>
          {t("translate.noRuntime")} {status.runtime.error}
        </div>
      )}

      <div className="tr-grid">
        <label className="field">
          <span className="field-label">{t("translate.provider")}</span>
          <Select
            value={settings.provider}
            onChange={(e) => set({ provider: e.target.value as TrProvider, variant: "auto" })}
            options={providers.map((p) => ({
              value: p,
              label: `${t(`translate.prov.${p}`)}${missing(p) ? ` — ${t("translate.unavailable")}` : ""}`,
            }))}
          />
        </label>
        <label className="field">
          <span className="field-label">{t("translate.variant")}</span>
          <Select
            value={settings.variant}
            onChange={(e) => set({ variant: e.target.value as TrSettings["variant"] })}
            options={
              isLlama
                ? [
                    { value: "auto", label: t("translate.var.auto") },
                    ...ggufs.map((m) => ({ value: m.file, label: m.file })),
                  ]
                : [
                    { value: "auto", label: t("translate.var.auto") },
                    { value: "q4", label: t("translate.var.q4") },
                    { value: "q4f16", label: t("translate.var.q4f16") },
                    ...(status.platform === "win32"
                      ? [{ value: "dml", label: t("translate.var.dml") }]
                      : []),
                  ]
            }
          />
        </label>
      </div>
      {settings.provider === "cuda" && missing(settings.provider) && (
        <div className="muted-sm" style={{ marginTop: 8 }}>
          {t("translate.packHint")}
        </div>
      )}

      {status.failed.length > 0 && (
        <div className="muted-sm" style={{ marginTop: 8 }}>
          {t("translate.failedProviders", {
            list: [...new Set(status.failed.map((f) => f.split("|")[1]))].join(", "),
          })}
        </div>
      )}

      {isLlama && (
        <div className="muted-sm" style={{ marginTop: 8 }}>
          {t("translate.llamaHint")}
        </div>
      )}

      <div className="tn-list" style={{ marginTop: 10 }}>
        {VARIANTS.filter((v) => v.id !== "dml" || status.platform === "win32").map((v) => {
          const have = status.installed.includes(v.id);
          const active = downloading && dl?.variant === v.id;
          return (
            <div key={v.id} className="tn-row">
              <div className="tn-row-main">
                <div className="tn-row-title">
                  {t(`translate.var.${v.id}`)} · {fmtGb(v.mb)}
                </div>
                {active && dl && (
                  <>
                    <ProgressBar value={dl.total ? (dl.bytes / dl.total) * 100 : 0} />
                    <div className="muted-sm">
                      {dl.file} · {fmtGb(dl.bytes / 1e6)} / {fmtGb(dl.total / 1e6)}
                    </div>
                  </>
                )}
                {dl?.variant === v.id && dl.status === "error" && (
                  <div className="muted-sm">
                    {t("tuning.error")}: {dl.error}
                  </div>
                )}
              </div>
              {have && <Badge tone="teal">{t("translate.installed")}</Badge>}
              {active ? (
                <Btn icon={X} onClick={() => void act(() => api.trModelCancel())}>
                  {t("translate.cancel")}
                </Btn>
              ) : have ? (
                <Btn
                  icon={Trash2}
                  disabled={downloading}
                  onClick={() => {
                    if (window.confirm(t("translate.deleteConfirm", { name: v.id })))
                      void act(() => api.trModelDelete(v.id));
                  }}
                >
                  {t("translate.delete")}
                </Btn>
              ) : (
                <Btn
                  icon={Download}
                  disabled={downloading}
                  onClick={() => void act(() => api.trModelDownload(v.id))}
                >
                  {t("translate.download")}
                </Btn>
              )}
            </div>
          );
        })}
      </div>
      <div className="muted-sm" style={{ marginTop: 8 }}>
        {t("translate.trtNote")}
      </div>
      <div style={{ marginTop: 14 }}>
        <LlamaPanel kind="translate" notify={notify} onChange={setLlama} />
      </div>
      <div className="muted-sm" style={{ marginTop: 8 }}>
        {t("translate.license")}
      </div>
    </Glass>
  );
}

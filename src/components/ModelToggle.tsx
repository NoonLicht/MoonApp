import { useCallback, useEffect, useState } from "react";
import { Bot, Download, Loader2, Power, RefreshCw, X } from "lucide-react";
import { Badge, Btn, ProgressBar, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LlamaStatus } from "@/api/client";
import type { SemStatus } from "@/api/apiSemantic";

const gb = (mb: number): string => `${(mb / 1024).toFixed(2)} GB`;

/** Окно «Умный поиск»: включение функций EmbeddingGemma, выбор модели и способа запуска. */
export function ModelPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const DEVICES = [
    { value: "cpu", label: t("semModel.devCpu") },
    { value: "gpu", label: t("semModel.devGpu") },
    { value: "auto", label: t("semModel.devAuto") },
  ];
  const [sem, setSem] = useState<SemStatus | null>(null);
  const [llama, setLlama] = useState<LlamaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState("");

  const refresh = useCallback(() => {
    api
      .semStatus()
      .then(setSem)
      .catch(() => {});
    api
      .llamaStatus()
      .then(setLlama)
      .catch(() => {});
  }, []);

  const dl = llama?.download;
  const downloading = dl?.status === "downloading";
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, downloading || sem?.job.running ? 1000 : 2500);
    return () => window.clearInterval(id);
  }, [refresh, downloading, sem?.job.running]);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setErr("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  // Установленные модели + модели каталога, которых ещё нет на диске.
  const catalog = (llama?.catalog ?? []).filter((m) => m.kind === "embed");
  const installed = sem?.models ?? [];
  const nameOf = (id: string, file: string): string => {
    const k = `llama.model.${id}`;
    const v = t(k);
    return v === k ? file.replace(/\.gguf$/i, "") : v;
  };
  const options = [
    ...installed.map((f) => {
      const c = catalog.find((m) => m.file === f);
      return { value: f, label: c ? nameOf(c.id, f) : f.replace(/\.gguf$/i, "") };
    }),
    ...catalog
      .filter((m) => !installed.includes(m.file))
      .map((m) => ({
        value: m.file,
        label: `${nameOf(m.id, m.file)} · ${gb(m.sizeMb)} (${t("semModel.notInstalled")})`,
      })),
  ];
  const chosen = sem?.model ?? options[0]?.value ?? "";
  const isInstalled = installed.includes(chosen);
  const entry = catalog.find((m) => m.file === chosen);
  const activeDl = downloading && dl?.file === chosen;

  const on = !!sem?.enabled;
  const running = sem?.runtime;
  const anyBuild = (llama?.builds ?? []).some((b) => b.installed);
  const total = Object.values(sem?.indexed ?? {}).reduce((a, b) => a + b, 0);

  return (
    <div
      className="proxy-panel-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="proxy-panel">
        <div className="proxy-panel-header">
          <div className="proxy-panel-title">
            <span className="proxy-shield">
              <Bot size={18} strokeWidth={2} />
            </span>
            <div className="proxy-title-text">
              <div className="proxy-eyebrow">EmbeddingGemma 2</div>
              <div className="proxy-h1">{t("semModel.title")}</div>
            </div>
          </div>
          <button className="proxy-panel-close" onClick={onClose} title={t("common.close")}>
            <X size={15} />
          </button>
        </div>

        {err && <div className="proxy-error">{err}</div>}

        <div className="task-mgr-row">
          <div
            className="task-mgr-row-top"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <span className="task-mgr-label" style={{ flex: 1 }}>
              {on ? t("semModel.on") : t("semModel.off")}
            </span>
            {on && running && (
              <Badge tone="teal">
                {running.gpu ? t("semModel.gpu") : t("semModel.cpu")} · {t("semModel.inMemory")}
              </Badge>
            )}
            {on && !running && <Badge tone="neutral">{t("semModel.loadsOnRequest")}</Badge>}
            {busy && <Loader2 size={14} className="spin" />}
          </div>
          <div className="muted-sm">
            {t("semModel.blurb", { total })}
            {sem?.job.running
              ? t("semModel.indexing", { done: sem.job.done, total: sem.job.total })
              : ""}
          </div>
          {sem?.job.error && <div className="muted-sm task-mgr-err">{sem.job.error}</div>}
        </div>

        <div className="task-mgr-section">
          <div className="task-mgr-section-title" style={{ marginBottom: 4 }}>
            {t("semModel.model")}
          </div>
          <Select
            value={chosen}
            onChange={(e) => void run(() => api.semConfig({ model: e.target.value }))}
            options={options.length ? options : [{ value: "", label: t("semModel.noModels") }]}
            style={{ width: "100%", marginBottom: 8 }}
          />
          {!isInstalled && entry && (
            <div style={{ marginBottom: 12 }}>
              {activeDl && dl ? (
                <>
                  <ProgressBar value={dl.total ? (dl.bytes / dl.total) * 100 : 0} />
                  <div className="muted-sm">
                    {gb(dl.bytes / 1048576)} / {gb(dl.total / 1048576)}
                  </div>
                </>
              ) : (
                <Btn
                  icon={Download}
                  disabled={downloading}
                  onClick={() => void run(() => api.llamaModelDownload({ id: entry.id }))}
                >
                  {t("translate.download")} · {gb(entry.sizeMb)}
                </Btn>
              )}
            </div>
          )}

          <div className="task-mgr-section-title" style={{ marginBottom: 4 }}>
            {t("semModel.launchMode")}
          </div>
          <Select
            value={sem?.device ?? "cpu"}
            onChange={(e) =>
              void run(() => api.semConfig({ device: e.target.value as "cpu" | "gpu" | "auto" }))
            }
            options={DEVICES}
            style={{ width: "100%", marginBottom: 12 }}
          />
          {!anyBuild && (
            <div className="muted-sm" style={{ marginBottom: 8 }}>
              {t("semModel.needBuild")}
            </div>
          )}

          <div className="task-mgr-section-title" style={{ marginBottom: 4 }}>
            {t("semModel.otherModel")}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              className="text-input"
              style={{ flex: 1 }}
              value={url}
              placeholder="https://huggingface.co/…/embeddinggemma-….gguf"
              onChange={(e) => setUrl(e.target.value)}
            />
            <Btn
              icon={Download}
              disabled={downloading || !/embedding/i.test(url)}
              title={t("semModel.embeddingHint")}
              onClick={() => {
                const u = url.trim();
                setUrl("");
                void run(() => api.llamaModelDownload({ url: u }));
              }}
            >
              {t("translate.download")}
            </Btn>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <Btn
            icon={RefreshCw}
            disabled={busy || !on || !isInstalled || !!sem?.job.running}
            onClick={() => void run(() => api.semSync())}
          >
            {t("semModel.updateIndex")}
          </Btn>
          <Btn icon={Power} disabled={busy || !running} onClick={() => void run(api.semUnload)}>
            {t("semModel.unload")}
          </Btn>
          <Btn
            variant={on ? "secondary" : "primary"}
            icon={Power}
            disabled={busy || (!on && !isInstalled)}
            onClick={() => void run(() => api.semConfig({ enabled: !on }))}
          >
            {on ? t("semModel.disable") : t("semModel.enable")}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/** Кнопка в шапке: зелёная точка — умный поиск включён. */
export default function ModelToggle({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  const [on, setOn] = useState(false);
  useEffect(() => {
    const tick = () =>
      api
        .semStatus()
        .then((s) => setOn(s.enabled && s.models.includes(s.model ?? "")))
        .catch(() => {});
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <button
      className="task-mgr-toggle no-drag"
      onClick={onClick}
      title={on ? t("semModel.toggleOn") : t("semModel.toggleOff")}
      aria-label={t("semModel.title")}
      style={{ position: "relative", color: on ? "var(--amber)" : undefined }}
    >
      <Bot size={15} />
      {on && (
        <span
          style={{
            position: "absolute",
            right: 3,
            top: 3,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#22c55e",
          }}
        />
      )}
    </button>
  );
}

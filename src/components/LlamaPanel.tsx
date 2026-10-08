import { useCallback, useEffect, useState } from "react";
import { Cpu, Download, Power, Trash2, X } from "lucide-react";
import { Badge, Btn, ProgressBar } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LlamaStatus } from "@/api/client";

const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;

/**
 * Встроенный llama.cpp: установка сборки (CPU / Vulkan / CUDA) и GGUF-моделей. Общий блок для
 * переводчика и настроек чата; `kind` ограничивает каталог моделями нужного назначения.
 */
export default function LlamaPanel({
  kind,
  notify,
  onChange,
}: {
  kind?: "translate" | "chat" | "tts" | "ocr";
  notify?: (text: string, ok?: boolean) => void;
  onChange?: (s: LlamaStatus) => void;
}) {
  const { t } = useI18n();
  const [st, setSt] = useState<LlamaStatus | null>(null);
  const [url, setUrl] = useState("");

  const refresh = useCallback(async () => {
    try {
      const s = await api.llamaStatus();
      setSt(s);
      onChange?.(s);
    } catch {
      /* сервер недоступен — оставляем прежнее */
    }
  }, [onChange]);

  const busy = st?.install.state === "working" || st?.download?.status === "downloading";
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), busy ? 1000 : 5000);
    return () => window.clearInterval(id);
  }, [refresh, busy]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      notify?.((e as Error).message, false);
    }
    void refresh();
  };

  if (!st) return null;
  const dl = st.download;
  const downloading = dl?.status === "downloading";
  const installing = st.install.state === "working";
  const anyBuild = st.builds.some((b) => b.installed);
  const models = st.catalog.filter((m) => !kind || m.kind === kind);

  return (
    <div className="llama-panel">
      <div className="tn-sub">
        <b className="tn-card-title">
          <Cpu size={14} /> {t("llama.title")}
        </b>
        {st.server && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Badge tone="teal">
              {t("llama.inMemory", { build: st.server.build, model: st.server.file })}
            </Badge>
            <Btn icon={Power} onClick={() => void act(() => api.llamaStop())}>
              {t("llama.unload")}
            </Btn>
          </div>
        )}
      </div>
      <div className="muted-sm">{t("llama.hint")}</div>

      {st.builds.length === 0 && <div className="tn-note">{t("llama.unsupported")}</div>}
      <div className="tn-list" style={{ marginTop: 8 }}>
        {st.builds.map((b) => {
          const active = installing && st.install.id === b.id;
          return (
            <div key={b.id} className="tn-row">
              <div className="tn-row-main">
                <div className="tn-row-title">
                  {t(`llama.build.${b.id}`)} · {gb(b.sizeMb)}
                  {st.failedBuilds.includes(b.id) ? ` · ${t("llama.failed")}` : ""}
                </div>
                <div className="muted-sm">{t(`llama.buildHint.${b.id}`)}</div>
                {active && (
                  <>
                    <ProgressBar value={st.install.progress} />
                    <div className="muted-sm">
                      {t(`llama.phase.${st.install.phase || "download"}`)}
                    </div>
                  </>
                )}
                {st.install.state === "error" && st.install.id === b.id && (
                  <div className="muted-sm">
                    {t("tuning.error")}: {st.install.error}
                  </div>
                )}
              </div>
              {b.installed && <Badge tone="teal">{t("translate.installed")}</Badge>}
              {active ? (
                <Btn icon={X} onClick={() => void act(() => api.llamaBuildCancel())}>
                  {t("translate.cancel")}
                </Btn>
              ) : b.installed ? (
                <Btn
                  icon={Trash2}
                  disabled={installing}
                  onClick={() => void act(() => api.llamaBuildRemove(b.id))}
                >
                  {t("translate.delete")}
                </Btn>
              ) : (
                <Btn
                  icon={Download}
                  disabled={installing}
                  onClick={() => void act(() => api.llamaBuildInstall(b.id))}
                >
                  {t("translate.download")}
                </Btn>
              )}
            </div>
          );
        })}
      </div>

      <b className="tn-card-title" style={{ display: "block", marginTop: 12 }}>
        {t("llama.modelsTitle")}
      </b>
      <div className="tn-list" style={{ marginTop: 6 }}>
        {models.map((m) => {
          const have =
            st.models.some((x) => x.file === m.file) &&
            (m.extra ?? []).every((e) => st.models.some((x) => x.file === e.file));
          const active = downloading && dl?.file === m.file;
          return (
            <div key={m.id} className="tn-row">
              <div className="tn-row-main">
                <div className="tn-row-title">
                  {t(`llama.model.${m.id}`)} · {gb(m.sizeMb)}
                </div>
                <div className="muted-sm">{m.file}</div>
                {active && dl && (
                  <>
                    <ProgressBar value={dl.total ? (dl.bytes / dl.total) * 100 : 0} />
                    <div className="muted-sm">
                      {gb(dl.bytes / 1048576)} / {gb(dl.total / 1048576)}
                    </div>
                  </>
                )}
              </div>
              {have && <Badge tone="teal">{t("translate.installed")}</Badge>}
              {active ? (
                <Btn icon={X} onClick={() => void act(() => api.llamaModelCancel())}>
                  {t("translate.cancel")}
                </Btn>
              ) : have ? (
                <Btn
                  icon={Trash2}
                  disabled={downloading}
                  onClick={() => void act(() => api.llamaModelRemove(m.file))}
                >
                  {t("translate.delete")}
                </Btn>
              ) : (
                <Btn
                  icon={Download}
                  disabled={downloading}
                  onClick={() => void act(() => api.llamaModelDownload({ id: m.id }))}
                >
                  {t("translate.download")}
                </Btn>
              )}
            </div>
          );
        })}
        {st.models
          .filter(
            (x) =>
              !st.catalog.some((m) => m.file === x.file || m.extra?.some((e) => e.file === x.file)),
          )
          .map((x) => (
            <div key={x.file} className="tn-row">
              <div className="tn-row-main">
                <div className="tn-row-title">
                  {x.file} · {gb(x.sizeMb)}
                </div>
              </div>
              <Btn icon={Trash2} onClick={() => void act(() => api.llamaModelRemove(x.file))}>
                {t("translate.delete")}
              </Btn>
            </div>
          ))}
      </div>
      {dl?.status === "error" && (
        <div className="muted-sm">
          {t("tuning.error")}: {dl.error}
        </div>
      )}
      {kind !== "translate" && kind !== "tts" && kind !== "ocr" && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            className="text-input"
            style={{ flex: 1 }}
            value={url}
            placeholder={t("llama.urlPlaceholder")}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Btn
            icon={Download}
            disabled={downloading || !url.trim()}
            onClick={() => {
              void act(() => api.llamaModelDownload({ url: url.trim() }));
              setUrl("");
            }}
          >
            {t("translate.download")}
          </Btn>
        </div>
      )}
      {!anyBuild && <div className="muted-sm">{t("llama.needBuild")}</div>}
    </div>
  );
}

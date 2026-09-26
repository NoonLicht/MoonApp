import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Cloud, HardDrive, Ban, Download, Play, Loader2 } from "lucide-react";
import { Badge, Select, ProgressBar } from "@/components/ui";
import { api } from "@/api/client";
import { useI18n } from "@/app/i18n";
import type { AiFeatureId, AiFeatureSetting, AiLocalModelInfo } from "@/api/types";

/**
 * Переключатель ИИ-функции удобства на странице: API (DeepSeek) / локальная
 * ONNX-модель / выкл, плюс кнопка «Запустить» — для локального режима она
 * скачивает (если нужно) и грузит модель в память, для API-режима — просто
 * проверяет, что ключ DeepSeek настроен.
 *
 * Переключение мгновенно сохраняется на бэкенде (`/api/ai/settings/:feature`),
 * а server/ts/aiRuntime.ts перечитывает настройки на КАЖДЫЙ запуск фичи —
 * поэтому новый режим действует со следующего же действия, без перезагрузки
 * страницы и повтора того, что пользователь уже делал.
 */
export function AiFeatureToggle({ feature }: { feature: AiFeatureId }) {
  const { t } = useI18n();
  const [setting, setSetting] = useState<AiFeatureSetting | null>(null);
  const [hasApiKey, setHasApiKey] = useState(true);
  const [models, setModels] = useState<AiLocalModelInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshModels = useCallback(async () => {
    try {
      const r = await api.aiLocalModels();
      setModels(r.models);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    api
      .aiSettings()
      .then((r) => {
        setSetting(r.features[feature]);
        setHasApiKey(r.hasApiKey);
      })
      .catch(() => {});
    refreshModels();
  }, [feature, refreshModels]);

  const activeModel = setting?.localModel
    ? models.find((m) => m.id === setting.localModel)
    : undefined;
  const isDownloading = activeModel?.status.state === "downloading" || activeModel?.status.state === "loading";

  useEffect(() => {
    if (isDownloading) {
      pollRef.current = setInterval(refreshModels, 1000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isDownloading, refreshModels]);

  const setMode = useCallback(
    async (mode: AiFeatureSetting["mode"]) => {
      setApiReady(false);
      const patch: Partial<AiFeatureSetting> =
        mode === "local" ? { mode, localModel: setting?.localModel || models[0]?.id } : { mode };
      const r = await api.aiSetFeature(feature, patch);
      setSetting(r.setting);
    },
    [feature, setting, models],
  );

  const setModel = useCallback(
    async (localModel: string) => {
      setApiReady(false);
      const r = await api.aiSetFeature(feature, { mode: "local", localModel });
      setSetting(r.setting);
    },
    [feature],
  );

  const activate = useCallback(async () => {
    if (!setting) return;
    setBusy(true);
    try {
      if (setting.mode === "api") {
        setApiReady(hasApiKey);
      } else if (setting.mode === "local" && setting.localModel) {
        await api.aiLoadLocalModel(setting.localModel);
        await refreshModels();
      }
    } catch {
      await refreshModels();
    } finally {
      setBusy(false);
    }
  }, [setting, hasApiKey, refreshModels]);

  if (!setting) return null;

  const readyState =
    setting.mode === "api"
      ? apiReady && hasApiKey
        ? "ready"
        : hasApiKey
          ? "idle"
          : "error"
      : activeModel?.status.state || "idle";

  return (
    <div className="ai-toggle">
      <span className="ai-toggle-label">
        <Sparkles size={13} /> {t("ai.toggleLabel")}
      </span>
      <div className="ai-toggle-modes">
        <Badge tone="violet" active={setting.mode === "api"} onClick={() => setMode("api")}>
          <Cloud size={12} /> {t("ai.modeApi")}
        </Badge>
        <Badge tone="teal" active={setting.mode === "local"} onClick={() => setMode("local")}>
          <HardDrive size={12} /> {t("ai.modeLocal")}
        </Badge>
        <Badge tone="neutral" active={setting.mode === "off"} onClick={() => setMode("off")}>
          <Ban size={12} /> {t("ai.modeOff")}
        </Badge>
      </div>

      {setting.mode === "local" && (
        <Select
          value={setting.localModel || ""}
          onChange={(e) => setModel(e.target.value)}
          options={models.map((m) => ({
            value: m.id,
            label: `${m.label}${m.installed ? "" : ` (${t("ai.notInstalled")})`}`,
          }))}
        />
      )}

      {setting.mode !== "off" && (
        <button
          type="button"
          className="btn btn-secondary ai-toggle-activate"
          disabled={busy || readyState === "ready"}
          onClick={activate}
          title={
            setting.mode === "api" && !hasApiKey
              ? t("ai.noApiKeyHint")
              : activeModel?.hint
          }
        >
          {busy || isDownloading ? (
            <Loader2 size={13} className="spin" />
          ) : readyState === "ready" ? (
            <Sparkles size={13} />
          ) : (
            <Play size={13} />
          )}
          {isDownloading
            ? `${t("ai.downloading")} ${activeModel?.status.progress ?? 0}%`
            : readyState === "ready"
              ? t("ai.ready")
              : t("ai.activate")}
        </button>
      )}

      {setting.mode === "local" && isDownloading && (
        <ProgressBar value={activeModel?.status.progress ?? 0} />
      )}
      {setting.mode === "local" && !activeModel?.installed && !isDownloading && (
        <span className="ai-toggle-hint">
          <Download size={11} /> {t("ai.willDownload", { mb: activeModel?.approxSizeMb ?? 0 })}
        </span>
      )}
      {setting.mode === "api" && !hasApiKey && (
        <span className="ai-toggle-hint is-warn">{t("ai.noApiKeyHint")}</span>
      )}
      {readyState === "error" && (
        <span className="ai-toggle-hint is-warn">{activeModel?.status.error}</span>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Badge, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import ModelPanel from "@/pages/translate/parts/ModelPanel";
import TextTab from "@/pages/translate/parts/TextTab";
import FileTab from "@/pages/translate/parts/FileTab";
import ImageTab from "@/pages/translate/parts/ImageTab";
import { useTrSettings, useTrStatus } from "@/pages/translate/parts/useTranslate";

type Tab = "text" | "file" | "image" | "model";
const TABS: Tab[] = ["text", "file", "image", "model"];

/**
 * Переводчик: TranslateGemma 4B локально через onnxruntime (auto/cpu/dml/cuda).
 * Без лимита на длину текста, перевод файлов и текста на изображениях.
 */
export default function TranslatePage() {
  const { t, lang } = useI18n();
  const { status, error, refresh } = useTrStatus();
  const [settings, set] = useTrSettings(lang);
  const [tab, setTab] = useState<Tab>("text");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const notify = useCallback((text: string, ok = true) => setMsg({ text, ok }), []);

  const ready = !!status && status.runtime.available && status.installed.length > 0;
  const noModel = !!status && status.installed.length === 0;

  // Пока модели нет, сразу показываем вкладку загрузки.
  useEffect(() => {
    if (noModel) setTab("model");
  }, [noModel]);

  // Целевой язык по умолчанию — язык интерфейса, если модель его знает.
  useEffect(() => {
    if (status && !status.languages.includes(settings.tgt)) set({ tgt: "en" });
  }, [status, settings.tgt, set]);

  if (!status) {
    return (
      <div className="page">
        <SectionHead eyebrow={t("translate.eyebrow")} title={t("translate.title")} />
        <div className="muted-sm">{error || t("tuning.loading")}</div>
      </div>
    );
  }

  return (
    <div className="page tn-page">
      <SectionHead
        eyebrow={t("translate.eyebrow")}
        title={t("translate.title")}
        action={
          status.loaded ? (
            <Badge tone="teal">
              {status.loaded.provider} · {status.loaded.variant}
            </Badge>
          ) : undefined
        }
      />

      {noModel && (
        <div className="tn-note">
          <ShieldAlert size={14} /> {t("translate.needModel")}
        </div>
      )}

      <div className="tn-tabs">
        {TABS.map((k) => (
          <Badge
            key={k}
            tone={tab === k ? "amber" : "neutral"}
            active={tab === k}
            onClick={() => setTab(k)}
          >
            {t(`translate.tab.${k}`)}
          </Badge>
        ))}
      </div>

      {msg && (
        <div
          className={`tn-msg ${msg.ok ? "ok" : "bad"}`}
          role="status"
          onClick={() => setMsg(null)}
        >
          {msg.text}
        </div>
      )}

      <div className="page-scroll-body tr-body">
        {/* Вкладки всегда смонтированы и лишь скрываются: текст, файл и ход перевода не теряются. */}
        <div className={`tr-pane ${tab === "text" ? "on" : ""}`}>
          <TextTab status={status} settings={settings} set={set} ready={ready} notify={notify} />
        </div>
        <div className={`tr-pane ${tab === "file" ? "on" : ""}`}>
          <FileTab status={status} settings={settings} set={set} ready={ready} notify={notify} />
        </div>
        <div className={`tr-pane ${tab === "image" ? "on" : ""}`}>
          <ImageTab status={status} settings={settings} set={set} ready={ready} notify={notify} />
        </div>
        <div className={`tr-pane ${tab === "model" ? "on" : ""}`}>
          <ModelPanel
            status={status}
            settings={settings}
            set={set}
            refresh={refresh}
            notify={notify}
          />
        </div>
      </div>
    </div>
  );
}

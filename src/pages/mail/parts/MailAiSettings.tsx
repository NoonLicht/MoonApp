import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { MailSettings } from "@/api/apiMail";

type Ai = MailSettings["ai"];
const ENGINES = ["ai", "local", "google", "mymemory", "libre", "lingva"] as const;
const AI_MODES = ["embedding", "provider", "llamacpp"] as const;
const OFFLINE_TR = new Set(["local"]);

/**
 * Движок ИИ-функций почты и перевода писем. По умолчанию всё считается на этом компьютере
 * (EmbeddingGemma + локальная модель перевода); облачные варианты включаются осознанно.
 */
export function MailAiSettings({ ai, onChange }: { ai: Ai; onChange: (p: Partial<Ai>) => void }) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<{ id: string; label: string; hasKey: boolean }[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [cfg, setCfg] = useState<Awaited<ReturnType<typeof api.rssSettings>> | null>(null);
  const [mmEmail, setMmEmail] = useState("");
  const [libreUrl, setLibreUrl] = useState("");
  const [libreKey, setLibreKey] = useState("");
  const [lingvaUrl, setLingvaUrl] = useState("");

  useEffect(() => {
    api
      .lectureProviders()
      .then((l) => setProviders(l.filter((p) => p.id !== "llamacpp")))
      .catch(() => setProviders([]));
    api
      .rssSettings()
      .then((c) => {
        setCfg(c);
        setMmEmail(c.myMemoryEmail);
        setLibreUrl(c.libreUrl);
        setLingvaUrl(c.lingvaUrl);
      })
      .catch(() => undefined);
  }, []);

  // список моделей: выбранный провайдер или локальные модели llama.cpp
  const providerForModels =
    ai.engine === "llamacpp" ? "llamacpp" : ai.engine === "provider" ? ai.providerId : "";
  useEffect(() => {
    if (!providerForModels) return;
    let alive = true;
    api
      .lectureProviderModels(providerForModels)
      .then((r) => alive && setModels(r.models))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [providerForModels]);

  const saveRss = (patch: Parameters<typeof api.rssSaveSettings>[0]) =>
    void api
      .rssSaveSettings(patch)
      .then(setCfg)
      .catch(() => undefined);

  return (
    <>
      <div className="mail-set-sub">{t("mail.ai_engineTitle")}</div>
      {AI_MODES.map((m) => (
        <label key={m} className={`mail-radio${ai.engine === m ? " is-on" : ""}`}>
          <input
            type="radio"
            name="mail-ai-engine"
            checked={ai.engine === m}
            onChange={() => onChange({ engine: m })}
          />
          <span>
            <b>{t(`mail.ai_eng_${m}`)}</b>
            <span className="mail-hint">{t(`mail.ai_eng_${m}Hint`)}</span>
          </span>
        </label>
      ))}

      {ai.engine === "provider" && (
        <div className="mail-row-gap">
          <Select
            value={ai.providerId}
            onChange={(e) => onChange({ providerId: e.target.value, model: "" })}
            options={[
              { value: "", label: t("mail.ai_sameAsConspectus") },
              ...providers.map((p) => ({
                value: p.id,
                label: p.label + (p.hasKey ? "" : ` — ${t("mail.ai_noKey")}`),
              })),
            ]}
          />
          {ai.providerId && (
            <Select
              value={ai.model}
              onChange={(e) => onChange({ model: e.target.value })}
              options={[
                { value: "", label: t("mail.ai_autoModel") },
                ...models.map((m) => ({ value: m, label: m })),
              ]}
            />
          )}
        </div>
      )}
      {ai.engine === "llamacpp" && (
        <Select
          value={ai.model}
          onChange={(e) => onChange({ model: e.target.value })}
          options={[
            { value: "", label: t("mail.ai_autoModel") },
            ...models.map((m) => ({ value: m, label: m })),
          ]}
        />
      )}
      {ai.engine === "provider" && <div className="mail-warn">{t("mail.ai_cloudWarn")}</div>}

      <div className="mail-set-sub">{t("mail.tr_engineTitle")}</div>
      {ENGINES.map((e) => (
        <label key={e} className={`mail-radio${ai.translateEngine === e ? " is-on" : ""}`}>
          <input
            type="radio"
            name="mail-tr-engine"
            checked={ai.translateEngine === e}
            onChange={() => onChange({ translateEngine: e })}
          />
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>{t(`rss.engine.${e}`)}</b>
            <span className="mail-hint">{t(`rss.engine.${e}Hint`)}</span>
            {ai.translateEngine === e && e === "mymemory" && (
              <input
                type="email"
                placeholder={t("rss.cfg.email")}
                value={mmEmail}
                onChange={(ev) => setMmEmail(ev.target.value)}
                onBlur={() => saveRss({ myMemoryEmail: mmEmail })}
              />
            )}
            {ai.translateEngine === e && e === "libre" && (
              <>
                <input
                  placeholder="https://libretranslate.example.com"
                  value={libreUrl}
                  onChange={(ev) => setLibreUrl(ev.target.value)}
                  onBlur={() => saveRss({ libreUrl })}
                />
                <input
                  type="password"
                  placeholder={cfg?.hasLibreKey ? t("rss.cfg.keySaved") : t("rss.cfg.key")}
                  value={libreKey}
                  onChange={(ev) => setLibreKey(ev.target.value)}
                  onBlur={() => {
                    if (libreKey) saveRss({ libreKey });
                    setLibreKey("");
                  }}
                />
              </>
            )}
            {ai.translateEngine === e && e === "lingva" && (
              <input
                placeholder="https://lingva.ml"
                value={lingvaUrl}
                onChange={(ev) => setLingvaUrl(ev.target.value)}
                onBlur={() => saveRss({ lingvaUrl })}
              />
            )}
          </span>
        </label>
      ))}
      {OFFLINE_TR.has(ai.translateEngine) ? (
        <div className="mail-hint">
          <ShieldCheck size={13} /> {t("mail.tr_localNote")}
        </div>
      ) : (
        <div className="mail-warn">{t("mail.tr_cloudWarn")}</div>
      )}
    </>
  );
}

import { useEffect, useState } from "react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { loadPageAccess, setProfile, usePageAccess } from "@/app/pageAccess";

const PROFILE_IDS = ["all", "media", "study", "minimal"] as const;

/**
 * Выбор профиля страниц: «Всё», «Медиа и файлы», «Учёба и заметки», «Минимум».
 * Профиль отключает остальные страницы целиком (см. server/ts/features.ts).
 * Общий для приветственного окна и раздела настроек «Страницы и профили».
 */
export default function PageProfilePicker() {
  const { t } = useI18n();
  const { state } = usePageAccess();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!state) void loadPageAccess();
  }, [state]);

  if (!state) return null;

  const pick = async (id: string): Promise<void> => {
    setBusy(id);
    setError("");
    try {
      await setProfile(id);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy("");
  };

  return (
    <div className="pageprof">
      <div className="pageprof-row">
        {PROFILE_IDS.map((id) => (
          <Btn
            key={id}
            variant={state.profile === id ? "primary" : "secondary"}
            disabled={!!busy}
            title={t(`settings.pages.profileDesc.${id}`)}
            onClick={() => void pick(id)}
          >
            {t(`settings.pages.profileName.${id}`)}
          </Btn>
        ))}
        {state.profile === "custom" && (
          <span className="muted-sm">{t("settings.pages.profileName.custom")}</span>
        )}
      </div>
      {PROFILE_IDS.includes(state.profile as (typeof PROFILE_IDS)[number]) && (
        <div className="muted-sm">{t(`settings.pages.profileDesc.${state.profile}`)}</div>
      )}
      {error && <div className="proxy-error">{error}</div>}
    </div>
  );
}

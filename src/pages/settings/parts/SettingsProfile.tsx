import { useRef, useState } from "react";
import { Lock, Unlock } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { Btn } from "@/components/ui";
import { Row, applyLiveSettings } from "@/pages/settings/parts/SettingsControls";
import { collectUiSettings, applyUiSettings } from "@/lib/uiSettings";
import { saveBlob } from "@/lib/download";
import { encryptProfile, decryptProfile, isEncryptedProfile } from "@/lib/profileCrypto";

/**
 * Зашифрованный профиль: настройки вместе с ключами API в одном файле под
 * паролем. Шифрование выполняется в браузере; пароль нигде не сохраняется.
 */
export function ProfileRows() {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const fail = (e: unknown) => {
    const m = (e as Error).message;
    setMsg(
      m === "password_too_short"
        ? t("settings.profile.tooShort")
        : m === "wrong_password_or_corrupted"
          ? t("settings.profile.wrong")
          : m === "not_a_profile"
            ? t("settings.profile.notProfile")
            : m,
    );
  };

  const doExport = async () => {
    setBusy(true);
    setMsg("");
    try {
      const { blob } = await api.settingsExport({ includeSecrets: true, ui: collectUiSettings() });
      const file = await encryptProfile(await blob.text(), password);
      saveBlob(
        new Blob([file], { type: "application/json" }),
        `moonapp-profile-${new Date().toISOString().slice(0, 10)}.moonprofile`,
      );
      setMsg(t("settings.profile.exported"));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (file: File) => {
    setBusy(true);
    setMsg("");
    try {
      const text = await file.text();
      if (!isEncryptedProfile(text)) throw new Error("not_a_profile");
      const plain = JSON.parse(await decryptProfile(text, password));
      if (!window.confirm(t("settings.profile.confirm"))) return;
      const r = await api.settingsImport(plain, { importSecrets: true });
      applyUiSettings(r.ui);
      applyLiveSettings(r.settings);
      setMsg(t("settings.profile.imported", { n: r.applied, keys: r.keysApplied }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <>
      <Row label={t("settings.profile.title")} hint={t("settings.profile.hint")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={t("settings.profile.password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Btn icon={Lock} disabled={busy || password.length < 6} onClick={() => void doExport()}>
            {t("settings.profile.export")}
          </Btn>
          <Btn
            icon={Unlock}
            disabled={busy || password.length < 6}
            onClick={() => fileRef.current?.click()}
          >
            {t("settings.profile.import")}
          </Btn>
          <input
            ref={fileRef}
            type="file"
            accept=".moonprofile,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doImport(f);
            }}
          />
        </div>
      </Row>
      {msg && (
        <div className="muted-sm" style={{ marginTop: -4 }}>
          {msg}
        </div>
      )}
    </>
  );
}

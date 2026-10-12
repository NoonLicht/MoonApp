import { useRef, useState } from "react";
import { AudioLines } from "lucide-react";
import { Glass, Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";

type Level = "light" | "medium" | "strong";

/**
 * Шумоподавление записи: выбираете аудио- или видеофайл, получаете очищенный WAV
 * (срез гула, спектральный шумодав, выравнивание громкости). Обработка — ffmpeg,
 * локально.
 */
export default function AudioCleanPanel() {
  const { t } = useI18n();
  const [level, setLevel] = useState<Level>("medium");
  const [normalize, setNormalize] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (file: File) => {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const blob = await api.audioClean(file, level, normalize);
      saveBlob(blob, file.name.replace(/\.[^.]*$/, "") + ".clean.wav");
      setMsg(t("lecture.clean.done"));
    } catch (e) {
      const m = (e as Error).message;
      setErr(/ffmpeg_not_found/.test(m) ? t("lecture.clean.noFfmpeg") : m);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Glass className="p-4" style={{ marginTop: 16 }}>
      <div className="field-label">{t("lecture.clean.title")}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select
          className="input"
          value={level}
          onChange={(e) => setLevel(e.target.value as Level)}
          aria-label={t("lecture.clean.level")}
        >
          <option value="light">{t("lecture.clean.light")}</option>
          <option value="medium">{t("lecture.clean.medium")}</option>
          <option value="strong">{t("lecture.clean.strong")}</option>
        </select>
        <label className="muted-sm" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
          {t("lecture.clean.normalize")}
        </label>
        <Btn icon={AudioLines} disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? t("lecture.clean.working") : t("lecture.clean.pick")}
        </Btn>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void run(f);
          }}
        />
      </div>
      <div className="muted-sm" style={{ marginTop: 6 }}>
        {t("lecture.clean.hint")}
      </div>
      {msg && <div className="muted-sm">{msg}</div>}
      {err && <div style={{ color: "var(--danger, #e66)", marginTop: 6 }}>{err}</div>}
    </Glass>
  );
}

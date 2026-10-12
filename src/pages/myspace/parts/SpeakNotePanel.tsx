import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { speakableText, speechMinutes } from "@/lib/speakable";

type Profile = Awaited<ReturnType<typeof api.ttsProfiles>>[number];

/**
 * «Говорящие заметки»: озвучивает открытую заметку выбранным голосом
 * (профили из «Озвучки», в том числе клонированные). Работает на движках
 * озвучки приложения; аудио можно сохранить и слушать в дороге.
 */
export default function SpeakNotePanel({ path, content }: { path: string | null; content: string }) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const timer = useRef<number | null>(null);
  const urlRef = useRef("");

  useEffect(() => {
    let live = true;
    void api
      .ttsProfiles()
      .then((p) => {
        if (!live) return;
        setProfiles(p.filter((x) => x.refFile));
        setProfileId((cur) => cur || p.find((x) => x.refFile)?.id || "");
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (timer.current) window.clearInterval(timer.current);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const text = speakableText(content);

  const speak = async () => {
    const prof = profiles.find((p) => p.id === profileId);
    if (!prof?.refFile || !text) return;
    setBusy(true);
    setErr("");
    setProgress(0);
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = "";
      setUrl("");
    }
    try {
      const title = (path ?? "note").split("/").pop()?.replace(/\.md$/i, "") ?? "note";
      const job = await api.ttsStart({
        refFile: prof.refFile,
        engine: prof.engine ?? "xtts",
        text,
        title,
        author: "MoonApp",
        format: "mp3",
      });
      await new Promise<void>((resolve, reject) => {
        timer.current = window.setInterval(async () => {
          try {
            const s = await api.ttsStatus(job.id);
            const pr = s.progress ?? 0;
            setProgress(Math.round(pr <= 1 ? pr * 100 : pr));
            if (s.stage === "error") {
              window.clearInterval(timer.current ?? 0);
              reject(new Error(s.error || "tts_failed"));
            } else if (s.done) {
              window.clearInterval(timer.current ?? 0);
              const { blob, name: fname } = await api.ttsDownload(job.id);
              const u = URL.createObjectURL(blob);
              urlRef.current = u;
              setUrl(u);
              setName(fname);
              resolve();
            }
          } catch {
            /* повтор на следующем тике */
          }
        }, 1500);
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <b>{t("myspace.speak.title")}</b>
      {profiles.length === 0 ? (
        <div className="muted-sm">{t("myspace.speak.noProfiles")}</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6 }}>
            <select className="input" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Btn icon={Volume2} disabled={busy || !text || !path} onClick={() => void speak()}>
              {busy ? `${progress}%` : t("myspace.speak.run")}
            </Btn>
          </div>
          <div className="muted-sm">{t("myspace.speak.estimate", { min: speechMinutes(text) })}</div>
        </>
      )}
      {err && <div className="muted-sm">{err}</div>}
      {url && (
        <>
          <audio controls src={url} style={{ width: "100%" }} />
          <a className="btn" href={url} download={name || "note.mp3"}>
            {t("myspace.speak.save")}
          </a>
        </>
      )}
    </div>
  );
}

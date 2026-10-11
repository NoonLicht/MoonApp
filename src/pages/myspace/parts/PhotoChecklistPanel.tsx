import { useRef, useState } from "react";
import { Camera } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { openTarget, targetFor } from "@/lib/deepLink";

type Res = Awaited<ReturnType<typeof api.scanPhotoTasks>>;

/**
 * Фото доски или тетради → заметка с картинкой и чек-листом + задачи со
 * ссылкой на исходный кадр. Распознавание локальное (Tesseract), поэтому на
 * рукописном тексте результат нужно просматривать.
 */
export default function PhotoChecklistPanel() {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState("");
  const [createTasks, setCreateTasks] = useState(true);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      setRes(await api.scanPhotoTasks(file, createTasks));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <b>{t("myspace.photo.title")}</b>
      <div className="muted-sm">{t("myspace.photo.hint")}</div>
      <label className="muted-sm">
        <input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} />{" "}
        {t("myspace.photo.createTasks")}
      </label>
      <input
        ref={input}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <Btn icon={Camera} disabled={busy} onClick={() => input.current?.click()}>
        {busy ? t("myspace.photo.busy") : t("myspace.photo.pick")}
      </Btn>
      {err && <div className="muted-sm">{err}</div>}
      {res && (
        <div style={{ fontSize: 12, display: "grid", gap: 3 }}>
          <div>
            {t("myspace.photo.result", { items: res.checklist.items.length, tasks: res.tasks, conf: Math.round(res.confidence) })}
          </div>
          {res.checklist.items.slice(0, 12).map((it, i) => (
            <div key={i}>
              {it.done ? "☑" : "☐"} {it.text}
              {it.important ? " ❗" : ""}
            </div>
          ))}
          <Btn variant="ghost" onClick={() => openTarget(targetFor("note", res.note))}>
            {t("myspace.photo.open")}
          </Btn>
        </div>
      )}
    </div>
  );
}

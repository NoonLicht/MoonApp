import { RotateCcw, X } from "lucide-react";
import type { DocAutosave } from "@/lib/docAutosave";

type Tw = (s: string) => string;

/** Переключатель в строке заголовка документа (как «Автосохранение» в Excel). */
export function AutosaveSwitch({ auto, tw }: { auto: DocAutosave; tw: Tw }) {
  return (
    <button
      type="button"
      className={`wd-autosave${auto.enabled ? " on" : ""}`}
      role="switch"
      aria-checked={auto.enabled}
      title={tw("Autosave keeps a recovery copy of every changed document")}
      onClick={() => auto.setEnabled(!auto.enabled)}
    >
      <span>{tw("Autosave")}</span>
      <i />
    </button>
  );
}

/** Копии несохранённых документов с прошлых сеансов. */
export function RecoverList({ auto, tw }: { auto: DocAutosave; tw: Tw }) {
  if (!auto.recovered.length) return null;
  return (
    <div className="wd-recover">
      <div className="wd-recover-title">{tw("Recover unsaved documents")}</div>
      {auto.recovered.map((e) => (
        <div key={e.key} className="wd-recover-row">
          <span className="wd-recover-name">{e.name}</span>
          <span className="wd-muted">{new Date(e.savedAt).toLocaleString()}</span>
          <button type="button" className="wd-title-btn" onClick={() => void auto.restore(e)}>
            <RotateCcw size={13} />
            {tw("Restore")}
          </button>
          <button type="button" className="wd-x-btn" title={tw("Discard")} onClick={() => void auto.discard(e)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

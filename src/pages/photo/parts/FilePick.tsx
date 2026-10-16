import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useI18n } from "@/app/i18n";

/** Blob/файл → object URL, который освобождается при смене и размонтировании. */
export function useObjectUrl(src: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!src) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(src);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [src]);
  return url;
}

/** Зона выбора файла: клик или перетаскивание. */
export default function FilePick({
  file,
  accept,
  onPick,
  label,
}: {
  file: File | null;
  accept: string;
  onPick: (f: File) => void;
  label?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`ph-drop${over ? " over" : ""}${file ? " has" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => ref.current?.click()}
      onKeyDown={(e) => e.key === "Enter" && ref.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onPick(f);
      }}
    >
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <Upload size={18} />
      <span>{file ? file.name : label || t("photo.pickFile")}</span>
    </div>
  );
}

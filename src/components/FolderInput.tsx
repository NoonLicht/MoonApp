import { FolderOpen } from "lucide-react";
import { useI18n } from "@/app/i18n";

/**
 * Поле выбора папки: путь не вписывается руками — клик открывает системное окно
 * проводника (window.appBridge.pickFolder). Вне Electron (браузерная копия)
 * моста нет, и поле остаётся обычным текстовым.
 */
export default function FolderInput({
  value,
  onChange,
  placeholder,
  className,
  style,
}: {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const pick = window.appBridge?.pickFolder;
  const open = async () => {
    const r = await pick?.();
    if (r?.ok && r.path) onChange(r.path);
  };
  return (
    <div className={`folder-input ${className ?? ""}`} style={style}>
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        readOnly={!!pick}
        onClick={pick ? () => void open() : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {pick && (
        <button type="button" className="btn" onClick={() => void open()}>
          <FolderOpen size={14} /> {t("common.browse")}
        </button>
      )}
    </div>
  );
}

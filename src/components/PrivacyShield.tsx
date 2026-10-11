import { useCallback, useEffect, useRef, useState } from "react";
import { onHotkey } from "@/lib/hotkeys";
import { useI18n } from "@/app/i18n";

/**
 * Режим «чужой за столом»: по горячей клавише (Ctrl+Alt+H, работает и когда
 * окно не в фокусе) всё окно закрывается нейтральной страницей, а заголовок
 * документа и окна становится безликим. Повторное нажатие, Esc или двойной
 * клик возвращают приложение.
 */
export default function PrivacyShield() {
  const { t } = useI18n();
  const [on, setOn] = useState(false);
  const onRef = useRef(false);
  const saved = useRef("");
  const neutral = useRef("");
  neutral.current = t("privacy.docTitle");

  const set = useCallback((next: boolean, notifyMain: boolean) => {
    if (onRef.current === next) return;
    onRef.current = next;
    setOn(next);
    if (notifyMain) void window.appBridge?.privacySet?.(next);
  }, []);

  // Заголовок документа: подменяем при включении, возвращаем при выключении.
  useEffect(() => {
    if (on) {
      saved.current = document.title;
      document.title = neutral.current;
      return () => {
        document.title = saved.current;
      };
    }
    return undefined;
  }, [on]);

  useEffect(() => {
    const offMain = window.appBridge?.onPrivacy?.((active) => set(active, false));
    const offKey = onHotkey("privacy", (e) => {
      e.preventDefault();
      set(!onRef.current, true);
    });
    return () => {
      offMain?.();
      offKey();
    };
  }, [set]);

  useEffect(() => {
    if (!on) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") set(false, true);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [on, set]);

  if (!on) return null;
  return (
    <div
      role="presentation"
      onDoubleClick={() => set(false, true)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000,
        background: "#f3f3f3",
        color: "#222",
        display: "flex",
        flexDirection: "column",
        fontFamily: "Calibri, 'Segoe UI', Arial, sans-serif",
        cursor: "default",
      }}
    >
      <div style={{ background: "#2b579a", color: "#fff", padding: "6px 14px", fontSize: 13 }}>
        {t("privacy.docTitle")}
      </div>
      <div style={{ flex: 1, overflow: "hidden", display: "flex", justifyContent: "center", padding: 24 }}>
        <div
          style={{
            background: "#fff",
            width: "min(760px, 100%)",
            padding: "48px 56px",
            boxShadow: "0 1px 6px rgba(0,0,0,.2)",
          }}
        >
          <div style={{ fontSize: 22, marginBottom: 20 }}>{t("privacy.heading")}</div>
          {Array.from({ length: 14 }, (_, i) => (
            <div
              key={i}
              style={{
                height: 10,
                margin: "14px 0",
                background: "#e4e4e4",
                borderRadius: 2,
                width: `${96 - ((i * 7) % 31)}%`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

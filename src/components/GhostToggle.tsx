import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ghost, X } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { openTarget, targetFor, SOURCE_LABEL } from "@/lib/deepLink";
import type { SemSource } from "@/api/apiSemantic";

type Result = Awaited<ReturnType<typeof api.ghostContext>>;

const POLL_MS = 6000;

/**
 * Ghost Context: кнопка в верхней панели и боковая панель связанных заметок,
 * лекций, трат и задач. Контекст — выделение внутри приложения или заголовок
 * активного окна другой программы. Выключено, пока пользователь не включит.
 */
export default function GhostToggle() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [res, setRes] = useState<Result>({ query: "", groups: [] });
  const lastKey = useRef("");

  useEffect(() => {
    if (!open) return;
    void (api.getSettings() as Promise<{ ghost?: { enabled?: boolean } }>)
      .then((s) => setEnabled(s?.ghost?.enabled === true))
      .catch(() => undefined);
  }, [open]);

  const tick = useCallback(async () => {
    try {
      let title = "";
      let text = "";
      if (document.hasFocus()) {
        // внутри приложения: выделенный текст и заголовок текущего раздела
        text = String(window.getSelection?.()?.toString() ?? "").slice(0, 4000);
        title = document.querySelector(".tb-title")?.textContent ?? "";
      } else {
        title = (await api.ghostActive()).title;
      }
      const key = `${title}\u0000${text.slice(0, 200)}`;
      if (key === lastKey.current) return;
      lastKey.current = key;
      setRes(await api.ghostContext(title, text));
    } catch {
      /* сервер занят — попробуем на следующем тике */
    }
  }, []);

  useEffect(() => {
    if (!open || !enabled) return;
    const first = setTimeout(() => void tick(), 0);
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [open, enabled, tick]);

  const toggleEnabled = async (next: boolean) => {
    setEnabled(next);
    lastKey.current = "";
    try {
      await api.updateSettings({ ghost: { enabled: next } });
    } catch {
      setEnabled(!next);
    }
  };

  return (
    <>
      <button
        className="task-mgr-toggle no-drag"
        onClick={() => setOpen((v) => !v)}
        title={t("ghost.title")}
        aria-label={t("ghost.title")}
      >
        <Ghost size={15} />
      </button>
      {open &&
        /* Портал: внутри тулбара (backdrop-filter) position:fixed считался бы от
           самого тулбара — панель превращалась в тонкую полоску справа сверху. */
        createPortal(
          <aside className="ghost-panel no-drag" aria-label={t("ghost.title")}>
            <div className="ghost-head">
              <b>{t("ghost.title")}</b>
              <button
                className="ghost-x"
                onClick={() => setOpen(false)}
                aria-label={t("common.close")}
              >
                <X size={14} />
              </button>
            </div>
            {!enabled ? (
              <div className="ghost-body">
                <p className="muted-sm">{t("ghost.off")}</p>
                <button className="btn" onClick={() => void toggleEnabled(true)}>
                  {t("ghost.enable")}
                </button>
              </div>
            ) : (
              <div className="ghost-body">
                {res.query && (
                  <div className="muted-sm">
                    {t("ghost.because")}: <i>{res.query}</i>
                  </div>
                )}
                {res.groups.length === 0 && <p className="muted-sm">{t("ghost.empty")}</p>}
                {res.groups.map((g) => (
                  <div key={g.source} className="ghost-group">
                    <div className="ghost-group-title">{SOURCE_LABEL[g.source as SemSource]}</div>
                    {g.items.map((h) => (
                      <button
                        key={`${h.source}-${h.ref}-${h.at ?? ""}`}
                        className="ghost-item"
                        onClick={() => openTarget(targetFor(h.source as SemSource, h.ref, h.at))}
                      >
                        <span className="ghost-item-title">{h.title}</span>
                        <span className="muted-sm">{h.snippet.slice(0, 90)}</span>
                      </button>
                    ))}
                  </div>
                ))}
                <button className="ghost-off" onClick={() => void toggleEnabled(false)}>
                  {t("ghost.disable")}
                </button>
              </div>
            )}
          </aside>,
          document.body,
        )}
    </>
  );
}

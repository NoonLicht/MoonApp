import { getOverlayRoot } from "@/components/overlayHost";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ghost, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { openTarget, targetFor, SOURCE_LABEL } from "@/lib/deepLink";
import type { SemSource } from "@/api/apiSemantic";

type Result = Awaited<ReturnType<typeof api.ghostContext>>;

const POLL_MS = 6000;
const LS = "moonapp.ghost.dock";
const MIN_W = 260;
const MAX_W = 640;
const COLLAPSED_W = 48;
const GAP = 8;

interface DockState {
  open: boolean;
  collapsed: boolean;
  width: number;
}

function loadDock(): DockState {
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || "{}") as Partial<DockState>;
    return {
      open: raw.open === true,
      collapsed: raw.collapsed === true,
      width: Math.min(MAX_W, Math.max(MIN_W, Number(raw.width) || 340)),
    };
  } catch {
    return { open: false, collapsed: false, width: 340 };
  }
}

/**
 * Ghost Context: кнопка в верхней панели и закрепляемая справа панель
 * связанных заметок, лекций, трат и задач (как меню страниц слева). Панель
 * остаётся на каждой странице, пока её не выключат той же кнопкой; её можно
 * свернуть до полоски и растянуть за левый край.
 */
export default function GhostToggle() {
  const { t } = useI18n();
  const [dock, setDock] = useState<DockState>(loadDock);
  const [enabled, setEnabled] = useState(false);
  const [res, setRes] = useState<Result>({ query: "", groups: [] });
  const lastKey = useRef("");
  const { open, collapsed, width } = dock;

  // Запоминаем состояние панели между запусками.
  useEffect(() => {
    try {
      localStorage.setItem(LS, JSON.stringify(dock));
    } catch {
      /* без localStorage состояние просто не запомнится */
    }
  }, [dock]);

  // Контент страниц сдвигается на ширину панели (см. .content-area в theme.css).
  useEffect(() => {
    const root = document.documentElement;
    const w = open ? (collapsed ? COLLAPSED_W : width) + GAP * 2 : 0;
    root.style.setProperty("--ghost-w", `${w}px`);
    return () => {
      root.style.setProperty("--ghost-w", "0px");
    };
  }, [open, collapsed, width]);

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
    if (!open || !enabled || collapsed) return;
    const first = setTimeout(() => void tick(), 0);
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [open, enabled, collapsed, tick]);

  const toggleEnabled = async (next: boolean) => {
    setEnabled(next);
    lastKey.current = "";
    try {
      await api.updateSettings({ ghost: { enabled: next } });
    } catch {
      setEnabled(!next);
    }
  };

  // Растягивание за левый край: двигаем мышь — ширина = расстояние до правого края.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const w = window.innerWidth - ev.clientX - GAP;
      setDock((d) => ({ ...d, width: Math.min(MAX_W, Math.max(MIN_W, Math.round(w))) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const root = getOverlayRoot() ?? document.body;

  return (
    <>
      <button
        className={`task-mgr-toggle no-drag ${open ? "is-active" : ""}`}
        onClick={() => setDock((d) => ({ ...d, open: !d.open }))}
        title={t("ghost.title")}
        aria-label={t("ghost.title")}
        aria-pressed={open}
      >
        <Ghost size={15} />
      </button>
      {open &&
        createPortal(
          <aside
            className={`ghost-dock no-drag ${collapsed ? "is-collapsed" : ""}`}
            style={{ width: collapsed ? COLLAPSED_W : width }}
            aria-label={t("ghost.title")}
          >
            {!collapsed && (
              <div
                className="ghost-resize"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startResize}
              />
            )}
            <div className="ghost-head">
              <button
                className="ghost-x"
                onClick={() => setDock((d) => ({ ...d, collapsed: !d.collapsed }))}
                title={t(collapsed ? "nav.expand" : "nav.collapse")}
                aria-label={t(collapsed ? "nav.expand" : "nav.collapse")}
              >
                {collapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
              </button>
              {!collapsed && <b className="ghost-title">{t("ghost.title")}</b>}
              {!collapsed && (
                <button
                  className="ghost-x"
                  onClick={() => setDock((d) => ({ ...d, open: false }))}
                  aria-label={t("common.close")}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {!collapsed &&
              (!enabled ? (
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
              ))}
          </aside>,
          root,
        )}
    </>
  );
}

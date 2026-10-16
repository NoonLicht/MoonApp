import { getOverlayRoot } from "@/components/overlayHost";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ghost, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { useI18n, tNow } from "@/app/i18n";
import { api } from "@/api/client";
import { openTarget, targetFor, SOURCE_LABEL } from "@/lib/deepLink";
import type { SemSource } from "@/api/apiSemantic";
import type { PageId } from "@/app/navigation";
import { PAGES } from "@/app/navigation";
import { isPageEnabled } from "@/app/pageAccess";

type Hit = Result["groups"][number]["items"][number];

/** Подсказки, которые не лежат в семантическом индексе (см. server/ts/ghostExtras.ts). */
const EXTRA_TARGET: Record<string, (h: Hit) => { page: PageId; view?: string; ref?: string } | null> = {
  diary: (h) => ({ page: "diary", ref: h.ref }),
  contract: () => ({ page: "diary" }),
  shot: (h) => ({ page: "screenshots", ref: h.ref }),
  clip: () => null,
  vault: () => ({ page: "settings" }),
  due: (h) => ({ page: "myspace", view: "tasks", ref: h.ref }),
  schedule: () => ({ page: "automation" }),
  app: () => ({ page: "monitor" }),
  spend: () => ({ page: "budget" }),
};
const RECENT_KEY = "moonapp.ghost.recent";

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
  // Последнее выделение: на нём строятся быстрые действия и проверка противоречий.
  const [aiMode, setAiMode] = useState(true);
  const [selection, setSelection] = useState("");
  const [note, setNote] = useState("");
  const [conflicts, setConflicts] = useState<
    { claim: string; source: string; ref: string; passage: string }[] | null
  >(null);
  const [recent, setRecent] = useState<{ id: PageId; title: string }[]>([]);

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
    void (api.getSettings() as Promise<{ ghost?: { enabled?: boolean; ai?: boolean } }>)
      .then((s) => {
        setEnabled(s?.ghost?.enabled === true);
        setAiMode(s?.ghost?.ai !== false);
      })
      .catch(() => undefined);
  }, [open]);

  const tick = useCallback(async () => {
    if (document.visibilityState === "hidden") return;
    try {
      let title = "";
      let text = "";
      if (document.hasFocus()) {
        // внутри приложения: выделенный текст и заголовок текущего раздела
        text = String(window.getSelection?.()?.toString() ?? "").slice(0, 4000);
        // название раздела — слишком общий запрос: ищем только по выделению
      } else {
        title = (await api.ghostActive()).title;
      }
      if (text.trim().length >= 3) setSelection(text.trim());
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

  // Недавние страницы: запоминаем смену заголовка в верхней панели.
  useEffect(() => {
    if (!open) return;
    const byTitle = new Map(
      PAGES.filter((p) => isPageEnabled(p.id)).map((p) => [tNow(p.i18n), p.id as PageId]),
    );
    const read = (): { id: PageId; title: string }[] => {
      try {
        return JSON.parse(sessionStorage.getItem(RECENT_KEY) || "[]");
      } catch {
        return [];
      }
    };
    const push = () => {
      const title = document.querySelector(".tb-title")?.textContent?.trim() ?? "";
      const id = byTitle.get(title);
      if (!id) return;
      const list = [{ id, title }, ...read().filter((x) => x.id !== id)].slice(0, 6);
      try {
        sessionStorage.setItem(RECENT_KEY, JSON.stringify(list));
      } catch {
        /* sessionStorage недоступен — просто не запоминаем */
      }
      setRecent(list);
    };
    push();
    const timer = setInterval(push, 1500);
    return () => clearInterval(timer);
  }, [open]);

  const flash = (m: string) => {
    setNote(m);
    setTimeout(() => setNote(""), 2500);
  };

  const makeTask = async () => {
    try {
      await api.tasksCreate({
        title: selection.replace(/\s+/g, " ").slice(0, 80),
        description: selection,
      });
      flash(tNow("ghost.taskCreated"));
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const via = async (page: PageId) => {
    try {
      await navigator.clipboard.writeText(selection);
      flash(tNow("ghost.copiedToPaste"));
    } catch {
      /* буфер недоступен — просто переходим */
    }
    openTarget({ page });
  };

  const findConflicts = async () => {
    flash(tNow("ghost.checking"));
    try {
      const r = await api.mindContradictions("", selection);
      setConflicts(r.findings);
      flash(r.findings.length ? "" : tNow("ghost.noConflicts"));
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const openHit = (h: Hit) => {
    const ex = EXTRA_TARGET[h.source];
    if (ex) {
      if (h.source === "clip") {
        void navigator.clipboard.writeText(h.snippet).then(() => flash(tNow("ghost.copied")));
        return;
      }
      const t = ex(h);
      if (t) openTarget(t);
      return;
    }
    openTarget(targetFor(h.source as SemSource, h.ref, h.at));
  };

  const groupLabel = (source: string): string =>
    EXTRA_TARGET[source] || source === "tag"
      ? tNow(`ghost.g_${source}`)
      : SOURCE_LABEL[source as SemSource];

  const toggleEnabled = async (next: boolean) => {
    setEnabled(next);
    lastKey.current = "";
    try {
      await api.updateSettings({ ghost: { enabled: next } });
    } catch {
      setEnabled(!next);
    }
  };

  const chooseMode = async (ai: boolean) => {
    if (ai === aiMode) return;
    setAiMode(ai);
    lastKey.current = "";
    try {
      await api.updateSettings({ ghost: { ai } });
      void tick();
    } catch {
      setAiMode(!ai);
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

  const root = typeof document === "undefined" ? null : (getOverlayRoot() ?? document.body);

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
      {open && root &&
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
                      <div className="ghost-group-title">{groupLabel(g.source)}</div>
                      {g.items.map((h) => (
                        <button
                          key={`${h.source}-${h.ref}-${h.at ?? ""}`}
                          className="ghost-item"
                          onClick={() => openHit(h)}
                        >
                          {h.source === "shot" && h.snippet === "image" && (
                            <img
                              className="ghost-shot-img"
                              src={api.screenshotFileUrl(h.ref)}
                              alt=""
                              loading="lazy"
                              draggable={false}
                            />
                          )}
                          <span className="ghost-item-title">{h.title}</span>
                          <span className="muted-sm">{h.why || h.snippet.slice(0, 90)}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {conflicts && conflicts.length > 0 && (
                    <div className="ghost-group">
                      <div className="ghost-group-title">{t("ghost.g_conflicts")}</div>
                      {conflicts.slice(0, 4).map((c, i) => (
                        <button
                          key={i}
                          className="ghost-item"
                          onClick={() => openTarget(targetFor("note", c.ref))}
                        >
                          <span className="ghost-item-title">{c.source}</span>
                          <span className="muted-sm">{c.passage.slice(0, 110)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {recent.length > 0 && (
                    <div className="ghost-group">
                      <div className="ghost-group-title">{t("ghost.g_recent")}</div>
                      <div className="ghost-chips">
                        {recent.map((r) => (
                          <button
                            key={r.id}
                            className="ghost-chip"
                            onClick={() => openTarget({ page: r.id })}
                          >
                            {r.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {selection && (
                    <div className="ghost-group">
                      <div className="ghost-group-title">{t("ghost.actions")}</div>
                      <div className="ghost-quote">{selection.slice(0, 140)}</div>
                      <div className="ghost-chips">
                        <button className="ghost-chip" onClick={() => void makeTask()}>
                          {t("ghost.actTask")}
                        </button>
                        <button className="ghost-chip" onClick={() => void via("aichat")}>
                          {t("ghost.actAsk")}
                        </button>
                        <button className="ghost-chip" onClick={() => void via("translate")}>
                          {t("ghost.actTranslate")}
                        </button>
                        <button className="ghost-chip" onClick={() => void findConflicts()}>
                          {t("ghost.actConflicts")}
                        </button>
                        <button className="ghost-chip" onClick={() => setSelection("")}>
                          {t("ghost.actClear")}
                        </button>
                      </div>
                    </div>
                  )}
                  {note && <div className="muted-sm ghost-note">{note}</div>}
                  <div className="ghost-mode" role="group" aria-label={t("ghost.mode")}>
                    <button
                      className={`ghost-chip${!aiMode ? " on" : ""}`}
                      title={t("ghost.modeLocalHint")}
                      onClick={() => void chooseMode(false)}
                    >
                      {t("ghost.modeLocal")}
                    </button>
                    <button
                      className={`ghost-chip${aiMode ? " on" : ""}`}
                      title={t("ghost.modeAiHint")}
                      onClick={() => void chooseMode(true)}
                    >
                      {t("ghost.modeAi")}
                    </button>
                  </div>
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

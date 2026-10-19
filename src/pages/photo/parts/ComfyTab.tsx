import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Square } from "lucide-react";
import { Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { ComfyGraph, ComfyNodeInfo, ComfyStatus } from "@/api/apiComfy";
import ComfySetup from "@/pages/photo/parts/ComfySetup";
import ComfyAdmin from "@/pages/photo/parts/ComfyAdmin";
import GenerateView from "@/pages/photo/parts/ComfyGenerateView";
import ModelsView from "@/pages/photo/parts/ComfyModelsView";
import LibraryView from "@/pages/photo/parts/ComfyLibraryView";
import { loadFile, loadWorkflow, readWorkflow } from "@/pages/photo/lib/comfyEditorBridge";

type View = "editor" | "gen" | "models" | "library" | "settings";
/** Родной интерфейс ComfyUI — первый и открывается сразу; остальное — удобства приложения. */
const VIEWS: View[] = ["editor", "gen", "models", "library", "settings"];

/**
 * ComfyUI во вкладке «Фото и видео»: настоящий интерфейс ComfyUI (граф, менеджер узлов и моделей,
 * очередь, шаблоны, расширения) открывается сразу на всю вкладку, рядом — удобства приложения
 * (пресеты, модели, библиотека, помощник на локальной модели, настройки запуска и обновление).
 * Воркфлоу любых видов и версий работают в самом ComfyUI, поэтому совместимость полная.
 */
export default function ComfyTab({ active }: { active: boolean }) {
  const { t } = useI18n();
  const [st, setSt] = useState<ComfyStatus | null>(null);
  const [view, setView] = useState<View>("editor");
  const [editorSeen, setEditorSeen] = useState(true);
  const [info, setInfo] = useState<Record<string, ComfyNodeInfo>>({});
  const [pending, setPending] = useState<ComfyGraph | null>(null);
  const [msg, setMsg] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);

  const refresh = useCallback(async () => {
    try {
      setSt(await api.comfyStatus());
    } catch {
      /* сервер перезапускается */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const id = setInterval(() => void refresh(), 1500);
    return () => clearInterval(id);
  }, [active, refresh]);

  const ready = !!st?.ready;
  useEffect(() => {
    if (!ready) {
      setInfo({});
      return;
    }
    void api
      .comfyObjectInfo()
      .then(setInfo)
      .catch(() => setInfo({}));
  }, [ready]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    }
    void refresh();
  };

  const openInEditor = useCallback(
    async (wf: unknown, name?: string): Promise<void> => {
      setEditorSeen(true);
      setView("editor");
      // Рамка могла только что смонтироваться: дожидаемся её загрузки внутри loadWorkflow/loadFile.
      await new Promise((r) => setTimeout(r, 50));
      const ok =
        wf instanceof File
          ? await loadFile(frame.current, wf)
          : await loadWorkflow(frame.current, wf, name);
      if (!ok) setMsg(t("photo.comfy.editorNotReady"));
    },
    [t],
  );

  const editorToApi = useCallback(async (): Promise<ComfyGraph | null> => {
    const r = await readWorkflow(frame.current);
    return r?.output ?? null;
  }, []);

  if (!st)
    return (
      <div className="ph-tab">
        <Glass className="ph-card">
          <div className="muted-sm">{t("photo.working")}</div>
        </Glass>
      </div>
    );

  const showWork = st.installed && st.running;

  return (
    <div className="cf-tab cf-root">
      {showWork ? (
        <div className="cf-bar">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              className={`cf-bar-tab${view === v ? " active" : ""}`}
              onClick={() => setView(v)}
            >
              {t(`photo.comfy.view.${v}`)}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {!st.ready && <span className="muted-sm">{t("photo.comfy.startingHint")}</span>}
          <button
            type="button"
            className="cf-bar-ico"
            title={t("photo.comfy.openWindow")}
            aria-label={t("photo.comfy.openWindow")}
            onClick={() => window.open("/api/comfy/ui/", "_blank", "noopener")}
          >
            <ExternalLink size={14} />
          </button>
          <button
            type="button"
            className="cf-bar-ico stop"
            title={t("photo.comfy.stop")}
            aria-label={t("photo.comfy.stop")}
            onClick={() => void act(() => api.comfyStop())}
          >
            <Square size={13} />
          </button>
        </div>
      ) : null}
      {msg && <div className="ph-error">{msg}</div>}
      {!showWork && (
        <div className="cf-scroll">
          <ComfySetup st={st} act={act} />
          {st.installed && <ComfyAdmin st={st} act={act} />}
        </div>
      )}
      {showWork && st.ready && editorSeen && (
        <iframe
          ref={frame}
          className="cf-frame"
          title="ComfyUI"
          src="/api/comfy/ui/"
          style={view === "editor" ? undefined : { display: "none" }}
        />
      )}
      {showWork && view !== "editor" && (
        <div className="cf-scroll">
          {st.ready && view === "gen" && (
            <GenerateView
              info={info}
              openInEditor={openInEditor}
              editorToApi={editorToApi}
              pending={pending}
              onPendingUsed={() => setPending(null)}
            />
          )}
          {view === "settings" && <ComfyAdmin st={st} act={act} />}
          {view === "models" && <ModelsView />}
          {view === "library" && (
            <LibraryView
              openInEditor={openInEditor}
              run={(g) => {
                setView("gen");
                setPending(g);
              }}
              reloadKey={0}
            />
          )}
        </div>
      )}
    </div>
  );
}

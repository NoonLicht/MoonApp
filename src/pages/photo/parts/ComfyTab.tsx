import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, FolderOpen, Play, Save } from "lucide-react";
import { Glass, Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";
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

const saveJson = (data: unknown, name: string): void =>
  saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), name);

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
  const [libKey, setLibKey] = useState(0);
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

  const saveToLibrary = async (): Promise<void> => {
    const r = await readWorkflow(frame.current);
    if (!r) return void setMsg(t("photo.comfy.editorNotReady"));
    const name = window.prompt(
      t("photo.comfy.saveName"),
      `workflow-${new Date().toISOString().slice(0, 10)}`,
    );
    if (!name) return;
    await act(() =>
      api.comfyWorkflowSave(name.replace(/[^\w.\- ]/g, "_").slice(0, 80), r.workflow),
    );
    setLibKey((k) => k + 1);
  };

  const runFromEditor = async (): Promise<void> => {
    const g = await editorToApi();
    if (!g) return void setMsg(t("photo.comfy.editorNotReady"));
    setView("gen");
    setPending(g);
  };

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
    <div className="ph-tab cf-tab">
      <ComfySetup st={st} act={act} />
      {msg && <div className="ph-error">{msg}</div>}
      {st.installed && !showWork && <ComfyAdmin st={st} act={act} />}
      {showWork && (
        <>
          <div className="page-tabs">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                className={`page-tab${view === v ? " active" : ""}`}
                onClick={() => {
                  if (v === "editor") setEditorSeen(true);
                  setView(v);
                }}
              >
                {t(`photo.comfy.view.${v}`)}
              </button>
            ))}
          </div>
          {!st.ready && <div className="muted-sm">{t("photo.comfy.startingHint")}</div>}
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
              reloadKey={libKey}
            />
          )}
          {st.ready && editorSeen && (
            <div
              className="cf-editor cf-native"
              style={view === "editor" ? undefined : { display: "none" }}
            >
              <div className="ph-row">
                <Btn icon={Play} variant="primary" onClick={() => void runFromEditor()}>
                  {t("photo.comfy.runInApp")}
                </Btn>
                <Btn icon={Save} onClick={() => void saveToLibrary()}>
                  {t("photo.comfy.saveLibrary")}
                </Btn>
                <Btn
                  icon={Download}
                  onClick={() =>
                    void readWorkflow(frame.current).then((r) =>
                      r
                        ? saveJson(r.workflow, "workflow.json")
                        : setMsg(t("photo.comfy.editorNotReady")),
                    )
                  }
                >
                  {t("photo.comfy.exportWorkflow")}
                </Btn>
                <Btn
                  icon={FolderOpen}
                  onClick={() =>
                    void readWorkflow(frame.current).then((r) =>
                      r
                        ? saveJson(r.output, "workflow_api.json")
                        : setMsg(t("photo.comfy.editorNotReady")),
                    )
                  }
                >
                  {t("photo.comfy.exportApi")}
                </Btn>
                <span style={{ flex: 1 }} />
                <Btn
                  icon={ExternalLink}
                  onClick={() => window.open("/api/comfy/ui/", "_blank", "noopener")}
                >
                  {t("photo.comfy.openWindow")}
                </Btn>
              </div>
              <iframe ref={frame} className="cf-frame" title="ComfyUI" src="/api/comfy/ui/" />
            </div>
          )}
        </>
      )}
    </div>
  );
}

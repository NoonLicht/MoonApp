import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Trash2, X, Check } from "lucide-react";
import { Glass, Btn, Badge, ProgressBar, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { PhotoTool, PhotoToolsState } from "@/api/apiPhoto";

/**
 * Состояние внешних инструментов (InvSR, Deep-Live-Cam): установлены ли, идёт ли установка.
 * Пока установка идёт — опрашиваем сервер раз в 1.5 с, иначе один раз при входе.
 */
export function useToolsState(fetcher: () => Promise<PhotoToolsState>): {
  state: PhotoToolsState | null;
  reload: () => Promise<void>;
  tool: (id: PhotoTool["id"]) => PhotoTool | undefined;
} {
  const [state, setState] = useState<PhotoToolsState | null>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const s = await fetcher();
      if (alive.current) setState(s);
    } catch {
      /* сервер перезапускается — следующий опрос повторит */
    }
  }, [fetcher]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  const working = state?.install.state.state === "working";
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void reload(), 1500);
    return () => clearInterval(t);
  }, [working, reload]);

  return { state, reload, tool: (id) => state?.tools.find((x) => x.id === id) };
}

/** Карточка установки инструмента: устройство, размер, прогресс, лог, удаление. */
/** Действия над окружением инструмента (свои маршруты у каждой страницы). */
export interface ToolActions {
  install(id: string, device: "cuda" | "cpu"): Promise<unknown>;
  cancel(): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

export default function ToolInstall({
  id,
  state,
  reload,
  actions,
}: {
  id: PhotoTool["id"];
  state: PhotoToolsState | null;
  reload: () => Promise<void>;
  actions: ToolActions;
}) {
  const { t } = useI18n();
  const [device, setDevice] = useState<"cuda" | "cpu">("cuda");
  const [err, setErr] = useState("");
  const tool = state?.tools.find((x) => x.id === id);
  const inst = state?.install;
  const mine = inst?.tool === id;
  const working = mine && inst?.state.state === "working";
  const failed = mine && inst?.state.state === "error";

  if (!tool) return null;

  const start = async (): Promise<void> => {
    setErr("");
    try {
      await actions.install(id, device);
    } catch (e) {
      setErr(String((e as Error).message));
    }
    void reload();
  };

  const stop = async (): Promise<void> => {
    await actions.cancel().catch(() => undefined);
    void reload();
  };

  const remove = async (): Promise<void> => {
    setErr("");
    try {
      await actions.remove(id);
    } catch (e) {
      setErr(String((e as Error).message));
    }
    void reload();
  };

  return (
    <Glass className="ph-card ph-install">
      <div className="ph-row">
        <b>{tool.title}</b>
        <Badge tone={tool.ready ? "teal" : "amber"}>
          {tool.ready ? (
            <>
              <Check size={11} /> {t("photo.ready")}
            </>
          ) : (
            t("photo.notInstalled")
          )}
        </Badge>
        <span className="muted-sm">{tool.license}</span>
      </div>
      <div className="muted-sm">{tool.note}</div>

      {!tool.ready && !working && (
        <div className="ph-row">
          <Select
            value={device}
            onChange={(e) => setDevice(e.target.value as "cuda" | "cpu")}
            options={[
              { value: "cuda", label: `${t("photo.deviceGpu")} (~${tool.sizeMb.cuda} MB)` },
              { value: "cpu", label: `${t("photo.deviceCpu")} (~${tool.sizeMb.cpu} MB)` },
            ]}
          />
          <Btn variant="primary" icon={Download} onClick={() => void start()}>
            {t("photo.install")}
          </Btn>
        </div>
      )}

      {working && inst && (
        <>
          <ProgressBar value={inst.state.progress} />
          <div className="ph-row">
            <span className="muted-sm">
              {t("photo.step")}: {inst.step} · {inst.state.progress}%
            </span>
            <Btn icon={X} onClick={() => void stop()}>
              {t("photo.cancel")}
            </Btn>
          </div>
        </>
      )}

      {(working || failed) && inst && inst.log.length > 0 && (
        <pre className="ph-log">{inst.log.slice(-12).join("\n")}</pre>
      )}
      {failed && inst && <div className="ph-error">{inst.state.error}</div>}
      {err && <div className="ph-error">{err}</div>}

      {tool.installed && !working && (
        <div className="ph-row">
          <Btn icon={Trash2} onClick={() => void remove()}>
            {t("photo.remove")}
          </Btn>
        </div>
      )}
    </Glass>
  );
}

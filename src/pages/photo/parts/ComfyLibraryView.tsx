import { useCallback, useEffect, useState } from "react";
import { Pencil, Play, Trash2 } from "lucide-react";
import { Glass, Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { ComfyGraph } from "@/api/apiComfy";
import { isApiGraph } from "@/pages/photo/lib/comfyPresets";

/** Свои воркфлоу: сохранённые из редактора, от помощника или импортированные. */
export default function LibraryView({
  openInEditor,
  run,
  reloadKey,
}: {
  openInEditor: (wf: unknown, name?: string) => void | Promise<void>;
  run: (g: ComfyGraph) => void;
  reloadKey: number;
}) {
  const { t } = useI18n();
  const [list, setList] = useState<{ id: string; at: number }[]>([]);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      setList((await api.comfyWorkflows()).workflows);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  return (
    <div className="ph-tab">
      <Glass className="ph-card">
        <b>{t("photo.comfy.library")}</b>
        <div className="muted-sm">{t("photo.comfy.libraryHint")}</div>
        {!list.length && <div className="muted-sm">{t("photo.comfy.libraryEmpty")}</div>}
        {list.map((w) => (
          <div key={w.id} className="ph-row">
            <span style={{ flex: 1 }}>{w.id}</span>
            <span className="muted-sm">{new Date(w.at).toLocaleString()}</span>
            <Btn
              icon={Pencil}
              onClick={() =>
                void api.comfyWorkflowGet(w.id).then((wf) => openInEditor(wf, w.id)).catch((e) => setErr((e as Error).message))
              }
            >
              {t("photo.comfy.open")}
            </Btn>
            <Btn
              icon={Play}
              onClick={() =>
                void api
                  .comfyWorkflowGet(w.id)
                  .then(async (wf) => {
                    if (isApiGraph(wf)) run(wf);
                    else await openInEditor(wf, w.id);
                  })
                  .catch((e) => setErr((e as Error).message))
              }
            >
              {t("photo.comfy.run")}
            </Btn>
            <Btn
              icon={Trash2}
              onClick={() => void api.comfyWorkflowDelete(w.id).then(load).catch((e) => setErr((e as Error).message))}
            >
              {t("translate.delete")}
            </Btn>
          </div>
        ))}
        {err && <div className="ph-error">{err}</div>}
      </Glass>
    </div>
  );
}

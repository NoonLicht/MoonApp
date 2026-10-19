import { useCallback, useEffect, useState } from "react";
import { Download, FolderOpen, Plus, Search, Trash2, X } from "lucide-react";
import { Glass, Btn, ProgressBar, Select, Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { ComfyHf, ComfyModels } from "@/api/apiComfy";

const mb = (n: number): string =>
  n < 1024 ? `${Math.round(n)} MB` : `${(n / 1024).toFixed(1)} GB`;

const FOLDERS = [
  "checkpoints",
  "diffusion_models",
  "text_encoders",
  "vae",
  "loras",
  "controlnet",
  "upscale_models",
  "clip_vision",
  "embeddings",
];

/** Модели ComfyUI: установленные, рекомендуемые и добавление по ссылке Hugging Face. */
export default function ModelsView() {
  const { t } = useI18n();
  const [data, setData] = useState<ComfyModels | null>(null);
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("checkpoints");
  const [repo, setRepo] = useState<ComfyHf | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const [local, setLocal] = useState("");
  const [localFolder, setLocalFolder] = useState("checkpoints");
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.comfyModels());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 2000);
    return () => clearInterval(id);
  }, [load]);

  const dl = data?.download;
  const downloading = dl?.status === "downloading";
  const have = (folderName: string, file: string): boolean =>
    !!data?.models.some(
      (m) => m.folder === folderName && m.file === (file.split("/").pop() ?? file),
    );
  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
    void load();
  };

  const browse = async (): Promise<void> => {
    const r = await window.appBridge?.pickFile?.({
      filters: [
        { name: "Models", extensions: ["safetensors", "ckpt", "pt", "pth", "bin", "gguf", "sft"] },
      ],
    });
    if (r?.ok && r.path) setLocal(r.path);
  };
  const importLocal = async (): Promise<void> => {
    setImporting(true);
    await guard(async () => {
      await api.comfyModelImport(local.trim().replace(/^"|"$/g, ""), localFolder);
      setLocal("");
    });
    setImporting(false);
  };

  const look = async (): Promise<void> => {
    if (!url.trim()) return;
    setErr("");
    try {
      const r = await api.comfyHf(url.trim());
      setRepo(r);
      setPicked(r.file ? new Set([r.file]) : new Set());
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="ph-tab">
      <Glass className="ph-card">
        <b>{t("photo.comfy.recommended")}</b>
        <div className="muted-sm">{t("photo.comfy.recommendedHint")}</div>
        {data?.recommended.map((r) => {
          const ok = have(r.folder, r.file);
          return (
            <div key={r.id} className="ph-row">
              <span style={{ flex: 1 }}>
                {t(`photo.comfy.rec.${r.id}`)} · {mb(r.sizeMb)}
                <span className="muted-sm"> · {r.folder}</span>
              </span>
              {ok ? (
                <Badge tone="teal">{t("translate.installed")}</Badge>
              ) : (
                <Btn
                  icon={Download}
                  disabled={downloading}
                  onClick={() => void guard(() => api.comfyModelDownload({ recommended: r.id }))}
                >
                  {t("translate.download")}
                </Btn>
              )}
            </div>
          );
        })}
        <div className="muted-sm">{t("photo.comfy.sharedHint")}</div>
        {downloading && dl && (
          <>
            <ProgressBar value={dl.total ? (dl.bytes / dl.total) * 100 : 0} />
            <div className="ph-row">
              <span className="muted-sm">
                {dl.file} · {mb(dl.bytes / 1048576)} / {mb(dl.total / 1048576)}
                {dl.count > 1 && ` · ${dl.index + 1}/${dl.count}`}
              </span>
              <Btn icon={X} onClick={() => void guard(() => api.comfyModelCancel())}>
                {t("photo.cancel")}
              </Btn>
            </div>
          </>
        )}
        {dl?.status === "error" && dl.error !== "cancelled" && (
          <div className="ph-error">{dl.error}</div>
        )}
      </Glass>

      <Glass className="ph-card">
        <b>{t("photo.comfy.addLocal")}</b>
        <div className="muted-sm">{t("photo.comfy.addLocalHint")}</div>
        <div className="ph-row">
          <input
            style={{ flex: 1, minWidth: 220 }}
            value={local}
            placeholder="D:\models\my_model.safetensors"
            onChange={(e) => setLocal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && local.trim() && void importLocal()}
          />
          {window.appBridge?.pickFile && (
            <Btn icon={FolderOpen} onClick={() => void browse()}>
              {t("photo.comfy.browse")}
            </Btn>
          )}
          <Select
            value={localFolder}
            onChange={(e) => setLocalFolder(e.target.value)}
            options={FOLDERS}
          />
          <Btn
            icon={Plus}
            variant="primary"
            disabled={!local.trim() || importing}
            onClick={() => void importLocal()}
          >
            {importing ? t("photo.working") : t("photo.comfy.addLocalBtn")}
          </Btn>
        </div>
      </Glass>

      <Glass className="ph-card">
        <b>{t("photo.comfy.addByLink")}</b>
        <div className="ph-row">
          <input
            style={{ flex: 1, minWidth: 220 }}
            value={url}
            placeholder="https://huggingface.co/…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void look()}
          />
          <Select value={folder} onChange={(e) => setFolder(e.target.value)} options={FOLDERS} />
          <Btn icon={Search} onClick={() => void look()} disabled={!url.trim()}>
            {t("llama.repoLook")}
          </Btn>
        </div>
        {repo && (
          <>
            <div className="muted-sm">{repo.repo}</div>
            <div className="cf-files">
              {repo.files.map((f) => (
                <label key={f.file} className="ph-row">
                  <input
                    type="checkbox"
                    checked={picked.has(f.file)}
                    onChange={() =>
                      setPicked((s) => {
                        const n = new Set(s);
                        if (!n.delete(f.file)) n.add(f.file);
                        return n;
                      })
                    }
                  />
                  <span style={{ flex: 1 }}>{f.file}</span>
                  <span className="muted-sm">{mb(f.sizeMb)}</span>
                </label>
              ))}
            </div>
            <Btn
              variant="primary"
              icon={Download}
              disabled={!picked.size || downloading}
              onClick={() =>
                void guard(async () => {
                  await api.comfyModelDownload({
                    repo: repo.repo,
                    rev: repo.rev,
                    folder,
                    files: [...picked],
                  });
                  setRepo(null);
                  setUrl("");
                })
              }
            >
              {t("translate.download")} · {picked.size}
            </Btn>
          </>
        )}
        {err && <div className="ph-error">{err}</div>}
      </Glass>

      <Glass className="ph-card">
        <b>{t("photo.comfy.installedModels")}</b>
        {!data?.models.length && <div className="muted-sm">{t("photo.comfy.noModels")}</div>}
        {FOLDERS.map((f) => {
          const list = data?.models.filter((m) => m.folder === f) ?? [];
          if (!list.length) return null;
          return (
            <div key={f}>
              <div className="muted-sm">{f}</div>
              {list.map((m) => (
                <div key={m.file} className="ph-row">
                  <span style={{ flex: 1 }}>{m.file}</span>
                  <span className="muted-sm">{mb(m.sizeMb)}</span>
                  <Btn
                    icon={Trash2}
                    onClick={() => void guard(() => api.comfyModelRemove(m.folder, m.file))}
                  >
                    {t("translate.delete")}
                  </Btn>
                </div>
              ))}
            </div>
          );
        })}
      </Glass>
    </div>
  );
}

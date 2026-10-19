import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Download, RefreshCw, Trash2, Check } from "lucide-react";
import { Glass, Btn, Select, Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type {
  ComfyNodePack,
  ComfyRunSettings,
  ComfySettingsReply,
  ComfyStatus,
  ComfyUpdateCheck,
} from "@/api/apiComfy";

type Section = "memory" | "update" | "nodes";

/** Быстрые наборы памяти: что куда класть, чтобы модель целиком влезала в видеопамять. */
const QUICK: { id: string; patch: Partial<ComfyRunSettings> }[] = [
  { id: "auto", patch: { memory: "auto", cpuVae: false, reserveVramGb: 0, smartMemory: true, asyncOffload: "auto", dynamicVram: "auto" } },
  // Денойзер в видеопамяти, энкодеры текста и VAE — в оперативной памяти и на процессоре.
  { id: "saver", patch: { memory: "low", cpuVae: true, reserveVramGb: 0.6, smartMemory: false, asyncOffload: "on" } },
  { id: "extreme", patch: { memory: "none", cpuVae: true, reserveVramGb: 0.4, smartMemory: false, asyncOffload: "on", cache: "none" } },
  { id: "fast", patch: { memory: "high", cpuVae: false, smartMemory: true } },
];

const opt = (t: (k: string) => string, group: string, values: string[]): { value: string; label: string }[] =>
  values.map((v) => ({ value: v, label: t(`photo.comfy.admin.${group}.${v}`) }));

/** Настройки ComfyUI: память и точность, обновление с GitHub и пользовательские узлы. */
export default function ComfyAdmin({
  st,
  act,
}: {
  st: ComfyStatus;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Section | null>(null);
  const [cfg, setCfg] = useState<ComfyRunSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [upd, setUpd] = useState<ComfyUpdateCheck | null>(null);
  const [nodes, setNodes] = useState<ComfyNodePack[]>([]);
  const [url, setUrl] = useState("");
  const working = st.setup.state === "working";
  const stopped = !st.running;

  const loadCfg = useCallback(async () => {
    try {
      setCfg((await api.comfySettings()).settings);
    } catch {
      /* сервер перезапускается */
    }
  }, []);
  const loadNodes = useCallback(async () => {
    try {
      setNodes((await api.comfyNodes()).nodes);
    } catch {
      /* сервер перезапускается */
    }
  }, []);
  const check = useCallback(async (force = false) => {
    try {
      setUpd(await api.comfyUpdateCheck(force));
    } catch {
      /* без сети */
    }
  }, []);

  useEffect(() => {
    if (open === "memory" && !cfg) void loadCfg();
    if (open === "update" && !upd) void check();
    if (open === "nodes") void loadNodes();
  }, [open, cfg, upd, loadCfg, loadNodes, check]);
  // После завершения задачи (обновление, узел, менеджер) обновляем данные разделов.
  useEffect(() => {
    if (st.setup.state === "done") {
      void loadNodes();
      void check(true);
    }
  }, [st.setup.state, loadNodes, check]);

  const patch = (p: Partial<ComfyRunSettings>): void => {
    setCfg((c) => (c ? { ...c, ...p } : c));
    setSaved(false);
  };
  const save = async (): Promise<void> => {
    if (!cfg) return;
    await act(async () => {
      const r: ComfySettingsReply = await api.comfySettingsSave(cfg);
      setCfg(r.settings);
      setSaved(true);
    });
  };

  const head = (id: Section, title: string, meta?: React.ReactNode): React.ReactNode => (
    <button type="button" className="cf-fold" onClick={() => setOpen(open === id ? null : id)}>
      <ChevronRight size={14} style={{ transform: open === id ? "rotate(90deg)" : undefined }} />
      <b>{title}</b>
      {meta}
    </button>
  );

  const bool = (k: keyof ComfyRunSettings, label: string, hint?: string): React.ReactNode =>
    cfg && (
      <label className="cf-check" title={hint}>
        <input type="checkbox" checked={Boolean(cfg[k])} onChange={(e) => patch({ [k]: e.target.checked } as Partial<ComfyRunSettings>)} />
        <span>{label}</span>
      </label>
    );

  return (
    <Glass className="ph-card">
      {head("memory", t("photo.comfy.admin.memoryTitle"))}
      {open === "memory" && cfg && (
        <div className="cf-section">
          <div className="muted-sm">{t("photo.comfy.admin.memoryHint")}</div>
          <div className="ph-row">
            {QUICK.map((q) => (
              <Btn key={q.id} onClick={() => patch(q.patch)} title={t(`photo.comfy.admin.quickHint.${q.id}`)}>
                {t(`photo.comfy.admin.quick.${q.id}`)}
              </Btn>
            ))}
          </div>
          <div className="ph-grid">
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.memory")}</span>
              <Select value={cfg.memory} onChange={(e) => patch({ memory: e.target.value as ComfyRunSettings["memory"] })} options={opt(t, "memoryMode", ["auto", "gpu", "high", "low", "none", "cpu"])} />
            </label>
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.reserve")}</span>
              <input type="number" min={0} max={64} step={0.1} value={cfg.reserveVramGb} onChange={(e) => patch({ reserveVramGb: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.asyncOffload")}</span>
              <Select value={cfg.asyncOffload} onChange={(e) => patch({ asyncOffload: e.target.value as ComfyRunSettings["asyncOffload"] })} options={opt(t, "tri", ["auto", "on", "off"])} />
            </label>
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.dynamicVram")}</span>
              <Select value={cfg.dynamicVram} onChange={(e) => patch({ dynamicVram: e.target.value as ComfyRunSettings["dynamicVram"] })} options={opt(t, "tri", ["auto", "on", "off"])} />
            </label>
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.cache")}</span>
              <Select value={cfg.cache} onChange={(e) => patch({ cache: e.target.value as ComfyRunSettings["cache"] })} options={opt(t, "cacheMode", ["auto", "classic", "lru", "none"])} />
            </label>
            {cfg.cache === "lru" && (
              <label className="field">
                <span className="field-label">{t("photo.comfy.admin.cacheLru")}</span>
                <input type="number" min={1} max={256} value={cfg.cacheLru} onChange={(e) => patch({ cacheLru: Number(e.target.value) })} />
              </label>
            )}
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.unet")}</span>
              <Select value={cfg.unet} onChange={(e) => patch({ unet: e.target.value as ComfyRunSettings["unet"] })} options={opt(t, "prec", ["auto", "fp32", "fp16", "bf16", "fp8_e4m3fn", "fp8_e5m2"])} />
            </label>
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.vaePrec")}</span>
              <Select value={cfg.vae} onChange={(e) => patch({ vae: e.target.value as ComfyRunSettings["vae"] })} options={opt(t, "prec", ["auto", "fp32", "fp16", "bf16"])} />
            </label>
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.textEnc")}</span>
              <Select value={cfg.textEnc} onChange={(e) => patch({ textEnc: e.target.value as ComfyRunSettings["textEnc"] })} options={opt(t, "prec", ["auto", "fp32", "fp16", "bf16", "fp8_e4m3fn", "fp8_e5m2"])} />
            </label>
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.attention")}</span>
              <Select value={cfg.attention} onChange={(e) => patch({ attention: e.target.value as ComfyRunSettings["attention"] })} options={opt(t, "attn", ["auto", "pytorch", "split", "quad", "sage", "flash"])} />
            </label>
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.preview")}</span>
              <Select value={cfg.preview} onChange={(e) => patch({ preview: e.target.value as ComfyRunSettings["preview"] })} options={opt(t, "previewMode", ["auto", "none", "latent2rgb", "taesd"])} />
            </label>
            <label className="field">
              <span className="field-label">{t("photo.comfy.admin.cudaDevice")}</span>
              <input type="text" value={cfg.cudaDevice} placeholder="0,1" onChange={(e) => patch({ cudaDevice: e.target.value })} />
            </label>
          </div>
          <div className="cf-checks">
            {bool("cpuVae", t("photo.comfy.admin.cpuVae"), t("photo.comfy.admin.cpuVaeHint"))}
            {bool("smartMemory", t("photo.comfy.admin.smartMemory"), t("photo.comfy.admin.smartMemoryHint"))}
            {bool("highRam", t("photo.comfy.admin.highRam"))}
            {bool("fast", t("photo.comfy.admin.fast"), t("photo.comfy.admin.fastHint"))}
            {bool("disableCudaMalloc", t("photo.comfy.admin.noCudaMalloc"))}
            {bool("disablePartnerNodes", t("photo.comfy.admin.noPartner"), t("photo.comfy.admin.noPartnerHint"))}
          </div>
          <label className="field">
            <span className="field-label">{t("photo.comfy.admin.extraArgs")}</span>
            <input type="text" value={cfg.extraArgs} placeholder="--use-sage-attention --reserve-vram 1" onChange={(e) => patch({ extraArgs: e.target.value })} />
          </label>
          <div className="muted-sm">{t("photo.comfy.admin.extraHint")}</div>
          <div className="ph-row">
            <Btn variant="primary" icon={Check} onClick={() => void save()}>
              {t("photo.comfy.admin.save")}
            </Btn>
            {saved && <Badge tone="teal">{st.running ? t("photo.comfy.admin.savedRestart") : t("photo.comfy.admin.saved")}</Badge>}
          </div>
        </div>
      )}

      {head("update", t("photo.comfy.admin.updateTitle"), st.version ? <Badge>{st.version}</Badge> : null)}
      {open === "update" && (
        <div className="cf-section">
          <div className="ph-row">
            <span>
              {t("photo.comfy.admin.current")}: <b>{upd?.current || st.version || "—"}</b>
            </span>
            <span>
              {t("photo.comfy.admin.latest")}: <b>{upd?.latest || "—"}</b>
            </span>
            {upd?.newer ? <Badge tone="teal">{t("photo.comfy.admin.newer")}</Badge> : upd?.latest ? <Badge>{t("photo.comfy.admin.upToDate")}</Badge> : null}
            <Btn icon={RefreshCw} onClick={() => void check(true)}>
              {t("photo.comfy.admin.check")}
            </Btn>
          </div>
          <div className="ph-row">
            <Btn variant="primary" icon={Download} disabled={working || !stopped} onClick={() => void act(() => api.comfyUpdate("stable"))}>
              {t("photo.comfy.admin.updateStable")}
            </Btn>
            <Btn icon={Download} disabled={working || !stopped} onClick={() => void act(() => api.comfyUpdate("latest"))}>
              {t("photo.comfy.admin.updateLatest")}
            </Btn>
          </div>
          <div className="muted-sm">{t("photo.comfy.admin.updateHint")}</div>
          {!stopped && <div className="muted-sm">{t("photo.comfy.admin.stopFirst")}</div>}
          <div className="ph-row">
            <Badge tone={st.manager ? "teal" : undefined}>{st.manager ? t("photo.comfy.admin.managerOn") : t("photo.comfy.admin.managerOff")}</Badge>
            {!st.manager && (
              <Btn icon={Download} disabled={working || !stopped} onClick={() => void act(() => api.comfyManagerInstall())}>
                {t("photo.comfy.admin.managerInstall")}
              </Btn>
            )}
          </div>
          <div className="muted-sm">{t("photo.comfy.admin.managerHint")}</div>
        </div>
      )}

      {head("nodes", t("photo.comfy.admin.nodesTitle"), <Badge>{nodes.length}</Badge>)}
      {open === "nodes" && (
        <div className="cf-section">
          <div className="muted-sm">{t("photo.comfy.admin.nodesHint")}</div>
          <div className="ph-row">
            <input
              type="text"
              style={{ flex: 1, minWidth: 240 }}
              value={url}
              placeholder="https://github.com/owner/ComfyUI-..."
              onChange={(e) => setUrl(e.target.value)}
            />
            <Btn
              variant="primary"
              icon={Download}
              disabled={working || !stopped || !url.trim()}
              onClick={() => void act(async () => { await api.comfyNodeInstall(url.trim()); setUrl(""); })}
            >
              {t("photo.comfy.admin.nodeInstall")}
            </Btn>
          </div>
          {!stopped && <div className="muted-sm">{t("photo.comfy.admin.stopFirst")}</div>}
          <div className="cf-files">
            {nodes.map((n) => (
              <div key={n.name} className="cf-file">
                <span style={{ flex: 1 }}>
                  <b>{n.name}</b>
                  {!n.enabled && <Badge>{t("photo.comfy.admin.disabled")}</Badge>}
                  {n.source && <div className="muted-sm">{n.source}</div>}
                </span>
                <Btn disabled={!stopped} onClick={() => void act(async () => setNodes((await api.comfyNodeToggle(n.name, !n.enabled)).nodes))}>
                  {n.enabled ? t("photo.comfy.admin.disable") : t("photo.comfy.admin.enable")}
                </Btn>
                {n.source && (
                  <Btn icon={RefreshCw} disabled={working || !stopped} onClick={() => void act(() => api.comfyNodeUpdate(n.name))}>
                    {t("photo.comfy.admin.nodeUpdate")}
                  </Btn>
                )}
                {!n.builtin && (
                  <Btn
                    icon={Trash2}
                    disabled={!stopped}
                    onClick={() => {
                      if (window.confirm(t("photo.comfy.admin.nodeRemoveConfirm", { name: n.name })))
                        void act(async () => setNodes((await api.comfyNodeRemove(n.name)).nodes));
                    }}
                  />
                )}
              </div>
            ))}
            {nodes.length === 0 && <div className="muted-sm">{t("photo.comfy.admin.nodesEmpty")}</div>}
          </div>
        </div>
      )}
    </Glass>
  );
}

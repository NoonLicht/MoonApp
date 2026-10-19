import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Cpu, Download, Eye, Power, Trash2, X } from "lucide-react";
import { Badge, Btn, ProgressBar, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LlamaCatalogModel, LlamaSection, LlamaStatus } from "@/api/client";
import LlamaAddLink from "@/components/LlamaAddLink";

/** Порядок разделов: Qwen, Gemma, прочие (узкие и сторонние), картинки. */
const SECTIONS: LlamaSection[] = ["qwen", "gemma", "other", "image"];

/** Раздел своего файла без записи: по имени (Qwen/Gemma), иначе в прочие. */
const guessSection = (file: string): LlamaSection =>
  /qwen[-_ ]?image/i.test(file)
    ? "image"
    : /qwen/i.test(file)
      ? "qwen"
      : /gemma/i.test(file)
        ? "gemma"
        : "other";

const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;
const size = (mb: number): string => (mb < 1024 ? `${Math.round(mb)} MB` : gb(mb));

/** Свёртываемая секция: заголовок-кнопка и тело, чтобы длинный список не превращался в мусор. */
function Fold({
  title,
  meta,
  badges,
  open,
  onToggle,
  children,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  badges?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`llama-fold${open ? " is-open" : ""}`}>
      <button type="button" className="llama-fold-head" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={14} className="llama-fold-chev" />
        <span className="llama-fold-title">{title}</span>
        {badges}
        {meta && <span className="llama-fold-meta">{meta}</span>}
      </button>
      {open && <div className="llama-fold-body">{children}</div>}
    </div>
  );
}

/**
 * Встроенный llama.cpp: сборки (CPU / Vulkan / CUDA), загруженные модели, автоматика
 * (лимит одновременных моделей, MoE на видеокарте) и каталог GGUF, сгруппированный по моделям.
 * `kind` ограничивает каталог моделями нужного назначения.
 */
export default function LlamaPanel({
  kind,
  notify,
  onChange,
}: {
  kind?: "translate" | "chat" | "tts" | "ocr";
  notify?: (text: string, ok?: boolean) => void;
  onChange?: (s: LlamaStatus) => void;
}) {
  const { t } = useI18n();
  const [st, setSt] = useState<LlamaStatus | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const flip = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const refresh = useCallback(async () => {
    try {
      const s = await api.llamaStatus();
      setSt(s);
      onChange?.(s);
    } catch {
      /* сервер недоступен — оставляем прежнее */
    }
  }, [onChange]);

  const busy = st?.install.state === "working" || st?.download?.status === "downloading";
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), busy ? 1000 : 4000);
    return () => window.clearInterval(id);
  }, [refresh, busy]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      notify?.((e as Error).message, false);
    }
    void refresh();
  };

  const groups = useMemo(() => {
    const out: {
      id: string;
      title: string;
      kind: string;
      section: LlamaSection;
      items: LlamaCatalogModel[];
    }[] = [];
    for (const m of st?.catalog ?? []) {
      if (kind && m.kind !== kind) continue;
      let g = out.find((x) => x.id === m.group);
      if (!g)
        out.push((g = { id: m.group, title: m.title, kind: m.kind, section: m.section, items: [] }));
      g.items.push(m);
    }
    return out;
  }, [st?.catalog, kind]);

  if (!st) return null;
  const dl = st.download;
  const downloading = dl?.status === "downloading";
  const installing = st.install.state === "working";
  const anyBuild = st.builds.some((b) => b.installed);
  const act2 = st.activity;
  const files = new Set([...st.models, ...(st.sdModels ?? [])].map((x) => x.file));
  const haveModel = (m: LlamaCatalogModel): boolean =>
    files.has(m.file) && (m.extra ?? []).every((e) => files.has(e.as ?? e.file.split("/").pop() ?? e.file));
  const chatFiles = st.models
    .map((x) => x.file)
    .filter((f) => !/embedding|mmproj|chandra|tts|translategemma/i.test(f));
  // Свои модели: всё, чего нет в каталоге. Проекторы, VAE и энкодеры не показываем: они едут вместе с моделью.
  const customs = [...st.models, ...(st.sdModels ?? [])]
    .filter(
      (x) =>
        !st.catalog.some(
          (m) =>
            m.file === x.file ||
            m.extra?.some((e) => (e.as ?? e.file.split("/").pop()) === x.file),
        ) &&
        !/mmproj/i.test(x.file) &&
        !/vae.*\.safetensors$/i.test(x.file) &&
        (st.custom?.[x.file]?.role ?? "model") === "model",
    )
    .map((x) => ({ ...x, section: st.custom?.[x.file]?.section ?? guessSection(x.file) }));
  const router = st.router;

  return (
    <div className="llama-panel">
      <div className="tn-sub">
        <b className="tn-card-title">
          <Cpu size={14} /> {t("llama.title")}
        </b>
      </div>
      <div className="muted-sm">{t("llama.hint")}</div>

      {/* что сейчас в памяти */}
      <div className="llama-loaded">
        {act2.loaded.length === 0 && act2.loading.length === 0 && (
          <span className="muted-sm">{t("llama.noneLoaded")}</span>
        )}
        {act2.loading.map((l) => (
          <Badge key={`l-${l.file}`} tone="amber">
            {t("llama.loadingModel", { model: l.file })}
          </Badge>
        ))}
        {act2.loaded.map((l) => (
          <span key={l.file} className="llama-chip">
            <Badge tone="teal">
              {l.file}
              {l.task ? ` · ${t(`llama.task.${l.task}`)}` : ""}
              {l.busy ? ` · ${t("llama.working")}` : ""}
              {l.gpu ? " · GPU" : " · CPU"}
            </Badge>
            <Btn icon={Power} onClick={() => void act(() => api.llamaStop(l.file))}>
              {t("llama.unload")}
            </Btn>
          </span>
        ))}
        {act2.loaded.length > 1 && (
          <Btn icon={Power} onClick={() => void act(() => api.llamaStop())}>
            {t("llama.unloadAll")}
          </Btn>
        )}
      </div>

      {!kind && (
        <Fold
          title={t("llama.sec.auto")}
          meta={t("llama.autoMeta", { n: act2.limit })}
          open={!!open.auto}
          onToggle={() => flip("auto")}
        >
          <div className="llama-auto">
            {act2.laptop && <div className="muted-sm">{t("llama.laptopNote")}</div>}
            <label className="field">
              <span className="field-label">{t("llama.defaultModel")}</span>
              <Select
                value={router.defaultModel}
                onChange={(e) =>
                  void act(() => api.llamaSetRouter({ defaultModel: e.target.value }))
                }
                options={[
                  { value: "", label: t("llama.defaultAuto") },
                  ...chatFiles.map((f) => ({ value: f, label: f })),
                ]}
              />
            </label>
            <label className="field">
              <span className="field-label">{t("llama.maxLoaded")}</span>
              <Select
                value={String(router.maxLoaded)}
                onChange={(e) =>
                  void act(() => api.llamaSetRouter({ maxLoaded: Number(e.target.value) }))
                }
                options={[
                  { value: "0", label: t("llama.maxAuto", { n: act2.limit }) },
                  ...[1, 2, 3, 4, 6].map((n) => ({ value: String(n), label: String(n) })),
                ]}
              />
            </label>
            <label className="llama-check">
              <input
                type="checkbox"
                checked={router.autoWarm}
                onChange={(e) => void act(() => api.llamaSetRouter({ autoWarm: e.target.checked }))}
              />
              <span>
                <b>{t("llama.autoWarm")}</b>
                <span className="muted-sm">{t("llama.autoWarmHint")}</span>
              </span>
            </label>
            <label className="llama-check">
              <input
                type="checkbox"
                checked={router.moeOffload}
                onChange={(e) =>
                  void act(() => api.llamaSetRouter({ moeOffload: e.target.checked }))
                }
              />
              <span>
                <b>{t("llama.moe")}</b>
                <span className="muted-sm">{t("llama.moeHint")}</span>
              </span>
            </label>
            <label className="field">
              <span className="field-label">{t("llama.idle")}</span>
              <Select
                value={String(router.idleMinutes)}
                onChange={(e) =>
                  void act(() => api.llamaSetRouter({ idleMinutes: Number(e.target.value) }))
                }
                options={[
                  { value: "0", label: t("llama.idleAuto") },
                  ...[1, 2, 5, 10, 30, 60].map((n) => ({
                    value: String(n),
                    label: t("llama.idleMin", { n }),
                  })),
                ]}
              />
            </label>
          </div>
        </Fold>
      )}

      <Fold
        title={t("llama.sec.builds")}
        meta={st.builds
          .filter((b) => b.installed)
          .map((b) => t(`llama.build.${b.id}`).split(" ")[0])
          .join(", ")}
        open={!!open.builds || (!anyBuild && st.builds.length > 0)}
        onToggle={() => flip("builds")}
      >
        {st.builds.length === 0 && <div className="tn-note">{t("llama.unsupported")}</div>}
        <div className="tn-list">
          {st.builds.map((b) => {
            const active = installing && st.install.id === b.id;
            return (
              <div key={b.id} className="tn-row">
                <div className="tn-row-main">
                  <div className="tn-row-title">
                    {t(`llama.build.${b.id}`)} · {size(b.sizeMb)}
                    {st.failedBuilds.includes(b.id) ? ` · ${t("llama.failed")}` : ""}
                  </div>
                  <div className="muted-sm">{t(`llama.buildHint.${b.id}`)}</div>
                  {active && (
                    <>
                      <ProgressBar value={st.install.progress} />
                      <div className="muted-sm">
                        {t(`llama.phase.${st.install.phase || "download"}`)}
                      </div>
                    </>
                  )}
                  {st.install.state === "error" && st.install.id === b.id && (
                    <div className="muted-sm">
                      {t("tuning.error")}: {st.install.error}
                    </div>
                  )}
                </div>
                {b.installed && <Badge tone="teal">{t("translate.installed")}</Badge>}
                {active ? (
                  <Btn icon={X} onClick={() => void act(() => api.llamaBuildCancel())}>
                    {t("translate.cancel")}
                  </Btn>
                ) : b.installed ? (
                  <Btn
                    icon={Trash2}
                    disabled={installing}
                    onClick={() => void act(() => api.llamaBuildRemove(b.id))}
                  >
                    {t("translate.delete")}
                  </Btn>
                ) : (
                  <Btn
                    icon={Download}
                    disabled={installing}
                    onClick={() => void act(() => api.llamaBuildInstall(b.id))}
                  >
                    {t("translate.download")}
                  </Btn>
                )}
              </div>
            );
          })}
        </div>
      </Fold>

      <b className="tn-card-title" style={{ display: "block", marginTop: 12 }}>
        {t("llama.modelsTitle")}
      </b>
      {SECTIONS.map((sec) => {
        const gs = groups.filter((g) => g.section === sec);
        const mine = kind ? [] : customs.filter((c) => c.section === sec);
        if (!gs.length && !mine.length && (kind || sec === "image")) return null;
        const haveAll = gs.reduce((n, g) => n + g.items.filter(haveModel).length, 0) + mine.length;
        return (
          <div key={sec} className="llama-section">
            <div className="llama-section-head">
              <b>{t(`llama.section.${sec}`)}</b>
              <span className="muted-sm">
                {gs.length + (mine.length ? 1 : 0)}
                {haveAll > 0 ? ` · ${t("llama.haveCount", { n: haveAll })}` : ""}
              </span>
            </div>
            <div className="llama-groups">
              {gs.map((g) => {
                const have = g.items.filter(haveModel).length;
                const vision = g.items.some((m) => m.vision);
                const lo = Math.min(...g.items.map((m) => m.sizeMb));
                const hi = Math.max(...g.items.map((m) => m.sizeMb));
                return (
                  <Fold
                    key={g.id}
                    title={g.title}
                    badges={
                      <>
                        <span className="llama-kind">{t(`llama.kind.${g.kind}`)}</span>
                        {vision && (
                          <span className="llama-kind llama-kind-vis" title={t("llama.vision")}>
                            <Eye size={11} /> {t("llama.visionShort")}
                          </span>
                        )}
                      </>
                    }
                    meta={
                      <>
                        {have > 0 && (
                          <b className="llama-have">{t("llama.haveCount", { n: have })}</b>
                        )}
                        {lo === hi ? size(lo) : `${size(lo)}–${size(hi)}`}
                      </>
                    }
                    open={!!open[`g-${g.id}`]}
                    onToggle={() => flip(`g-${g.id}`)}
                  >
                    <div className="tn-list">
                      {g.items.map((m) => {
                        const ok = haveModel(m);
                        const active =
                          downloading &&
                          (dl?.file === m.file ||
                            m.extra?.some((e) => (e.as ?? e.file.split("/").pop()) === dl?.file));
                        const rest = (m.extra ?? []).filter((e) => !files.has(e.as ?? e.file.split("/").pop() ?? e.file));
                        const restMb = rest.reduce((a, e) => a + e.sizeMb, 0);
                        return (
                          <div key={m.id} className="tn-row">
                            <div className="tn-row-main">
                              <div className="tn-row-title">
                                {m.note.toUpperCase()} · {size(m.sizeMb)}
                              </div>
                              {restMb > 0 && (
                                <div className="muted-sm">
                                  {t("llama.plusParts", { size: size(restMb) })}
                                </div>
                              )}
                              <div className="muted-sm">{t(`llama.quant.${m.note}`)}</div>
                              {active && dl && (
                                <>
                                  <ProgressBar value={dl.total ? (dl.bytes / dl.total) * 100 : 0} />
                                  <div className="muted-sm">
                                    {dl.file} · {size(dl.bytes / 1048576)} /{" "}
                                    {size(dl.total / 1048576)}
                                  </div>
                                </>
                              )}
                            </div>
                            {ok && <Badge tone="teal">{t("translate.installed")}</Badge>}
                            {active ? (
                              <Btn icon={X} onClick={() => void act(() => api.llamaModelCancel())}>
                                {t("translate.cancel")}
                              </Btn>
                            ) : ok ? (
                              <Btn
                                icon={Trash2}
                                disabled={downloading}
                                onClick={() =>
                                  void act(async () => {
                                    await api.llamaModelRemove(m.file);
                                  })
                                }
                              >
                                {t("translate.delete")}
                              </Btn>
                            ) : (
                              <Btn
                                icon={Download}
                                disabled={downloading}
                                onClick={() => void act(() => api.llamaModelDownload({ id: m.id }))}
                              >
                                {t("translate.download")}
                              </Btn>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </Fold>
                );
              })}
              {sec === "image" && st.sd && (
                <Fold
                  title={t("llama.sdTitle")}
                  badges={
                    st.sd.ready ? (
                      <Badge tone="teal">{t("llama.sdReady")}</Badge>
                    ) : (
                      <Badge tone="amber">{t("llama.sdNotReady")}</Badge>
                    )
                  }
                  meta={st.sd.builds
                    .filter((b) => b.installed)
                    .map((b) => t(`llama.build.${b.id}`).split(" ")[0])
                    .join(", ")}
                  open={!!open.sd || !st.sd.builds.some((b) => b.installed)}
                  onToggle={() => flip("sd")}
                >
                  <div className="muted-sm">{t("llama.sdHint")}</div>
                  <div className="tn-list">
                    {st.sd.builds.map((b) => {
                      const sdActive = st.sd.install.state === "working" && st.sd.install.id === b.id;
                      const sdBusy = st.sd.install.state === "working";
                      return (
                        <div key={b.id} className="tn-row">
                          <div className="tn-row-main">
                            <div className="tn-row-title">
                              {t(`llama.build.${b.id}`)} · {size(b.sizeMb)}
                            </div>
                            <div className="muted-sm">{t(`llama.buildHint.${b.id}`)}</div>
                            {sdActive && <ProgressBar value={st.sd.install.progress} />}
                            {st.sd.install.state === "error" && st.sd.install.id === b.id && (
                              <div className="muted-sm">
                                {t("tuning.error")}: {st.sd.install.error}
                              </div>
                            )}
                          </div>
                          {b.installed && <Badge tone="teal">{t("translate.installed")}</Badge>}
                          {sdActive ? (
                            <Btn icon={X} onClick={() => void act(() => api.sdBuildCancel())}>
                              {t("translate.cancel")}
                            </Btn>
                          ) : b.installed ? (
                            <Btn
                              icon={Trash2}
                              disabled={sdBusy}
                              onClick={() => void act(() => api.sdBuildRemove(b.id))}
                            >
                              {t("translate.delete")}
                            </Btn>
                          ) : (
                            <Btn
                              icon={Download}
                              disabled={sdBusy}
                              onClick={() => void act(() => api.sdBuildInstall(b.id))}
                            >
                              {t("translate.download")}
                            </Btn>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {!st.sd.ready && st.sd.missing.length > 0 && (
                    <div className="muted-sm">
                      {t("llama.sdMissing", {
                        list: st.sd.missing.map((m) => t(`llama.sdPart.${m}`)).join(", "),
                      })}
                    </div>
                  )}
                </Fold>
              )}
              {mine.length > 0 && (
                <Fold
                  title={t("llama.custom")}
                  meta={String(mine.length)}
                  open={!!open[`c-${sec}`]}
                  onToggle={() => flip(`c-${sec}`)}
                >
                  <div className="tn-list">
                    {mine.map((x) => (
                      <div key={x.file} className="tn-row">
                        <div className="tn-row-main">
                          <div className="tn-row-title">
                            {x.file} · {size(x.sizeMb)}
                          </div>
                        </div>
                        <Btn
                          icon={Trash2}
                          onClick={() => void act(() => api.llamaModelRemove(x.file))}
                        >
                          {t("translate.delete")}
                        </Btn>
                      </div>
                    ))}
                  </div>
                </Fold>
              )}
            </div>
            {!kind && (
              <LlamaAddLink
                section={sec}
                busy={!!downloading}
                onDone={() => void refresh()}
                notify={notify}
              />
            )}
          </div>
        );
      })}
      {downloading && (
        <div className="muted-sm">
          {dl?.file} · {size((dl?.bytes ?? 0) / 1048576)} / {size((dl?.total ?? 0) / 1048576)}
        </div>
      )}
      {dl?.status === "error" && (
        <div className="muted-sm">
          {t("tuning.error")}: {dl.error}
        </div>
      )}
      {!anyBuild && <div className="muted-sm">{t("llama.needBuild")}</div>}
    </div>
  );
}

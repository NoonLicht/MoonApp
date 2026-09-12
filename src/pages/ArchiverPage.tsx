import React, { useState, useEffect, useRef } from "react";
import { Archive, Download, Globe, Layers, Filter, Copy, Trash2, ShieldCheck, FileSearch, Play, ExternalLink, Loader2, FolderOpen } from "lucide-react";
import { useContextMenu, copyToClipboard } from "../components/ContextMenu";
import { Btn, IconBtn, Glass, Badge, Select, SectionHead, ProgressBar, Field, Checkbox, EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { SitebakArchive, SitebakJob } from "../api/client";

/**
 * Web Archive Engine (.sitebak): краулер + упаковщик офлайн-копий.
 *
 * Как это работает:
 *  - Четыре блока параметров: Обход (URL/глубина/домен/лимит), Медиа
 *    (AVIF/WebP/EXIF/видео), Контент (strip scripts/inline/block ads),
 *    Сеть (delay/concurrency/cookies/User-Agent). Дефолты — из настроек sitebak.*.
 *  - POST /archive/start запускает 5-стадийный пайплайн; страница опрашивает
 *    статус (crawl → optimize → pack → done) и прогресс.
 *  - Карточки архивов: статистика (страницы, исходный размер, .sitebak,
 *    % экономии), кнопки скачать/проверить/извлечь/превью, контекстное меню.
 */

const DEPTHS = ["0", "1", "2", "3", "4", "5", "full"];
const SCOPES = ["path", "subdomain", "domain"];
const IMG_MODES = ["original", "lossless", "webp", "avif"];

export default function ArchiverPage() {
  const { t } = useI18n();
  const menu = useContextMenu();
  const [url, setUrl] = useState("");
  const [depth, setDepth] = useState("2");
  const [scope, setScope] = useState("domain");
  const [maxPages, setMaxPages] = useState(500);
  const [imageMode, setImageMode] = useState("webp");
  const [stripScripts, setStripScripts] = useState(true);
  const [stripExif, setStripExif] = useState(true);
  const [blockAds, setBlockAds] = useState(true);
  const [inlineAssets, setInlineAssets] = useState(true);
  const [delayMs, setDelayMs] = useState(500);
  const [concurrency, setConcurrency] = useState(3);
  const [cookies, setCookies] = useState("");
  const [userAgent, setUserAgent] = useState("");
  const [job, setJob] = useState<SitebakJob | null>(null);
  const [archives, setArchives] = useState<SitebakArchive[]>([]);
  const [verifyResult, setVerifyResult] = useState<Record<string, string>>({});
  const pollRef = useRef<number | null>(null);

  // Дефолты из настроек sitebak.* применяются при открытии страницы.
  useEffect(() => {
    api.getSettings().then((s: any) => {
      const c = s?.sitebak;
      if (c) {
        if (typeof c.maxConcurrent === "number") setConcurrency(c.maxConcurrent);
        if (typeof c.crawlDelayMs === "number") setDelayMs(c.crawlDelayMs);
        if (typeof c.userAgent === "string" && c.userAgent) setUserAgent(c.userAgent);
        if (typeof c.mediaFormat === "string") setImageMode(c.mediaFormat);
        if (typeof c.stripScripts === "boolean") setStripScripts(c.stripScripts);
        if (typeof c.stripExif === "boolean") setStripExif(c.stripExif);
        if (typeof c.blockAds === "boolean") setBlockAds(c.blockAds);
        if (typeof c.maxPages === "number") setMaxPages(c.maxPages);
      }
    }).catch(() => { /* дефолты из кода */ });
    api.archiveList().then(setArchives).catch(() => {});
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, []);

  usePageToolbar(
    <>
      <Badge tone="violet" mono>.sitebak</Badge>
      <Badge tone={job?.stats?.rendered ? "teal" : "amber"}>{job?.stats?.rendered ? t("arch.playwright") : t("arch.fetchMode")}</Badge>
    </>,
    [t, job]
  );

  const start = async () => {
    if (!/^https?:\/\//i.test(url.trim())) return;
    try {
      const j = await api.archiveStart({
        url: url.trim(), depth, domainScope: scope, maxPages, imageMode,
        stripScripts, stripExif, blockAds, inlineAssets, delayMs, concurrency,
        cookies, userAgent,
      });
      setJob(j); setVerifyResult({});
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const s = await api.archiveStatus(j.id);
          setJob(s);
          if (s.done || s.stage === "error") {
            window.clearInterval(pollRef.current!); pollRef.current = null;
            api.archiveList().then(setArchives).catch(() => {});
          }
        } catch { /* повтор на следующем тике */ }
      }, 1200);
    } catch (e: any) {
      setJob({ id: "", url, name: "", stage: "error", progress: 0, pages: 0, origSize: 0, bakSize: 0, error: String(e.message || e), done: false });
    }
  };

  const fmtMB = (b?: number) => (!b && b !== 0) ? "—" : `${(b / 1024 / 1024).toFixed(1)} MB`;
  const busy = !!job && !job.done && job.stage !== "error";

  // Проверка SHA-256 целостности архива (правый клик → Verify).
  const doVerify = async (id: string) => {
    try {
      const r = await api.archiveVerify(id);
      setVerifyResult((v) => ({ ...v, [id]: t("arch.verifyOk", { ok: r.ok, bad: r.bad }) }));
    } catch (e: any) {
      setVerifyResult((v) => ({ ...v, [id]: e.message }));
    }
  };

  return (
    <div className="page">
      <SectionHead eyebrow={t("arch.eyebrow")} title={t("arch.title")} />

      {/* --- Блок 1: Обход (URL, глубина, домен, лимит, медиа-режим) --- */}
      <Glass className="option-grid" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}
        onContextMenu={(e) => menu.open(e, [
          url.length > 0 && { label: t("ctx.copyLink"), icon: Copy, onClick: () => copyToClipboard(url) },
          url.length > 0 && { label: t("ctx.clear"), icon: Trash2, onClick: () => setUrl("") },
        ])}>
        <div className="url-bar">
          <Globe size={16} />
          <input placeholder={t("arch.paste")} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && start()} />
          <Btn variant="primary" icon={busy ? Loader2 : Archive} onClick={start} disabled={busy}>
            {busy ? t("arch.archiving") : t("arch.savePage")}
          </Btn>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Field label={t("arch.depth")}>
            <Select value={depth} onChange={(e) => setDepth(e.target.value)} options={DEPTHS} />
          </Field>
          <Field label={t("arch.scope")}>
            <Select value={scope} onChange={(e) => setScope(e.target.value)} options={SCOPES} />
          </Field>
          <Field label={t("arch.maxPages")}>
            <input className="text-input" type="number" min="1" max="5000" value={maxPages}
              onChange={(e) => setMaxPages(parseInt(e.target.value) || 500)} style={{ width: 100 }} />
          </Field>
          <Field label={t("arch.imageMode")}>
            <Select value={imageMode} onChange={(e) => setImageMode(e.target.value)} options={IMG_MODES} />
          </Field>
        </div>
      </Glass>

      {/* --- Блоки 2/3: Контент и фильтры (strip/inline/block) --- */}
      <Glass className="option-grid">
        <button className={`option-item ${stripScripts ? "is-on" : ""}`} onClick={() => setStripScripts(!stripScripts)}>
          <Checkbox checked={stripScripts} onClick={() => setStripScripts(!stripScripts)} />
          <Filter size={15} /><span>{t("arch.stripScripts")}</span>
        </button>
        <button className={`option-item ${blockAds ? "is-on" : ""}`} onClick={() => setBlockAds(!blockAds)}>
          <Checkbox checked={blockAds} onClick={() => setBlockAds(!blockAds)} />
          <ShieldCheck size={15} /><span>{t("arch.blockAds")}</span>
        </button>
        <button className={`option-item ${inlineAssets ? "is-on" : ""}`} onClick={() => setInlineAssets(!inlineAssets)}>
          <Checkbox checked={inlineAssets} onClick={() => setInlineAssets(!inlineAssets)} />
          <Layers size={15} /><span>{t("arch.inlineAssets")}</span>
        </button>
        <button className={`option-item ${stripExif ? "is-on" : ""}`} onClick={() => setStripExif(!stripExif)}>
          <Checkbox checked={stripExif} onClick={() => setStripExif(!stripExif)} />
          <FileSearch size={15} /><span>{t("arch.stripExif")}</span>
        </button>
      </Glass>

      {/* --- Блок 4: Сеть и вежливость --- */}
      <Glass className="option-grid" style={{ alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <Field label={t("arch.delay", { v: delayMs })}>
          <input type="range" min="0" max="3000" step="100" value={delayMs}
            onChange={(e) => setDelayMs(parseInt(e.target.value))} style={{ width: 140 }} />
        </Field>
        <Field label={t("arch.concurrency", { v: concurrency })}>
          <input type="range" min="1" max="8" step="1" value={concurrency}
            onChange={(e) => setConcurrency(parseInt(e.target.value))} style={{ width: 140 }} />
        </Field>
        <Field label={t("arch.userAgent")}>
          <input className="text-input" value={userAgent} onChange={(e) => setUserAgent(e.target.value)} style={{ width: 260 }} />
        </Field>
        <Field label={t("arch.cookies")}>
          <input className="text-input" value={cookies} onChange={(e) => setCookies(e.target.value)} style={{ width: 260 }} placeholder="k=v; k2=v2" />
        </Field>
      </Glass>

      {/* --- Прогресс стадий --- */}
      {busy && job && (
        <Glass className="chart-panel">
          <div className="muted-sm" style={{ marginBottom: 8 }}>
            {t(`arch.stage_${job.stage}`)} · {t("arch.pagesDone", { n: job.pages })}
          </div>
          <ProgressBar value={job.progress} />
        </Glass>
      )}
      {job?.stage === "error" && (
        <Glass><span style={{ color: "var(--coral)" }}>{t("cmp.error")}: {job.error}</span></Glass>
      )}
      {job?.done && job.stats && (
        <Glass className="chart-panel">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Badge tone="teal">{t("arch.pagesDone", { n: job.stats.pages })}</Badge>
            <Badge tone="violet">{t("cmp.original")}: {fmtMB(job.stats.origSize)}</Badge>
            <Badge tone="amber">.sitebak: {fmtMB(job.stats.bakSize)}</Badge>
            <Badge tone="teal">−{job.stats.savedPct}%</Badge>
          </div>
        </Glass>
      )}

      {/* --- Карточки готовых архивов (+ контекстное меню) --- */}
      <div className="field-label" style={{ margin: "18px 2px 8px" }}>{t("arch.recent")}</div>
      <div className="task-list">
        {archives.map((a) => (
          <Glass className="task-row" key={a.id}
            onContextMenu={(e) => menu.open(e, [
              { label: t("arch.openLive"), icon: ExternalLink, onClick: () => window.open(a.site, "_blank") },
              { label: t("arch.previewOffline"), icon: Play, onClick: () => window.open(api.archivePreview(a.id), "_blank") },
              { label: t("arch.verify"), icon: ShieldCheck, onClick: () => doVerify(a.id) },
              { label: t("arch.extractAssets"), icon: FileSearch, onClick: () => api.archiveExtract(a.id).catch(() => {}) },
              // М5: показать файл архива в проводнике.
              { label: t("ctx.reveal"), icon: FolderOpen, onClick: async () => { try { const r = await api.archiveReveal(a.id); const br = (window as any).appBridge; if (br?.revealPath) await br.revealPath(r.path); else copyToClipboard(r.path); } catch { /* */ } } },
              { separator: true },
              { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(a.name) },
              { label: t("ctx.copyLink"), icon: Copy, onClick: () => copyToClipboard(a.site) },
              { separator: true },
              { label: t("ctx.del"), icon: Trash2, danger: true, onClick: async () => { await api.archiveDelete(a.id); api.archiveList().then(setArchives).catch(() => {}); } },
            ])}>
            <Archive size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="task-text" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
              <div className="muted-sm">
                {t("arch.pagesDone", { n: a.stats?.pages ?? 0 })} · {fmtMB(a.stats?.origSize)} → {fmtMB(a.stats?.bakSize)}
                {a.stats?.savedPct != null ? ` · −${a.stats.savedPct}%` : ""}
                {a.stats?.compression ? ` · ${a.stats.compression.textAlgo}` : ""}
              </div>
              {verifyResult[a.id] && <div className="muted-sm" style={{ color: "var(--teal)" }}>{verifyResult[a.id]}</div>}
            </div>
            <IconBtn icon={ShieldCheck} title={t("arch.verify")} onClick={() => doVerify(a.id)} />
            <IconBtn icon={Download} title={t("arch.download")} onClick={() => { window.location.href = api.archiveDownload(a.id); }} />
          </Glass>
        ))}
        {archives.length === 0 && <EmptyHint icon={Archive} text={t("arch.empty")} />}
      </div>
    </div>
  );
}
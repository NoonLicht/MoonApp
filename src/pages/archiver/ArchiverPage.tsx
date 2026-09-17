import React, { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  Download,
  Globe,
  Layers,
  Filter,
  Copy,
  Trash2,
  ShieldCheck,
  FileSearch,
  Play,
  ExternalLink,
  Loader2,
  FolderOpen,
  Compass,
  Wifi,
  Search,
  X,
  RefreshCw,
} from "lucide-react";
import { useContextMenu, copyToClipboard } from "@/components/ContextMenu";
import {
  Btn,
  Glass,
  Badge,
  Select,
  SectionHead,
  ProgressBar,
  Field,
  Checkbox,
  EmptyHint,
} from "@/components/ui";
import { usePageActive, usePageBusy } from "@/components/Toolbar";
import { getOverlayRoot } from "@/components/overlayHost";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { ArchivePage, SitebakArchive, SitebakJob } from "@/api/client";
import "@/styles/arch.css";

/**
 * Web Archive Engine (.sitebak): краулер + упаковщик офлайн-копий.
 *
 * Вёрстка: страница — вертикальная колонка со скроллом (на любой ширине окна),
 * три адаптивные секции настроек (обход / контент / сеть) и сетка карточек
 * готовых архивов. Поля тянутся по ширине ячейки, поэтому на узких экранах
 * (до 640px) ничего не обрезается. Стили — в src/styles/arch.css.
 *
 * Логика:
 *  - Дефолты секций — из настроек sitebak.*.
 *  - POST /archive/start запускает 5-стадийный пайплайн; страница опрашивает
 *    статус (crawl → optimize → pack → done) и прогресс.
 *  - Карточки архивов: статистика (страницы, исходный размер, .sitebak,
 *    % экономии), кнопки скачать/проверить, контекстное меню.
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

  // --- Встроенный просмотр архива ---
  // Раньше готовый .sitebak можно было только скачать/распаковать и смотреть в
  // браузере. Здесь страницы открываются прямо внутри приложения: слева список
  // страниц (заголовки из <title>), справа сама страница во фрейме с локального
  // API. Ссылки внутри архива переписаны на локальные адреса, поэтому переходы и
  // картинки работают офлайн (см. server/routes/archive.js).
  const [viewer, setViewer] = useState<{
    id: string;
    name: string;
    site: string;
    total: number;
    pages: ArchivePage[];
  } | null>(null);
  const [viewerBusy, setViewerBusy] = useState("");
  const [viewerError, setViewerError] = useState("");
  const [viewerQuery, setViewerQuery] = useState("");
  const [viewerPage, setViewerPage] = useState("");
  // Кадр перезагружается принудительно: после клика по ссылке внутри архива
  // неизвестно, куда он уехал, а кнопкой «Обновить» можно вернуться на страницу
  // из списка.
  const [frameKey, setFrameKey] = useState(0);

  const viewerList = useMemo(() => {
    const q = viewerQuery.trim().toLowerCase();
    if (!viewer || !q) return viewer?.pages || [];
    return viewer.pages.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        p.url.toLowerCase().includes(q),
    );
  }, [viewer, viewerQuery]);

  /** Открыть архив в просмотрщике: подтягиваем список страниц. */
  const openViewer = async (a: SitebakArchive) => {
    setViewer({ id: a.id, name: a.name, site: a.site, total: 0, pages: [] });
    setViewerPage("");
    setViewerQuery("");
    setViewerError("");
    setViewerBusy(a.id);
    try {
      const r = await api.archivePages(a.id);
      setViewer({ id: r.id, name: r.name || a.name, site: r.site, total: r.total, pages: r.pages });
      setViewerPage(r.pages[0]?.path || "");
      setFrameKey((k) => k + 1);
    } catch (e: any) {
      setViewerError(String(e?.message || e));
    } finally {
      setViewerBusy("");
    }
  };

  // Уход со страницы закрывает просмотрщик: он рисуется порталом поверх всего
  // приложения и иначе остался бы висеть над другой страницей (эффект по isActive).

  // Esc закрывает окно просмотра — как в остальных модалках приложения. Клик по
  // затемнению и крестик работают только пока у окна есть pointer-events (см.
  // .arch-view-overlay в arch.css), поэтому клавиша — ещё одна страховка.
  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);

  // Дефолты из настроек sitebak.* применяются при открытии страницы.
  useEffect(() => {
    api
      .getSettings()
      .then((s: any) => {
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
      })
      .catch(() => {
        /* дефолты из кода */
      });
    api
      .archiveList()
      .then(setArchives)
      .catch(() => {});
  }, []);

  /* ── опрос активного архивирования ──
   * В фоне (страница не видима) опрос реже: краулер работает на сервере, а
   * интерфейс догоняет его сразу при возвращении. */
  const [jobId, setJobId] = useState<string | null>(null);
  const isActive = usePageActive();

  // Уход со страницы закрывает просмотрщик архива: он рисуется порталом поверх
  // всего приложения и иначе остался бы висеть над другой страницей.
  useEffect(() => {
    if (!isActive) setViewer(null);
  }, [isActive]);

  useEffect(() => {
    if (!jobId) return undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await api.archiveStatus(jobId);
        if (stopped) return;
        setJob(s);
        if (s.done || s.stage === "error") {
          setJobId(null);
          api
            .archiveList()
            .then(setArchives)
            .catch(() => {});
        }
      } catch {
        /* повтор на следующем тике */
      }
    };
    const timer = window.setInterval(tick, isActive ? 1200 : 4000);
    if (isActive) void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, isActive]);

  // Незавершённое архивирование — страницу нельзя выгружать из памяти (LRU).
  usePageBusy(!!jobId);

  const start = async () => {
    if (!/^https?:\/\//i.test(url.trim())) return;
    try {
      const j = await api.archiveStart({
        url: url.trim(),
        depth,
        domainScope: scope,
        maxPages,
        imageMode,
        stripScripts,
        stripExif,
        blockAds,
        inlineAssets,
        delayMs,
        concurrency,
        cookies,
        userAgent,
      });
      setJob(j);
      setVerifyResult({});
      setJobId(j.id);
    } catch (e: any) {
      setJob({
        id: "",
        url,
        name: "",
        stage: "error",
        progress: 0,
        pages: 0,
        origSize: 0,
        bakSize: 0,
        error: String(e.message || e),
        done: false,
      });
    }
  };

  const fmtMB = (b?: number) => (!b && b !== 0 ? "—" : `${(b / 1024 / 1024).toFixed(1)} MB`);
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

  /** Тумблер-чип секции «Контент и фильтры». */
  const chip = (on: boolean, toggle: () => void, Icon: React.ElementType, label: string) => (
    <button className={`option-item ${on ? "is-on" : ""}`} onClick={toggle}>
      <Checkbox checked={on} onClick={toggle} />
      <Icon size={15} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className="page arch-page">
      <SectionHead eyebrow={t("arch.eyebrow")} title={t("arch.title")} />

      {/* --- Шаг 1: адрес страницы --- */}
      <Glass
        className="arch-hero"
        onContextMenu={(e) =>
          menu.open(e, [
            url.length > 0 && {
              label: t("ctx.copyLink"),
              icon: Copy,
              onClick: () => copyToClipboard(url),
            },
            url.length > 0 && { label: t("ctx.clear"), icon: Trash2, onClick: () => setUrl("") },
          ])
        }
      >
        <div className="arch-url">
          <Globe size={16} />
          <input
            placeholder={t("arch.paste")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && start()}
          />
          <Btn variant="primary" icon={busy ? Loader2 : Archive} onClick={start} disabled={busy}>
            {busy ? t("arch.archiving") : t("arch.savePage")}
          </Btn>
        </div>
      </Glass>

      {/* --- Шаг 2: настройки — три адаптивные секции --- */}
      <div className="arch-sections">
        <Glass className="arch-card">
          <div className="arch-card-head">
            <Compass size={15} /> {t("arch.sectionCrawl")}
          </div>
          <div className="arch-fields">
            <Field label={t("arch.depth")}>
              <Select value={depth} onChange={(e) => setDepth(e.target.value)} options={DEPTHS} />
            </Field>
            <Field label={t("arch.scope")}>
              <Select value={scope} onChange={(e) => setScope(e.target.value)} options={SCOPES} />
            </Field>
            <Field label={t("arch.maxPages")}>
              <input
                className="text-input"
                type="number"
                min="1"
                max="5000"
                value={maxPages}
                onChange={(e) => setMaxPages(parseInt(e.target.value) || 500)}
              />
            </Field>
            <Field label={t("arch.imageMode")}>
              <Select
                value={imageMode}
                onChange={(e) => setImageMode(e.target.value)}
                options={IMG_MODES}
              />
            </Field>
          </div>
        </Glass>

        {/* --- Контент и фильтры (strip/inline/block) --- */}
        <Glass className="arch-card">
          <div className="arch-card-head">
            <Filter size={15} /> {t("arch.sectionContent")}
          </div>
          <div className="arch-chips">
            {chip(
              stripScripts,
              () => setStripScripts(!stripScripts),
              Filter,
              t("arch.stripScripts"),
            )}
            {chip(blockAds, () => setBlockAds(!blockAds), ShieldCheck, t("arch.blockAds"))}
            {chip(
              inlineAssets,
              () => setInlineAssets(!inlineAssets),
              Layers,
              t("arch.inlineAssets"),
            )}
            {chip(stripExif, () => setStripExif(!stripExif), FileSearch, t("arch.stripExif"))}
          </div>
        </Glass>

        {/* --- Блок 4: Сеть и вежливость --- */}
        <Glass className="arch-card">
          <div className="arch-card-head">
            <Wifi size={15} /> {t("arch.sectionNetwork")}
          </div>
          <div className="arch-fields">
            <Field label={t("arch.delay", { v: delayMs })}>
              <input
                type="range"
                min="0"
                max="3000"
                step="100"
                value={delayMs}
                onChange={(e) => setDelayMs(parseInt(e.target.value))}
              />
            </Field>
            <Field label={t("arch.concurrency", { v: concurrency })}>
              <input
                type="range"
                min="1"
                max="8"
                step="1"
                value={concurrency}
                onChange={(e) => setConcurrency(parseInt(e.target.value))}
              />
            </Field>
            {/* Длинные строки (User-Agent, Cookie) занимают всю ширину карточки. */}
            <div className="arch-field-wide">
              <Field label={t("arch.userAgent")}>
                <input
                  className="text-input"
                  value={userAgent}
                  onChange={(e) => setUserAgent(e.target.value)}
                />
              </Field>
            </div>
            <div className="arch-field-wide">
              <Field label={t("arch.cookies")}>
                <input
                  className="text-input"
                  value={cookies}
                  onChange={(e) => setCookies(e.target.value)}
                  placeholder="k=v; k2=v2"
                />
              </Field>
            </div>
          </div>
        </Glass>
      </div>

      {/* --- Прогресс стадий --- */}
      {busy && job && (
        <Glass className="arch-progress">
          <div className="arch-progress-head">
            <span>
              {t(`arch.stage_${job.stage}`)} · {t("arch.pagesDone", { n: job.pages })}
            </span>
            <span>{job.progress}%</span>
          </div>
          <ProgressBar value={job.progress} />
        </Glass>
      )}
      {job?.stage === "error" && (
        <div className="arch-error">
          {t("cmp.error")}: {job.error}
        </div>
      )}
      {job?.done && job.stats && (
        <Glass className="arch-stats">
          <Badge tone="teal">{t("arch.pagesDone", { n: job.stats.pages })}</Badge>
          <Badge tone="violet">
            {t("cmp.original")}: {fmtMB(job.stats.origSize)}
          </Badge>
          <Badge tone="amber">.sitebak: {fmtMB(job.stats.bakSize)}</Badge>
          <Badge tone="teal">−{job.stats.savedPct}%</Badge>
        </Glass>
      )}

      {/* --- Готовые архивы: карточки (+ контекстное меню) --- */}
      <div className="arch-results-head">
        <span className="field-label">{t("arch.recent")}</span>
        {archives.length > 0 && <span className="muted-sm">{archives.length}</span>}
      </div>
      <div className="arch-archive-grid">
        {archives.map((a) => (
          <Glass
            className="arch-archive"
            key={a.id}
            onContextMenu={(e) =>
              menu.open(e, [
                {
                  label: t("arch.openLive"),
                  icon: ExternalLink,
                  onClick: () => window.open(a.site, "_blank"),
                },
                {
                  label: t("arch.previewOffline"),
                  icon: Play,
                  onClick: () => window.open(api.archivePreview(a.id), "_blank"),
                },
                { label: t("arch.verify"), icon: ShieldCheck, onClick: () => doVerify(a.id) },
                {
                  label: t("arch.extractAssets"),
                  icon: FileSearch,
                  onClick: () => api.archiveExtract(a.id).catch(() => {}),
                },
                // М5: показать файл архива в проводнике.
                {
                  label: t("ctx.reveal"),
                  icon: FolderOpen,
                  onClick: async () => {
                    try {
                      const r = await api.archiveReveal(a.id);
                      const br = (window as any).appBridge;
                      if (br?.revealPath) await br.revealPath(r.path);
                      else copyToClipboard(r.path);
                    } catch {
                      /* */
                    }
                  },
                },
                { separator: true },
                { label: t("ctx.copyName"), icon: Copy, onClick: () => copyToClipboard(a.name) },
                { label: t("ctx.copyLink"), icon: Copy, onClick: () => copyToClipboard(a.site) },
                { separator: true },
                {
                  label: t("ctx.del"),
                  icon: Trash2,
                  danger: true,
                  onClick: async () => {
                    await api.archiveDelete(a.id);
                    api
                      .archiveList()
                      .then(setArchives)
                      .catch(() => {});
                  },
                },
              ])
            }
          >
            <div className="arch-archive-top">
              <span className="arch-archive-icon">
                <Archive size={16} />
              </span>
              <div className="arch-archive-titles">
                <div className="arch-archive-name" title={a.name}>
                  {a.name}
                </div>
                <button
                  className="arch-archive-site"
                  title={a.site}
                  onClick={() => window.open(a.site, "_blank")}
                >
                  {a.site}
                </button>
              </div>
            </div>
            <div className="arch-archive-stats">
              <Badge tone="teal">{t("arch.pagesDone", { n: a.stats?.pages ?? 0 })}</Badge>
              <Badge tone="violet">
                {fmtMB(a.stats?.origSize)} → {fmtMB(a.stats?.bakSize)}
              </Badge>
              {a.stats?.savedPct != null && <Badge tone="amber">−{a.stats.savedPct}%</Badge>}
              {a.stats?.compression && (
                <Badge tone="neutral" mono>
                  {a.stats.compression.textAlgo}
                </Badge>
              )}
            </div>
            <div className="muted-sm arch-archive-date">
              {new Date(a.createdAt).toLocaleString()}
            </div>
            {verifyResult[a.id] && (
              <div className="muted-sm arch-archive-verify">{verifyResult[a.id]}</div>
            )}
            <div className="arch-archive-actions">
              <Btn
                icon={FileSearch}
                variant="secondary"
                onClick={() => void openViewer(a)}
                disabled={viewerBusy === a.id}
              >
                {viewerBusy === a.id ? t("arch.viewOpening") : t("arch.view")}
              </Btn>
              <Btn icon={ShieldCheck} onClick={() => doVerify(a.id)}>
                {t("arch.verify")}
              </Btn>
              <Btn
                icon={Download}
                variant="secondary"
                onClick={() => {
                  window.location.href = api.archiveDownload(a.id);
                }}
              >
                {t("arch.download")}
              </Btn>
            </div>
          </Glass>
        ))}
        {archives.length === 0 && <EmptyHint icon={Archive} text={t("arch.empty")} />}
      </div>

      {/* --- Просмотр архива внутри приложения ---
          Слева список страниц (заголовки из <title>), справа страница во фрейме с
          локального API: ссылки внутри архива уже ведут на локальные адреса, так
          что переходы и картинки работают без интернета. Скрипты вырезаны, фрейм
          в песочнице без скриптов — чужая страница не может обратиться к API. --- */}
      {viewer &&
        createPortal(
          <div className="arch-view-overlay" onClick={() => setViewer(null)}>
            <div
              className="arch-view"
              role="dialog"
              aria-label={t("arch.view")}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="arch-view-head">
                <div className="arch-view-title">
                  <Globe size={14} />
                  <span className="arch-view-name" title={viewer.name}>
                    {viewer.name}
                  </span>
                  {viewer.total > 0 && (
                    <Badge tone="teal">{t("arch.pagesDone", { n: viewer.total })}</Badge>
                  )}
                </div>
                <div className="arch-view-head-actions">
                  {!!viewer.site && (
                    <Btn
                      icon={ExternalLink}
                      variant="ghost"
                      onClick={() => window.open(viewer.site, "_blank")}
                    >
                      {t("arch.viewSite")}
                    </Btn>
                  )}
                  <Btn
                    icon={RefreshCw}
                    variant="ghost"
                    onClick={() => setFrameKey((k) => k + 1)}
                    disabled={!viewerPage}
                  >
                    {t("arch.viewReload")}
                  </Btn>
                  <button
                    className="arch-view-close"
                    onClick={() => setViewer(null)}
                    aria-label={t("common.close")}
                    title={t("common.close")}
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
              <div className="arch-view-body">
                <div className="arch-view-side">
                  <div className="arch-view-search">
                    <Search size={13} />
                    <input
                      value={viewerQuery}
                      onChange={(e) => setViewerQuery(e.target.value)}
                      placeholder={t("arch.viewSearch")}
                      spellCheck={false}
                    />
                  </div>
                  <div className="arch-view-list">
                    {viewerList.map((p) => (
                      <button
                        key={p.path}
                        className={`arch-view-item ${viewerPage === p.path ? "is-active" : ""}`}
                        onClick={() => {
                          setViewerPage(p.path);
                          setFrameKey((k) => k + 1);
                        }}
                        title={p.url || p.path}
                      >
                        <span className="arch-view-item-title">{p.title}</span>
                        {!!p.url && <span className="arch-view-item-url">{p.url}</span>}
                      </button>
                    ))}
                    {!!viewerBusy && <span className="muted-sm">{t("arch.viewOpening")}</span>}
                    {!viewerBusy && !viewerList.length && (
                      <span className="muted-sm">{t("arch.viewEmpty")}</span>
                    )}
                  </div>
                </div>
                <div className="arch-view-frame">
                  {viewerError ? (
                    <div className="arch-view-error">{viewerError}</div>
                  ) : viewerPage ? (
                    <iframe
                      key={frameKey}
                      className="arch-view-iframe"
                      src={api.archivePreview(viewer.id, viewerPage)}
                      title={viewer.name}
                      /* Песочница без allow-scripts: чужая страница не выполнит
                         код и не дотянется до appBridge; allow-same-origin нужен,
                         чтобы doc-CSP `'self'` продолжал пускать свои же CSS и
                         картинки из /api/archive/.../raw. */
                      sandbox="allow-same-origin"
                    />
                  ) : (
                    <div className="arch-view-error">{t("arch.viewNoPages")}</div>
                  )}
                </div>
              </div>
            </div>
          </div>,
          getOverlayRoot() ?? document.body,
        )}
    </div>
  );
}

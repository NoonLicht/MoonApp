import React, { useState, useEffect, useRef } from "react";
import { Video, Download, AlertTriangle, RefreshCw, Check, Image, Subtitles, Terminal, ClipboardPaste, X } from "lucide-react";
import { Glass, Btn, Badge, Select, SectionHead, EmptyHint, ProgressBar } from "../components/ui";
import { useContextMenu, copyToClipboard } from "../components/ContextMenu";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { VideoInfo, YtdlpInstallStatus } from "../api/types";

const C = ["MP4", "WEBM", "MKV"];
const fmt = (n?: number | null): string => (n ? (n / 1024 / 1024).toFixed(1) + " MB" : "");

interface JobFile {
  name: string;
  size: number;
  key: string;
}

export default function VideoPage() {
  const { t } = useI18n();
  const menu = useContextMenu();
  const [u, setU] = useState("");
  const [st, setSt] = useState("idle");
  const [i, setI] = useState<VideoInfo | null>(null);
  const [h, setH] = useState<number | null>(null);
  const [c, setC] = useState("MP4");
  const [j, setJ] = useState<string | null>(null);
  const [p, setP] = useState(0);
  const [jf, setJf] = useState<JobFile[]>([]);
  const [err, setErr] = useState("");
  const [sub, setSub] = useState<string[]>([]);
  const [et, setEt] = useState(false);
  const [ins, setIns] = useState<YtdlpInstallStatus | null>(null);

  // Дефолты загрузки из настроек (раздел «Видео»): макс. высота,
  // вшивание обложки и автозагрузка субтитров.
  const vcfg = useRef<{ defaultHeight?: string; embedThumbnail?: boolean; downloadSubs?: boolean }>({});
  useEffect(() => {
    api.getSettings().then((s: any) => {
      vcfg.current = s?.video || {};
      setEt(vcfg.current.embedThumbnail !== false);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!j) return;
    const timer = setInterval(async () => {
      try {
        const stj = await api.getVideoJobStatus(j);
        setP(stj.progress || 0);
        if (stj.state === "done") { setSt("done"); setJf(stj.files || []); clearInterval(timer); }
        if (stj.state === "error") { setSt("error"); setErr(stj.error || ""); clearInterval(timer); }
      } catch { /* пропускаем опрос */ }
    }, 800);
    return () => clearInterval(timer);
  }, [j]);

  useEffect(() => {
    if (ins?.state !== "working") return;
    const timer = setInterval(async () => {
      try { const stj = await api.getVideoInstall(); setIns(stj); } catch { /* */ }
    }, 900);
    return () => clearInterval(timer);
  }, [ins?.state]);

  usePageToolbar(<Select value={c} onChange={(e) => setC(e.target.value)} options={C} />, [c]);

  const fi = async () => {
    if (!u.trim()) return;
    setSt("parsing"); setErr("");
    try {
      const d = await api.getVideoInfo(u.trim());
      // Выбираем качество: «best» — максимум, иначе ближайшая высота <= лимита.
      const dh = vcfg.current.defaultHeight || "best";
      const pick = dh === "best"
        ? (d.heights[0] || null)
        : (d.heights.find((x: number) => x <= Number(dh)) || d.heights[d.heights.length - 1] || null);
      setI(d);
      setH(pick);
      setSub(vcfg.current.downloadSubs ? Object.keys(d.subtitles || {}) : []);
      setSt("ready");
    } catch (e) { setSt("error"); setErr((e as Error).message); }
  };

  const dl = async () => {
    if (!i) return;
    setSt("downloading"); setP(0); setErr("");
    try {
      const r = await api.startVideoDownload({
        url: i.webUrl || u,
        info: i,
        height: h || undefined,
        container: c,
        subs: sub.length ? sub : undefined,
        thumb: et ? { embed: true } : undefined,
      });
      setJ(r.id);
    } catch (e) { setSt("error"); setErr((e as Error).message); }
  };

  const dlFile = async (k: string) => {
    try {
      const { blob, name } = await api.downloadVideoFile(k);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { setSt("error"); setErr((e as Error).message); }
  };

  const si = async () => {
    try { const s = await api.startVideoInstall(); setIns(s); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="page">
      <SectionHead eyebrow={t("video.eyebrow")} title={t("video.title")} />
      {ins && !ins.installed && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span className="muted-sm">{t("video.ytdlpMissing")}</span>
          {ins.state === "working" ? (
            <div className="install-progress" style={{ width: "100%" }}>
              <div className="muted-sm"><RefreshCw size={14} className="spin" /> {ins.phase === "extract" ? t("conv.installing") : t("conv.downloading", { p: ins.progress })}</div>
              <ProgressBar value={ins.progress} />
            </div>
          ) : (
            <Btn variant="primary" icon={Terminal} onClick={si} style={{ width: 180 }}>{t("conv.install")}</Btn>
          )}
        </Glass>
      )}
      <Glass className="url-bar"
        onContextMenu={(e) => menu.open(e, [
          { label: t("ctx.paste"), icon: ClipboardPaste, onClick: async () => {
              try { const txt = await navigator.clipboard.readText(); if (txt) setU(txt.trim()); } catch { /* нет доступа к буферу */ }
            } },
          u.length > 0 && { label: t("ctx.clear"), icon: X, onClick: () => setU("") },
        ])}
      >
        <Video size={16} />
        <input placeholder={t("video.paste")} value={u} onChange={(e) => setU(e.target.value)} onKeyDown={(e) => e.key === "Enter" && fi()} />
        <Btn variant="primary" onClick={fi} disabled={st === "parsing"}>{st === "parsing" ? t("video.fetching") : t("video.fetch")}</Btn>
      </Glass>
      {st === "idle" && <EmptyHint icon={Video} text={t("video.empty")} />}
      {st === "parsing" && <Glass><span className="muted-sm">{t("video.fetching")}</span></Glass>}
      {st === "ready" && i && (
        <Glass className="media-preview">
          <div className="media-thumb tone-amber">
            {i.thumbnail ? <img src={i.thumbnail} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 10 }} /> : <Video size={26} />}
          </div>
          <div className="media-info">
            <div className="media-title">{i.title}</div>
            <div className="muted-sm">{i.durationString || ""} · {i.heights.length}res {i.subtitles && Object.keys(i.subtitles).length ? "· subs" : ""}</div>
            <div className="quality-row">{i.heights.slice(0, 15).map((_h, idx) => <Badge key={idx} tone="amber" mono active={_h === h} onClick={() => setH(_h)}>{_h >= 2160 ? "4K" : _h + "p"}</Badge>)}</div>
            <div className="quality-row" style={{ gap: 4 }}>
              <Badge tone="neutral" mono>{c}</Badge>
              {Object.keys(i.subtitles || {}).length > 0 && (
                <Badge tone="teal" mono active={sub.length > 0} onClick={() => setSub(sub.length ? [] : Object.keys(i.subtitles))}>
                  <Subtitles size={12} />Sub
                </Badge>
              )}
              <Badge tone={et ? "violet" : "neutral"} mono onClick={() => setEt(!et)}>
                <Image size={12} />{et ? "thumb in" : "thumb"}
              </Badge>
            </div>
            <Btn variant="primary" icon={Download} onClick={dl} style={{ width: 260 }}>{t("video.download", { quality: h ? h + "p" : "best" })}</Btn>
          </div>
        </Glass>
      )}
      {st === "downloading" && (
        <Glass>
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="muted-sm"><RefreshCw size={14} className="spin" /> {t("video.downloading", { p })}</div>
            <ProgressBar value={p} />
          </div>
        </Glass>
      )}
      {st === "done" && jf.length > 0 && (
        <Glass className="media-preview">
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ color: "var(--success)" }}><Check size={16} />{t("video.saved")}</div>
            {jf.map((f) => (
              <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="muted-sm">{f.name} · {fmt(f.size)}</span>
                <Btn variant="primary" icon={Download} onClick={() => dlFile(f.key)}>{t("video.download")}</Btn>
              </div>
            ))}
          </div>
        </Glass>
      )}
      {st === "error" && err && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)" }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{err}</span>
        </Glass>
      )}
    </div>
  );
}
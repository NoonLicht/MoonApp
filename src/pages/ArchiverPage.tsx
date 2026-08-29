import React, { useState, useEffect } from "react";
import { Archive, Download, FileText, ImageOff, Braces, ShieldCheck } from "lucide-react";
import { Btn, IconBtn, Glass, Badge, SectionHead, ProgressBar, Checkbox, EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { ArchiveItem } from "../api/types";

const OPTIONS = [
  { k: "css", labelKey: "arch.inlineCSS", icon: FileText },
  { k: "images", labelKey: "arch.images", icon: ImageOff },
  { k: "fonts", labelKey: "arch.fonts", icon: Braces },
  { k: "removeScripts", labelKey: "arch.strip", icon: ShieldCheck },
];

type OptKey = "css" | "images" | "fonts" | "removeScripts";

export default function ArchiverPage() {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [opts, setOpts] = useState<Record<OptKey, boolean>>({ css: true, images: true, fonts: true, removeScripts: false });
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [archives, setArchives] = useState<ArchiveItem[]>([]);

  useEffect(() => { api.getArchives().then(setArchives).catch(() => {}); }, []);

  usePageToolbar(<Badge tone="violet" mono>{t("arch.singleFile")}</Badge>, [t]);

  const toggle = (k: OptKey) => setOpts((o) => ({ ...o, [k]: !o[k] }));

  const save = () => {
    if (!url.trim()) return;
    setSaving(true); setProgress(0);
    api.logAction("archive.save", { url }).catch(() => {});
    const timer = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          clearInterval(timer); setSaving(false);
          const name = url.replace(/^https?:\/\//, "");
          fetch("/api/archives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, size_text: `${(300 + Math.random() * 900).toFixed(0)} KB` }) }).then(() => api.getArchives().then(setArchives)).catch(() => {});
          setUrl(""); return 0;
        }
        return p + 10;
      });
    }, 130);
  };

  return (
    <div className="page">
      <SectionHead eyebrow={t("arch.eyebrow")} title={t("arch.title")} />
      <Glass className="url-bar">
        <Archive size={16} />
        <input placeholder={t("arch.paste")} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        <Btn variant="primary" onClick={save} disabled={saving}>{saving ? t("arch.saving") : t("arch.savePage")}</Btn>
      </Glass>

      <Glass className="option-grid">
        {OPTIONS.map(({ k, labelKey, icon: Icon }) => (
          <button key={k} className={`option-item ${opts[k as OptKey] ? "is-on" : ""}`} onClick={() => toggle(k as OptKey)}>
            <Checkbox checked={opts[k as OptKey]} onClick={() => toggle(k as OptKey)} />
            <Icon size={15} />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </Glass>

      {saving && (
        <Glass className="chart-panel">
          <div className="muted-sm" style={{ marginBottom: 8 }}>{t("arch.archiving")}</div>
          <ProgressBar value={progress} />
        </Glass>
      )}

      <div className="field-label" style={{ margin: "18px 2px 8px" }}>{t("arch.recent")}</div>
      <div className="task-list">
        {archives.map((a) => (
          <Glass className="task-row" key={a.id}>
            <Archive size={16} />
            <span className="task-text">{a.name}</span>
            <span className="muted-sm" style={{ fontFamily: "var(--font-mono)" }}>{a.size_text}</span>
            <IconBtn icon={Download} title={t("arch.download")} />
          </Glass>
        ))}
        {archives.length === 0 && <EmptyHint icon={Archive} text={t("arch.empty")} />}
      </div>
    </div>
  );
}
import React, { useState } from "react";
import { Music2, Download, Braces } from "lucide-react";
import { Glass, Btn, Badge, Select, SectionHead, EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";

const BITRATES = ["128 kbps", "192 kbps", "320 kbps", "FLAC"];

export default function MusicPage() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [bitrate, setBitrate] = useState("320 kbps");
  const [state, setState] = useState("idle");

  usePageToolbar(
    <Select value={bitrate} onChange={(e) => setBitrate(e.target.value)} options={BITRATES} />,
    [bitrate]
  );

  return (
    <div className="page">
      <SectionHead eyebrow={t("music.eyebrow")} title={t("music.title")} />
      <Glass className="url-bar">
        <Music2 size={16} />
        <input placeholder={t("music.paste")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && query.trim() && setState("ready")} />
        <Btn variant="primary" onClick={() => query.trim() && setState("ready")}>{t("music.find")}</Btn>
      </Glass>

      <Glass className="source-placeholder">
        <Braces size={16} />
        <span>{t("music.placeholder")}</span>
      </Glass>

      {state === "idle" ? (
        <EmptyHint icon={Music2} text={t("music.empty")} />
      ) : (
        <Glass className="media-preview">
          <div className="media-thumb tone-violet"><Music2 size={24} strokeWidth={1.5} /></div>
          <div className="media-info">
            <div className="media-title">{t("music.untitled")}</div>
            <div className="muted-sm">{t("music.unknown")}</div>
            <div className="quality-row">
              <Badge tone="violet" active>{bitrate}</Badge>
              <Badge tone="violet">MP3</Badge>
              <Badge tone="violet">M4A</Badge>
            </div>
            <Btn variant="primary" icon={Download} style={{ width: 160 }}>{t("music.download")}</Btn>
          </div>
        </Glass>
      )}
    </div>
  );
}
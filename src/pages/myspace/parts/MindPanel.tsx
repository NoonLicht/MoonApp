import { useState } from "react";
import { Brain } from "lucide-react";
import { useI18n } from "@/app/i18n";
import GapsSection from "@/pages/myspace/parts/mind/GapsSection";
import { ContradictionsSection, ReviewSection } from "@/pages/myspace/parts/mind/ReviewSections";
import ConfidenceSection from "@/pages/myspace/parts/mind/ConfidenceSection";
import ProvenanceSection from "@/pages/myspace/parts/mind/ProvenanceSection";
import TracesSection from "@/pages/myspace/parts/mind/TracesSection";

/**
 * «Мышление»: инструменты, которые смотрят на заметки как на систему идей —
 * противоречия, рецензент, уверенность, происхождение абзацев, следы решений,
 * белые пятна. Сворачивается; секции грузятся только при раскрытии.
 */
export default function MindPanel({
  path,
  content,
  onChange,
}: {
  path: string | null;
  content: string;
  onChange: (path: string, text: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <button className="btn" onClick={() => setOpen((v) => !v)}>
        <Brain size={14} /> {t("myspace.mind.title")}
      </button>
      {open && (
        <div style={{ display: "grid", gap: 14 }}>
          <ContradictionsSection path={path} content={content} />
          <ReviewSection content={content} />
          <ConfidenceSection path={path} content={content} onChange={onChange} />
          <ProvenanceSection path={path} content={content} />
          <TracesSection path={path} content={content} />
          <GapsSection />
        </div>
      )}
    </div>
  );
}

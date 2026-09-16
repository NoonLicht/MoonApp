import { LayoutTemplate, X } from "lucide-react";
import { TEMPLATES } from "./templates";

export default function TemplatesModal({ onClose, onSelect }: {
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="holst-overlay" onClick={onClose}>
      <div className="holst-modal" onClick={(e) => e.stopPropagation()}>
        <h3><LayoutTemplate size={16} /> Templates Library</h3>
        <div className="holst-tpl-grid">
          {TEMPLATES.map((t) => (
            <button key={t.id} className="holst-tpl-card" onClick={() => { onSelect(t.id); onClose(); }}>
              <span className="tpl-emoji">{t.emoji}</span>
              <span className="tpl-name">{t.name}</span>
              <span className="tpl-desc">{t.desc}</span>
            </button>
          ))}
        </div>
        <button className="holst-hbtn" onClick={onClose} style={{ marginTop: 12 }}><X size={13} /> Close</button>
      </div>
    </div>
  );
}

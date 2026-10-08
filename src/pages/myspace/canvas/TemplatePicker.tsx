import { LayoutTemplate, X } from "lucide-react";
import { TEMPLATES } from "@/pages/myspace/canvas/templates";
import type { Key } from "@/pages/myspace/canvas/strings";

/** Окно с шаблонами досок. */
export function TemplatesModal({
  onClose,
  onSelect,
  t,
}: {
  onClose: () => void;
  onSelect: (id: string) => void;
  t: (k: Key) => string;
}) {
  return (
    <div className="hc-overlay" data-ui onClick={onClose}>
      <div className="hc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hc-modal-head">
          <h3>
            <LayoutTemplate size={16} /> {t("templates")}
          </h3>
          <button type="button" className="hc-icon-sm" onClick={onClose} aria-label="close">
            <X size={15} />
          </button>
        </div>
        <div className="hc-tpl-grid">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className="hc-tpl-card"
              onClick={() => {
                onSelect(tpl.id);
                onClose();
              }}
            >
              <span style={{ fontSize: 22 }}>{tpl.emoji}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{tpl.name}</span>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{tpl.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

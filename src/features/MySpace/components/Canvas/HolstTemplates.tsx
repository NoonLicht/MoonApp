import React from "react";

const TEMPLATES = [
  { id: "mindmap", name: "Mind Map", desc: "Central topic with branching notes", emoji: "🧠" },
  { id: "retro", name: "Retrospective", desc: "Start / Stop / Continue", emoji: "🔄" },
  { id: "sprint", name: "Sprint Planning", desc: "Effort vs Impact matrix", emoji: "📋" },
  { id: "flowchart", name: "Flowchart", desc: "Decision nodes + arrows", emoji: "🔀" },
];

export default function TemplatesModal({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="holst-modal-overlay" onClick={onClose}>
      <div className="holst-modal" onClick={(e) => e.stopPropagation()}>
        <h3>📐 Templates</h3>
        <div className="holst-templates-grid">
          {TEMPLATES.map((t) => (
            <button key={t.id} onClick={() => { onSelect(t.id); onClose(); }}>
              <span style={{ fontSize: 20 }}>{t.emoji}</span>
              <span style={{ fontWeight: 600 }}>{t.name}</span>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{t.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
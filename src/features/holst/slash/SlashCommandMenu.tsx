import React, { useState, useEffect, useRef, useCallback } from "react";

interface CommandItem {
  id: string;
  label: string;
  icon: string;
  description: string;
  action: () => void;
}

interface SlashCommandMenuProps {
  /** Whether the menu is visible */
  isOpen: boolean;
  /** Current query text (after "/") */
  query: string;
  /** Position on canvas */
  position: { x: number; y: number };
  /** Available commands */
  commands: CommandItem[];
  /** Close callback */
  onClose: () => void;
}

export function SlashCommandMenu({
  isOpen,
  query,
  position,
  commands,
  onClose,
}: SlashCommandMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = commands.filter(
    (c) =>
      c.label.toLowerCase().includes(query.toLowerCase()) ||
      c.id.toLowerCase().includes(query.toLowerCase())
  );

  const executeSelected = useCallback(() => {
    if (filtered[selectedIndex]) {
      filtered[selectedIndex].action();
      onClose();
    }
  }, [filtered, selectedIndex, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedIndex(0);

    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        executeSelected();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, filtered.length, executeSelected, onClose]);

  if (!isOpen) return null;

  const MENU_WIDTH = 280;
  const ITEM_HEIGHT = 44;
  const maxVisible = Math.min(filtered.length, 8);

  return (
    <div
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        zIndex: 9999,
        width: MENU_WIDTH,
      }}
    >
      <div
        style={{
          background: "var(--surface-solid)",
          border: "1px solid var(--glass-border)",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
          backdropFilter: "blur(20px)",
          overflow: "hidden",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--glass-border)",
            fontSize: 10,
            color: "var(--text-tertiary)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>Commands</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span style={{ opacity: 0.5 }}>{filtered.length} results</span>
        </div>

        {/* List */}
        <div
          style={{
            maxHeight: maxVisible * ITEM_HEIGHT,
            overflow: "hidden",
          }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                padding: "16px 12px",
                textAlign: "center",
                color: "var(--text-tertiary)",
                fontSize: 11,
              }}
            >
              No matching commands
            </div>
          ) : (
            filtered.slice(0, 8).map((cmd, i) => (
              <div
                key={cmd.id}
                onClick={() => {
                  cmd.action();
                  onClose();
                }}
                onMouseEnter={() => setSelectedIndex(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 12px",
                  cursor: "pointer",
                  background: i === selectedIndex ? "var(--track)" : "transparent",
                  color: i === selectedIndex ? "var(--text-primary)" : "var(--text-secondary)",
                  transition: "background 0.1s",
                  borderLeft: `3px solid ${i === selectedIndex ? "var(--teal)" : "transparent"}`,
                }}
              >
                <span style={{ fontSize: 16, flexShrink: 0 }}>{cmd.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cmd.label}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cmd.description}
                  </div>
                </div>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", opacity: 0.6 }}>
                  /{cmd.id}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div
          style={{
            padding: "6px 12px",
            borderTop: "1px solid var(--glass-border)",
            fontSize: 10,
            color: "var(--text-tertiary)",
            display: "flex",
            gap: 12,
          }}
        >
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
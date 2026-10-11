import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getOverlayRoot } from "@/components/overlayHost";
import { tNow } from "@/app/i18n";

/**
 * Замена window.prompt(): в Electron он не поддерживается (возвращает null без окна),
 * из-за чего «Переименовать» и «Новая заметка» молча ничего не делали.
 * Возвращает введённый текст или null, если окно закрыли/отменили.
 */
export function askText(title: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    (getOverlayRoot() ?? document.body).appendChild(host);
    const root = createRoot(host);
    const done = (v: string | null) => {
      resolve(v);
      // размонтируем после обработчика, чтобы не снимать дерево во время его события
      window.setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
    };
    root.render(<AskDialog title={title} initial={initial} onDone={done} />);
  });
}

function AskDialog({
  title,
  initial,
  onDone,
}: {
  title: string;
  initial: string;
  onDone: (v: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // выделяем имя без расширения — как в проводнике
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const submit = () => onDone(value);
  return (
    <div
      className="ms-ai-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDone(null);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: 380,
          maxWidth: "100%",
          padding: 18,
          borderRadius: 14,
          background: "var(--bg-elevated, #1b1b24)",
          border: "1px solid var(--border-subtle, rgba(255,255,255,0.12))",
          color: "var(--text-primary, #fff)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") onDone(null);
          }}
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--border-subtle, rgba(255,255,255,0.18))",
            background: "rgba(255,255,255,0.06)",
            color: "inherit",
            fontSize: 13,
            outline: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={() => onDone(null)}>
            {tNow("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={submit}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

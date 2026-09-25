import { useEffect, useMemo, useRef, useState } from "react";
import { Zap, Search } from "lucide-react";
import { Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LauncherEntry } from "@/api/types";

/**
 * Командная палитра поверх всего приложения: открывается глобальным хоткеем
 * Alt+Space (работает даже когда окно свёрнуто/в трее — см.
 * electron/main.js → registerCommandPaletteHotkey + IPC "app:open-palette").
 * Список — те же карточки-лаунчеры со страницы «Автоматизация»
 * (server/ts/automation.ts): ничего нового на бэкенде не нужно, палитра
 * просто даёт быстрый доступ к уже существующим командам.
 */
export default function CommandPalette() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [launchers, setLaunchers] = useState<LauncherEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [runError, setRunError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const off = window.appBridge?.onOpenPalette?.(() => {
      setQuery("");
      setSelected(0);
      setRunError("");
      setOpen(true);
      api
        .automationLaunchers()
        .then(setLaunchers)
        .catch(() => setLaunchers([]));
    });
    return off;
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return launchers;
    return launchers.filter((l) => l.name.toLowerCase().includes(q) || l.exePath.toLowerCase().includes(q));
  }, [launchers, query]);

  const run = async (l: LauncherEntry) => {
    const r = await api.automationRunLauncher(l.id);
    if (!r.ok) {
      setRunError(`${l.name}: ${r.error}`);
      return;
    }
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      const l = filtered[selected];
      if (l) void run(l);
    }
  };

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 1000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "14vh",
      }}
      onClick={() => setOpen(false)}
    >
      <Glass
        style={{
          width: 480,
          maxWidth: "90vw",
          maxHeight: "60vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: 14,
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--glass-border)" }}>
          <Search size={16} style={{ color: "var(--text-tertiary)" }} />
          <input
            ref={inputRef}
            className="text-input"
            style={{ border: "none", background: "transparent", flex: 1, fontSize: 15 }}
            placeholder={t("palette.placeholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        {runError && (
          <div style={{ padding: "8px 14px", color: "var(--coral)", fontSize: 13 }}>{runError}</div>
        )}

        <div style={{ overflow: "auto" }}>
          {filtered.length === 0 && (
            <div className="muted-sm" style={{ padding: 14 }}>
              {launchers.length === 0 ? t("palette.empty") : t("palette.noMatch")}
            </div>
          )}
          {filtered.map((l, i) => (
            <div
              key={l.id}
              onClick={() => void run(l)}
              onMouseEnter={() => setSelected(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 14px",
                cursor: "pointer",
                background: i === selected ? "var(--glass-hover, rgba(255,255,255,0.06))" : "transparent",
              }}
            >
              <Zap size={14} style={{ color: "var(--amber)" }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{l.name}</div>
                <div className="muted-sm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {l.exePath}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Glass>
    </div>
  );
}

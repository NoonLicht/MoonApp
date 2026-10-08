import { useEffect, useMemo, useRef, useState } from "react";
import { Zap, Search, Sparkles } from "lucide-react";
import { Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LauncherEntry } from "@/api/types";
import type { SemHit } from "@/api/apiSemantic";
import { PAGES } from "@/app/navigation";
import { openTarget, targetFor, SOURCE_LABEL } from "@/lib/deepLink";

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
  const [hits, setHits] = useState<SemHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const show = () => {
      setQuery("");
      setSelected(0);
      setRunError("");
      setHits([]);
      setOpen(true);
      api
        .automationLaunchers()
        .then(setLaunchers)
        .catch(() => setLaunchers([]));
    };
    const off = window.appBridge?.onOpenPalette?.(show);
    // Внутри окна — Ctrl+K (Alt+Space работает глобально, через Electron).
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyK" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off?.();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Умный поиск по заметкам, закладкам, лекциям, чатам, задачам, доскам и т.д.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 3) {
      setHits([]);
      return;
    }
    let live = true;
    const tm = setTimeout(() => {
      api
        .semSearch(q, undefined, 8)
        .then((h) => live && setHits(h))
        .catch(() => live && setHits([]));
    }, 300);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [query, open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  type Item =
    | { kind: "launcher"; key: string; l: LauncherEntry }
    | {
        kind: "page";
        key: string;
        id: (typeof PAGES)[number]["id"];
        name: string;
        Icon: React.ElementType;
      }
    | { kind: "hit"; key: string; h: SemHit };

  const filtered = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const ls = (
      q
        ? launchers.filter(
            (l) => l.name.toLowerCase().includes(q) || l.exePath.toLowerCase().includes(q),
          )
        : launchers
    ).map((l): Item => ({ kind: "launcher", key: `l${l.id}`, l }));
    const pg = q
      ? PAGES.map((p) => ({ p, name: t(p.i18n) }))
          .filter((x) => x.name.toLowerCase().includes(q))
          .map((x): Item => ({
            kind: "page",
            key: `p${x.p.id}`,
            id: x.p.id,
            name: x.name,
            Icon: x.p.icon,
          }))
      : [];
    const hs = hits.map((h): Item => ({ kind: "hit", key: `h${h.source}${h.ref}`, h }));
    return [...pg, ...ls, ...hs];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchers, query, hits]);

  const run = async (it: Item) => {
    if (it.kind === "launcher") {
      const r = await api.automationRunLauncher(it.l.id);
      if (!r.ok) {
        setRunError(`${it.l.name}: ${r.error}`);
        return;
      }
    } else if (it.kind === "page") openTarget({ page: it.id });
    else openTarget(targetFor(it.h.source, it.h.ref, it.h.at));
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
      const it = filtered[selected];
      if (it) void run(it);
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderBottom: "1px solid var(--glass-border)",
          }}
        >
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
          {filtered.map((it, i) => (
            <div
              key={it.key}
              onClick={() => void run(it)}
              onMouseEnter={() => setSelected(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 14px",
                cursor: "pointer",
                background:
                  i === selected ? "var(--glass-hover, rgba(255,255,255,0.06))" : "transparent",
              }}
            >
              {it.kind === "launcher" && <Zap size={14} style={{ color: "var(--amber)" }} />}
              {it.kind === "page" && <it.Icon size={14} style={{ color: "var(--amber)" }} />}
              {it.kind === "hit" && <Sparkles size={14} style={{ color: "var(--amber)" }} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {it.kind === "launcher" ? it.l.name : it.kind === "page" ? it.name : it.h.title}
                </div>
                <div
                  className="muted-sm"
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {it.kind === "launcher"
                    ? it.l.exePath
                    : it.kind === "page"
                      ? "Страница"
                      : `${SOURCE_LABEL[it.h.source]} · ${it.h.snippet.slice(0, 80)}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Glass>
    </div>
  );
}

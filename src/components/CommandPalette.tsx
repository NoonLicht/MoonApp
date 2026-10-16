import { onHotkey } from "@/lib/hotkeys";
import { useEffect, useMemo, useRef, useState } from "react";
import { Zap, Search, Settings2 } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LauncherEntry } from "@/api/types";
import type { SemHit } from "@/api/apiSemantic";
import { PAGES } from "@/app/navigation";
import { usePageAccess } from "@/app/pageAccess";
import { dragOutProps } from "@/lib/dragOut";
import { openTarget, targetFor, SOURCE_LABEL, SOURCE_ICON } from "@/lib/deepLink";
import { loadPickItems, type PickItem } from "@/components/LinkPicker";
import type { SemSource } from "@/api/apiSemantic";

const KINDS: SemSource[] = ["note", "task", "bookmark", "canvas", "lecture", "chat"];
const PER_KIND = 4;

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
  const { pages: shownPages } = usePageAccess();
  const [open, setOpen] = useState(false);
  const [launchers, setLaunchers] = useState<LauncherEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [runError, setRunError] = useState("");
  const [hits, setHits] = useState<SemHit[]>([]);
  const [index, setIndex] = useState<PickItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const show = () => {
      setQuery("");
      setSelected(0);
      setRunError("");
      setHits([]);
      setOpen(true);
      void Promise.all(KINDS.map((k) => loadPickItems(k).catch(() => [] as PickItem[]))).then((l) =>
        setIndex(l.flat()),
      );
      api
        .automationLaunchers()
        .then(setLaunchers)
        .catch(() => setLaunchers([]));
    };
    const off = window.appBridge?.onOpenPalette?.(show);
    // Внутри окна — настраиваемое сочетание, по умолчанию Ctrl+K
    // (Alt+Space работает глобально, через Electron).
    const offKey = onHotkey("palette", (e) => {
      e.preventDefault();
      show();
    });
    return () => {
      off?.();
      offKey();
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
    | {
        kind: "obj";
        key: string;
        src: SemSource;
        ref: string;
        title: string;
        sub: string;
        at?: number;
      }
    | { kind: "settings"; key: string; q: string };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: { title: string; items: Item[] }[] = [];
    const pg = shownPages.map((p) => ({ p, name: t(p.i18n) }))
      .filter((x) => !q || x.name.toLowerCase().includes(q))
      .map((x): Item => ({
        kind: "page",
        key: `p${x.p.id}`,
        id: x.p.id,
        name: x.name,
        Icon: x.p.icon,
      }));
    if (pg.length) out.push({ title: t("palette.groupPages"), items: pg });
    const ls = (
      q
        ? launchers.filter(
            (l) => l.name.toLowerCase().includes(q) || l.exePath.toLowerCase().includes(q),
          )
        : launchers
    ).map((l): Item => ({ kind: "launcher", key: `l${l.id}`, l }));
    if (ls.length) out.push({ title: t("palette.groupLaunch"), items: ls });
    if (q) {
      const seen = new Set<string>();
      const words = q.split(/\s+/).filter(Boolean);
      for (const k of KINDS) {
        const found = index
          .filter((i) => i.kind === k)
          .filter((i) => {
            const text = `${i.title} ${i.preview ?? ""} ${i.url ?? ""}`.toLowerCase();
            return words.every((w) => text.includes(w));
          })
          .slice(0, PER_KIND);
        if (!found.length) continue;
        found.forEach((i) => seen.add(i.kind + i.ref));
        out.push({
          title: SOURCE_LABEL[k],
          items: found.map((i): Item => ({
            kind: "obj",
            key: `o${i.kind}${i.ref}`,
            src: i.kind,
            ref: i.ref,
            title: i.title,
            sub: (i.preview ?? "").slice(0, 80),
          })),
        });
      }
      const sem = hits
        .filter((h) => !seen.has(h.source + h.ref))
        .map((h): Item => ({
          kind: "obj",
          key: `h${h.source}${h.ref}${h.at ?? ""}`,
          src: h.source,
          ref: h.ref,
          title: h.title,
          sub: `${SOURCE_LABEL[h.source]} · ${h.snippet.slice(0, 80)}`,
          at: h.at,
        }));
      if (sem.length) out.push({ title: t("palette.groupSemantic"), items: sem });
      if (q.length >= 2)
        out.push({
          title: t("palette.groupSettings"),
          items: [{ kind: "settings", key: "settings-q", q: query.trim() }],
        });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchers, query, hits, index, shownPages]);
  const filtered = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const run = async (it: Item) => {
    if (it.kind === "launcher") {
      const r = await api.automationRunLauncher(it.l.id);
      if (!r.ok) {
        setRunError(`${it.l.name}: ${r.error}`);
        return;
      }
    } else if (it.kind === "page") openTarget({ page: it.id });
    else if (it.kind === "settings") openTarget({ page: "settings", view: "search", ref: it.q });
    else openTarget(targetFor(it.src, it.ref, it.at));
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

  useEffect(() => {
    if (open)
      document.querySelector(".palette-item.is-active")?.scrollIntoView({ block: "nearest" });
  }, [open, selected, groups]);

  if (!open) return null;

  let idx = -1;
  return (
    <div className="palette-overlay" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Search size={16} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            className="palette-input"
            style={{ marginBottom: 0 }}
            placeholder={t("palette.searchPh")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {runError && (
          <div style={{ padding: "6px 8px", color: "var(--coral)", fontSize: 13 }}>{runError}</div>
        )}
        {filtered.length === 0 && (
          <div className="muted-sm" style={{ padding: 10 }}>
            {query.trim() ? t("palette.noMatch") : t("palette.empty")}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.title}>
            <div className="palette-group">{g.title}</div>
            {g.items.map((it) => {
              idx += 1;
              const i = idx;
              return (
                <button
                  key={it.key}
                  type="button"
                  className={`palette-item${i === selected ? " is-active" : ""}`}
                  onClick={() => void run(it)}
                  onMouseEnter={() => setSelected(i)}
                  {...(it.kind === "obj" && it.src === "note"
                    ? dragOutProps({ kind: "note", path: it.ref })
                    : {})}
                >
                  {it.kind === "launcher" && <Zap size={14} style={{ color: "var(--amber)" }} />}
                  {it.kind === "page" && <it.Icon size={14} style={{ color: "var(--amber)" }} />}
                  {it.kind === "settings" && (
                    <Settings2 size={14} style={{ color: "var(--amber)" }} />
                  )}
                  {it.kind === "obj" && (
                    <span style={{ width: 14, textAlign: "center" }}>{SOURCE_ICON[it.src]}</span>
                  )}
                  <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                      {it.kind === "launcher"
                        ? it.l.name
                        : it.kind === "page"
                          ? it.name
                          : it.kind === "settings"
                            ? t("palette.searchSettings", { q: it.q })
                            : it.title}
                    </span>
                    <span
                      className="muted-sm"
                      style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                    >
                      {it.kind === "launcher"
                        ? it.l.exePath
                        : it.kind === "page"
                          ? t("palette.pageSub")
                          : it.kind === "settings"
                            ? t("palette.settingsHint")
                            : it.sub || SOURCE_LABEL[it.src]}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

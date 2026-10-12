import { useEscape } from "@/lib/useEscape";
import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { api } from "@/api/client";
import { useI18n } from "@/app/i18n";
import type { VaultFile } from "@/api/types";
import type { SemSource } from "@/api/apiSemantic";
import { SOURCE_ICON, SOURCE_LABEL } from "@/lib/deepLink";

export interface PickItem {
  kind: SemSource;
  /** Путь заметки, id задачи/закладки/чата/лекции, имя доски. */
  ref: string;
  title: string;
  /** Для закладок — адрес. */
  url?: string;
  /** Короткое описание для карточки. */
  preview?: string;
}

const TABS: SemSource[] = ["note", "task", "bookmark", "canvas", "lecture", "chat"];

const flatNotes = (items: VaultFile[]): PickItem[] =>
  items.flatMap((it) =>
    it.type === "folder"
      ? flatNotes(it.children ?? [])
      : it.type === "note"
        ? [{ kind: "note" as const, ref: it.path, title: it.name.replace(/\.\w+$/, "") }]
        : [],
  );

export async function loadPickItems(kind: SemSource): Promise<PickItem[]> {
  switch (kind) {
    case "note":
      return flatNotes(await api.myspaceTree());
    case "task":
      return (await api.tasksList()).map((t) => ({
        kind,
        ref: t.id,
        title: t.title,
        preview: t.description || undefined,
      }));
    case "bookmark":
      return (await api.bookmarksList()).map((b) => ({
        kind,
        ref: b.id,
        title: b.title || b.url,
        url: b.url,
        preview: b.notes || b.url,
      }));
    case "canvas": {
      const l = (await api.myspaceListHolsts()) as { name: string; title?: string | null }[];
      return l.map((h) => ({ kind, ref: h.name, title: h.title || h.name.replace(/_/g, " ") }));
    }
    case "lecture":
      return (await api.lectureSessions()).map((s) => ({
        kind,
        ref: String(s.id),
        title: s.title,
        preview: s.started_at,
      }));
    case "chat":
      return (await api.getConversations()).map((c) => ({
        kind,
        ref: String(c.id),
        title: c.title,
      }));
    default:
      return [];
  }
}

/**
 * Окно «Вставить из приложения»: заметки, задачи, закладки, доски Canvas, лекции и чаты.
 * Поиск ищет и по словам, и по смыслу (если включён умный поиск).
 */
export default function LinkPicker({
  onPick,
  onClose,
  kinds = TABS,
}: {
  onPick: (item: PickItem) => void;
  onClose: () => void;
  kinds?: SemSource[];
}) {
  useEscape(onClose);
  const { t } = useI18n();
  const [tab, setTab] = useState<SemSource>(kinds[0]);
  const [items, setItems] = useState<PickItem[]>([]);
  const [q, setQ] = useState("");
  const [smart, setSmart] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    loadPickItems(tab)
      .then((l) => live && setItems(l))
      .catch(() => live && setItems([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [tab]);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 3) {
      setSmart(new Set());
      return;
    }
    let live = true;
    const tm = setTimeout(() => {
      api
        .semSearch(text, [tab], 20)
        .then((h) => live && setSmart(new Set(h.map((x) => x.ref))))
        .catch(() => live && setSmart(new Set()));
    }, 300);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [q, tab]);

  const shown = useMemo(() => {
    const low = q.trim().toLowerCase();
    if (!low) return items.slice(0, 200);
    const byWord = items.filter((i) => `${i.title} ${i.preview ?? ""}`.toLowerCase().includes(low));
    const byMeaning = items.filter((i) => smart.has(i.ref) && !byWord.includes(i));
    return [...byWord, ...byMeaning].slice(0, 200);
  }, [items, q, smart]);

  return (
    <div
      className="proxy-panel-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="proxy-panel" style={{ maxWidth: 520 }}>
        <div className="proxy-panel-header">
          <div className="proxy-panel-title">
            <div className="proxy-title-text">
              <div className="proxy-eyebrow">{t("linkPicker.eyebrow")}</div>
              <div className="proxy-h1">{t("linkPicker.title")}</div>
            </div>
          </div>
          <button className="proxy-panel-close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="lp-tabs">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className={`lp-tab${tab === k ? " is-active" : ""}`}
              onClick={() => setTab(k)}
            >
              <span>{SOURCE_ICON[k]}</span> {SOURCE_LABEL[k]}
            </button>
          ))}
        </div>
        <label className="lp-search">
          <Search size={15} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("linkPicker.searchPh")}
          />
        </label>
        <div className="lp-list">
          {loading && <div className="lp-empty">{t("common.loading")}</div>}
          {!loading && shown.length === 0 && <div className="lp-empty">{t("common.nothingFound")}</div>}
          {shown.map((i) => (
            <button
              key={i.kind + i.ref}
              type="button"
              className="lp-item"
              onClick={() => onPick(i)}
            >
              <span className="lp-ico">{SOURCE_ICON[i.kind]}</span>
              <span className="lp-txt">
                <span className="lp-title">{i.title}</span>
                {i.preview && <span className="lp-sub">{i.preview.slice(0, 90)}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

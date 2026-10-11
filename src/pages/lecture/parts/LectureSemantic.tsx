import { useEffect, useState } from "react";
import { Search, FileText } from "lucide-react";
import { api } from "@/api/client";
import { useI18n } from "@/app/i18n";
import type { SemHit } from "@/api/apiSemantic";
import { openTarget } from "@/lib/deepLink";

interface Props {
  /** Открытая лекция: по её заголовку и конспекту подбираются заметки. */
  title: string;
  notes: string;
  onOpen: (id: number) => void;
}

const fmt = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Поиск по смыслу по всем расшифровкам + заметки, подходящие к открытой лекции. */
export default function LectureSemantic({ title, notes, onOpen }: Props) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SemHit[]>([]);
  const [related, setRelated] = useState<SemHit[]>([]);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 3) {
      setHits([]);
      return;
    }
    let live = true;
    const tm = setTimeout(() => {
      api
        .semSearch(text, ["lecture"], 10)
        .then((h) => live && setHits(h))
        .catch(() => live && setHits([]));
    }, 300);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [q]);

  useEffect(() => {
    const text = `${title}. ${notes.replace(/[#*|_`>-]/g, " ").slice(0, 700)}`;
    if (!title && notes.length < 40) {
      setRelated([]);
      return;
    }
    let live = true;
    api
      .semNotesFor(text, 4)
      .then((h) => live && setRelated(h))
      .catch(() => live && setRelated([]));
    return () => {
      live = false;
    };
  }, [title, notes]);

  return (
    <div style={{ padding: "6px 0" }}>
      <label className="lec-dim" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Search size={13} />
        <input
          className="text-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("sem.lectureSearchPh")}
          style={{ flex: 1 }}
        />
      </label>
      {hits.map((h) => (
        <div
          key={h.ref + (h.at ?? "")}
          className="lec-session-row"
          style={{ cursor: "pointer", flexDirection: "column", alignItems: "flex-start" }}
          onClick={() => onOpen(Number(h.ref))}
        >
          <span className="lec-session-title">
            {h.title} {h.at != null && <span className="lec-dim">· {fmt(h.at)}</span>}
          </span>
          <span className="lec-dim">{h.snippet.slice(0, 140)}</span>
        </div>
      ))}
      {related.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="lec-dim">
            <FileText size={12} /> {t("sem.lectureNotes")}
          </div>
          {related.map((h) => (
            <div
              key={h.ref}
              style={{ cursor: "pointer", fontSize: 12, padding: "3px 0", color: "var(--amber)" }}
              onClick={() => openTarget({ page: "myspace", view: "notes", ref: h.ref })}
            >
              {h.title} <span className="lec-dim">{Math.round(h.score * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, RefreshCw, Download } from "lucide-react";
import { api } from "@/api/client";
import type { SemCluster, SemDup, SemHit, SemStatus, SemSuggest } from "@/api/apiSemantic";

interface Props {
  /** Открытая заметка (путь в хранилище) или null. */
  note: string | null;
  /** Текущий текст заметки: по нему предлагаются ссылки и ищутся похожие. */
  content: string;
  onOpenNote: (path: string) => void;
  /** Вставить `[[имя]]` в заметку. */
  onInsertLink: (name: string) => void;
  /** Добавить тег в конец заметки. */
  onAddTag: (tag: string) => void;
}

const noteName = (p: string): string => p.replace(/^.*\//, "").replace(/\.\w+$/, "");

const box: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  padding: "8px 8px 3px",
};
const row: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  padding: "5px 8px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  borderBottom: "1px solid var(--glass-border)",
};
const pill: React.CSSProperties = {
  border: "1px solid var(--glass-border)",
  background: "var(--track)",
  color: "var(--text-primary)",
  borderRadius: 999,
  padding: "2px 9px",
  fontSize: 11,
  cursor: "pointer",
};

/** Правая панель «Похожее»: похожие заметки, подсказки ссылок, тегов и папки, дубли и темы. */
export function SemanticPanel({ note, content, onOpenNote, onInsertLink, onAddTag }: Props) {
  const [status, setStatus] = useState<SemStatus | null>(null);
  const [related, setRelated] = useState<SemHit[]>([]);
  const [links, setLinks] = useState<SemHit[]>([]);
  const [sug, setSug] = useState<SemSuggest | null>(null);
  const [dups, setDups] = useState<SemDup[] | null>(null);
  const [groups, setGroups] = useState<SemCluster[] | null>(null);
  const [err, setErr] = useState("");
  const [installing, setInstalling] = useState(false);
  const lastText = useRef("");

  const loadStatus = useCallback(() => {
    api
      .semStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 2000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const ready = !!status?.model && status.chunks > 0;

  // похожие и подсказки — при смене заметки и после (до)индексации
  useEffect(() => {
    if (!note || !ready) {
      setRelated([]);
      setSug(null);
      return;
    }
    let live = true;
    api
      .semRelated("note", note)
      .then((r) => live && setRelated(r))
      .catch(() => {});
    api
      .semSuggest(note)
      .then((r) => live && setSug(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [note, ready, status?.indexed.note]);

  // ссылки: по последнему абзацу, с паузой после набора
  useEffect(() => {
    if (!note || !ready) {
      setLinks([]);
      return;
    }
    const tail =
      content
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .pop() ?? "";
    if (tail.length < 25 || tail === lastText.current) return;
    const t = setTimeout(() => {
      lastText.current = tail;
      api
        .semLinks(tail.slice(-600), note)
        .then(setLinks)
        .catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [content, note, ready]);

  const install = async () => {
    setErr("");
    setInstalling(true);
    try {
      await api.llamaModelDownload({ id: "embeddinggemma2-q8" });
      // ждём окончания загрузки
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await api.llamaStatus();
        if (st.download?.status === "downloading") continue;
        if (st.download?.status === "error") throw new Error(st.download.error || "download");
        break;
      }
      await api.semSync();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setInstalling(false);
      loadStatus();
    }
  };

  const job = status?.job;
  const syncBtn = (
    <button
      type="button"
      onClick={() => void api.semSync().then(loadStatus)}
      disabled={!!job?.running}
      title="Обновить индекс"
      style={{ ...pill, display: "inline-flex", alignItems: "center", gap: 5 }}
    >
      <RefreshCw size={11} className={job?.running ? "spin" : undefined} />
      {job?.running ? `${job.done}/${job.total}` : "Обновить индекс"}
    </button>
  );

  if (status && !status.model) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
        <Sparkles size={16} style={{ color: "var(--amber)" }} />
        <p>
          Поиск по смыслу, похожие заметки и подсказки работают на модели EmbeddingGemma 2 (310 МБ,
          запускается на процессоре в встроенном llama.cpp).
        </p>
        <button
          type="button"
          onClick={() => void install()}
          disabled={installing}
          style={{
            ...pill,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 12px",
          }}
        >
          <Download size={12} /> {installing ? "Загрузка…" : "Установить модель"}
        </button>
        {err && <p style={{ color: "#e5484d" }}>{err}</p>}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "2px 4px 12px" }}>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          padding: "6px 8px",
          flexWrap: "wrap",
        }}
      >
        {syncBtn}
        {status && (
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            {status.indexed.note} заметок · {status.indexed.bookmark} закладок
          </span>
        )}
      </div>
      {job?.error && (
        <div style={{ padding: "0 8px", fontSize: 11, color: "#e5484d" }}>{job.error}</div>
      )}
      {status && status.chunks === 0 && !job?.running && (
        <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-tertiary)" }}>
          Индекс пуст — нажмите «Обновить индекс».
        </div>
      )}

      {note && ready && (
        <>
          <div style={box}>Похожие заметки</div>
          {related.length === 0 && (
            <div style={{ padding: "2px 8px", fontSize: 12, color: "var(--text-tertiary)" }}>
              Пока ничего близкого
            </div>
          )}
          {related.map((h) => (
            <div key={h.ref} style={row} onClick={() => onOpenNote(h.ref)}>
              <span style={{ fontWeight: 600, color: "var(--amber)" }}>
                {h.title || noteName(h.ref)}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.3 }}>
                {Math.round(h.score * 100)}% · {h.snippet.slice(0, 90)}
              </span>
            </div>
          ))}

          {links.length > 0 && (
            <>
              <div style={box}>Вставить ссылку</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "2px 8px" }}>
                {links.map((h) => (
                  <button
                    key={h.ref}
                    type="button"
                    style={pill}
                    title={h.snippet.slice(0, 120)}
                    onClick={() => onInsertLink(h.title || noteName(h.ref))}
                  >
                    [[{h.title || noteName(h.ref)}]]
                  </button>
                ))}
              </div>
            </>
          )}

          {sug && (sug.tags.length > 0 || sug.folder) && (
            <>
              <div style={box}>Теги и папка</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "2px 8px" }}>
                {sug.tags.map((t) => (
                  <button key={t} type="button" style={pill} onClick={() => onAddTag(t)}>
                    + {t}
                  </button>
                ))}
              </div>
              {sug.folder && note.includes("/") === false && (
                <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-tertiary)" }}>
                  Похожие заметки лежат в папке «{sug.folder}»
                </div>
              )}
            </>
          )}
        </>
      )}

      {ready && (
        <>
          <div style={box}>Дубли и темы</div>
          <div style={{ display: "flex", gap: 6, padding: "2px 8px", flexWrap: "wrap" }}>
            <button
              type="button"
              style={pill}
              onClick={() => void api.semDuplicates("note").then(setDups)}
            >
              Найти дубли
            </button>
            <button
              type="button"
              style={pill}
              onClick={() => void api.semClusters("note").then(setGroups)}
            >
              Группы по темам
            </button>
          </div>
          {dups && (
            <div style={{ padding: "4px 0" }}>
              {dups.length === 0 && (
                <div style={{ padding: "2px 8px", fontSize: 12, color: "var(--text-tertiary)" }}>
                  Дублей нет
                </div>
              )}
              {dups.map((d) => (
                <div key={d.a.ref + d.b.ref} style={row}>
                  <span style={{ color: "var(--amber)" }} onClick={() => onOpenNote(d.a.ref)}>
                    {d.a.title}
                  </span>
                  <span style={{ color: "var(--amber)" }} onClick={() => onOpenNote(d.b.ref)}>
                    {d.b.title}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                    совпадение {Math.round(d.score * 100)}%
                  </span>
                </div>
              ))}
            </div>
          )}
          {groups && (
            <div style={{ padding: "4px 0" }}>
              {groups.length === 0 && (
                <div style={{ padding: "2px 8px", fontSize: 12, color: "var(--text-tertiary)" }}>
                  Групп не нашлось
                </div>
              )}
              {groups.map((g, i) => (
                <div key={i} style={{ ...row, cursor: "default" }}>
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                    Тема {i + 1} · {g.refs.length}
                  </span>
                  {g.refs.map((r) => (
                    <span
                      key={r.ref}
                      style={{ color: "var(--amber)", cursor: "pointer" }}
                      onClick={() => onOpenNote(r.ref)}
                    >
                      {r.title}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

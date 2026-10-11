import { useState } from "react";
import {
  ListTree,
  Table2,
  Eraser,
  BookMarked,
  CalendarClock,
  FileSymlink,
  Map,
  Unlink,
  Quote,
  Presentation,
  History,
  Camera,
  Zap,
} from "lucide-react";
import RsvpReader from "@/pages/myspace/parts/RsvpReader";
import NoteExtrasPanel from "@/pages/myspace/parts/NoteExtrasPanel";
import MindPanel from "@/pages/myspace/parts/MindPanel";
import PhotoChecklistPanel from "@/pages/myspace/parts/PhotoChecklistPanel";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { saveBlob } from "@/lib/download";

/**
 * Инструменты открытой заметки: оглавление, формулы в таблицах, трансклюзия,
 * слова-паразиты, глоссарий, план повторений и карта содержания папки.
 * Операции над текстом применяются к заметке, остальное показывается списком.
 */
export default function NoteToolsPanel({
  path,
  content,
  onChange,
}: {
  path: string | null;
  content: string;
  onChange: (path: string, text: string) => void;
}) {
  const { t } = useI18n();
  const [out, setOut] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [snaps, setSnaps] = useState<{ id: string; at: number; reason: string }[]>([]);
  const [rsvp, setRsvp] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (!path) return <div className="muted-sm" style={{ padding: 10 }}>{t("myspace.tools.noNote")}</div>;

  const apply = (key: string, fn: () => Promise<{ text: string; extra?: string }>) =>
    run(async () => {
      const r = await fn();
      if (r.text !== content) onChange(path, r.text);
      setOut([t(key) + (r.extra ? `: ${r.extra}` : "")]);
    });

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, overflow: "auto" }}>
      <Btn icon={ListTree} onClick={() => void apply("myspace.tools.tocDone", async () => ({ text: (await api.noteToc(content)).text }))}>
        {t("myspace.tools.toc")}
      </Btn>
      <Btn
        icon={Table2}
        onClick={() =>
          void apply("myspace.tools.formulasDone", async () => {
            const r = await api.noteFormulas(content);
            return { text: r.text, extra: String(r.evaluated) };
          })
        }
      >
        {t("myspace.tools.formulas")}
      </Btn>
      <Btn
        icon={FileSymlink}
        onClick={() =>
          void apply("myspace.tools.transcludeDone", async () => ({
            text: (await api.noteTransclude(content)).text,
          }))
        }
      >
        {t("myspace.tools.transclude")}
      </Btn>
      <Btn
        icon={Eraser}
        onClick={() =>
          void run(async () => {
            const r = await api.noteParasites(content);
            setOut(
              r.total === 0
                ? [t("myspace.tools.parasitesNone")]
                : [t("myspace.tools.parasitesTotal", { n: r.total }), ...r.hits.map((h) => `${h.word} × ${h.count}`)],
            );
          })
        }
      >
        {t("myspace.tools.parasites")}
      </Btn>
      <Btn
        icon={BookMarked}
        onClick={() =>
          void run(async () => {
            const r = await api.noteGlossary(content);
            setOut(
              r.items.length
                ? r.items.map((i) => `${i.term} — ${i.definition}`)
                : [t("myspace.tools.glossaryNone")],
            );
          })
        }
      >
        {t("myspace.tools.glossary")}
      </Btn>
      <Btn
        icon={CalendarClock}
        onClick={() =>
          void run(async () => {
            const r = await api.notePlan();
            setOut([t("myspace.tools.planFrom", { date: r.date }), ...r.reviews]);
          })
        }
      >
        {t("myspace.tools.plan")}
      </Btn>
      <Btn
        icon={Map}
        onClick={() =>
          void run(async () => {
            const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
            const r = await api.noteMoc(folder);
            onChange(path, content.replace(/\s*$/, "\n\n") + r.text);
            setOut([t("myspace.tools.mocDone", { n: r.count })]);
          })
        }
      >
        {t("myspace.tools.moc")}
      </Btn>
      <Btn
        icon={Unlink}
        onClick={() =>
          void run(async () => {
            const r = await api.noteDebts();
            setOut(
              r.items.length
                ? r.items.slice(0, 30).map((d) => `[[${d.target}]] × ${d.count}`)
                : [t("myspace.tools.debtsNone")],
            );
          })
        }
      >
        {t("myspace.tools.debts")}
      </Btn>
      <Btn
        icon={Quote}
        onClick={() =>
          void run(async () => {
            const r = await api.noteQuotes();
            setOut(
              r.items.length
                ? r.items.slice(0, 30).map((q) => `«${q.text}» — ${q.source}`)
                : [t("myspace.tools.quotesNone")],
            );
          })
        }
      >
        {t("myspace.tools.quotes")}
      </Btn>
      <Btn
        icon={Presentation}
        onClick={() =>
          void run(async () => {
            const title = path.replace(/^.*\//, "").replace(/\.md$/i, "");
            const r = await api.noteSlides(content, title);
            saveBlob(new Blob([r.html], { type: "text/html;charset=utf-8" }), `${title}.html`);
            setOut([t("myspace.tools.slidesDone")]);
          })
        }
      >
        {t("myspace.tools.slides")}
      </Btn>
      <div style={{ display: "flex", gap: 6 }}>
        <Btn
          icon={Camera}
          onClick={() =>
            void run(async () => {
              await api.noteSnapshotCreate(path, content);
              setSnaps((await api.noteSnapshots(path)).items);
              setOut([t("myspace.tools.snapshotDone")]);
            })
          }
        >
          {t("myspace.tools.snapshot")}
        </Btn>
        <Btn
          icon={History}
          onClick={() => void run(async () => setSnaps((await api.noteSnapshots(path)).items))}
        >
          {t("myspace.tools.history")}
        </Btn>
      </div>
      {snaps.map((s) => (
        <div key={s.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <span style={{ flex: 1 }}>
            {new Date(s.at).toLocaleString()} · {s.reason}
          </span>
          <Btn
            variant="ghost"
            onClick={() =>
              void run(async () => {
                const r = await api.noteSnapshotRead(path, s.id);
                onChange(path, r.text);
                setOut([t("myspace.tools.restored")]);
              })
            }
          >
            {t("myspace.tools.restore")}
          </Btn>
        </div>
      ))}
      <Btn icon={Zap} onClick={() => setRsvp((v) => !v)}>
        {t("myspace.tools.rsvp")}
      </Btn>
      {rsvp && <RsvpReader text={content} />}
      <NoteExtrasPanel path={path} content={content} onChange={onChange} />
      <MindPanel path={path} content={content} onChange={onChange} />
      <PhotoChecklistPanel />
      {err && <div style={{ color: "var(--danger, #e66)", fontSize: 12 }}>{err}</div>}
      {out.map((l, i) => (
        <div key={i} className="muted-sm">
          {l}
        </div>
      ))}
    </div>
  );
}

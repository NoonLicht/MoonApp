import { useEffect, useRef, useState } from "react";
import { Tags, FilePlus2, GitCompare, Mic, Square, Globe } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { VaultFile } from "@/api/types";
import { saveBlob } from "@/lib/download";

type Compare = Awaited<ReturnType<typeof api.noteCompare>>;

function flatNotes(items: VaultFile[], out: string[] = []): string[] {
  for (const it of items) {
    if (it.type === "folder") flatNotes(it.children ?? [], out);
    else if (it.type === "note") out.push(it.path);
  }
  return out;
}

/**
 * Теги по смыслу, шаблоны новых заметок и сравнение двух конспектов.
 * Теги и шаблон дописываются в открытую заметку; сравнение показывается списком.
 */
export default function NoteExtrasPanel({
  path,
  content,
  onChange,
}: {
  path: string;
  content: string;
  onChange: (path: string, text: string) => void;
}) {
  const { t } = useI18n();
  const [tags, setTags] = useState<{ tag: string; score: number }[] | null>(null);
  const [templates, setTemplates] = useState<{ id: string; title: string }[]>([]);
  const [tplId, setTplId] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [cmp, setCmp] = useState<Compare | null>(null);
  const [err, setErr] = useState("");
  const [rec, setRec] = useState<"idle" | "recording" | "working">("idle");
  const recorder = useRef<MediaRecorder | null>(null);
  // актуальный текст заметки к моменту окончания распознавания
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(
    () => () => {
      recorder.current?.stream.getTracks().forEach((tr) => tr.stop());
    },
    [],
  );

  const toggleDictation = async () => {
    if (rec === "recording") {
      recorder.current?.stop();
      return;
    }
    if (rec === "working") return;
    setErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const parts: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && parts.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        setRec("working");
        void api
          .quickNotesTranscribe(new Blob(parts, { type: mr.mimeType || "audio/webm" }))
          .then((r) => {
            const text = (r.text || "").trim();
            if (!text) return;
            const base = contentRef.current.replace(/\s*$/, "");
            onChange(path, (base ? base + "\n\n" : "") + text + "\n");
          })
          .catch((e) => setErr((e as Error).message))
          .finally(() => setRec("idle"));
      };
      recorder.current = mr;
      mr.start();
      setRec("recording");
    } catch (e) {
      setErr((e as Error).message);
      setRec("idle");
    }
  };

  useEffect(() => {
    let alive = true;
    void api
      .noteTemplates()
      .then((r) => {
        if (!alive) return;
        setTemplates(r.items);
        setTplId((cur) => cur || r.items[0]?.id || "");
      })
      .catch(() => undefined);
    void api
      .myspaceTree()
      .then((r) => {
        if (alive) setNotes(flatNotes(r));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const title = path.replace(/^.*\//, "").replace(/\.md$/i, "");
  const existing = new Set(
    (content.match(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu) ?? []).map((m) => m.trim().slice(1)),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Btn
        icon={rec === "recording" ? Square : Mic}
        disabled={rec === "working"}
        onClick={() => void toggleDictation()}
      >
        {rec === "recording"
          ? t("myspace.tools.dictateStop")
          : rec === "working"
            ? t("myspace.tools.dictating")
            : t("myspace.tools.dictate")}
      </Btn>
      <Btn
        icon={Tags}
        onClick={() =>
          void run(async () => setTags((await api.noteTags(content, path, [...existing])).items))
        }
      >
        {t("myspace.tools.tags")}
      </Btn>
      {tags && tags.length === 0 && <div className="muted-sm">{t("myspace.tools.tagsNone")}</div>}
      {tags && tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {tags.map((x) => (
            <Btn
              key={x.tag}
              variant="ghost"
              onClick={() => {
                onChange(path, content.replace(/\s*$/, "") + ` #${x.tag}\n`);
                setTags(tags.filter((y) => y.tag !== x.tag));
              }}
            >
              #{x.tag}
            </Btn>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        <select
          className="input"
          style={{ flex: 1 }}
          value={tplId}
          onChange={(e) => setTplId(e.target.value)}
          aria-label={t("myspace.tools.template")}
        >
          {templates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
        <Btn
          icon={FilePlus2}
          disabled={!tplId}
          onClick={() =>
            void run(async () => {
              const r = await api.noteTemplate(tplId, title);
              onChange(path, content.trim() ? content.replace(/\s*$/, "\n\n") + r.text : r.text);
            })
          }
        >
          {t("myspace.tools.templateInsert")}
        </Btn>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <select
          className="input"
          style={{ flex: 1 }}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          aria-label={t("myspace.tools.compareWith")}
        >
          <option value="">{t("myspace.tools.compareWith")}</option>
          {notes
            .filter((p) => p !== path)
            .map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
        </select>
        <Btn
          icon={GitCompare}
          disabled={!other}
          onClick={() =>
            void run(async () => {
              const o = await api.myspaceRead(other);
              setCmp(await api.noteCompare(content, o.content));
            })
          }
        >
          {t("myspace.tools.compare")}
        </Btn>
      </div>
      {cmp && (
        <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="muted-sm">
            {t("myspace.tools.compareSummary", {
              pct: Math.round(cmp.similarity * 100),
              a: cmp.onlyA.length,
              b: cmp.onlyB.length,
            })}
          </div>
          {cmp.onlyA.slice(0, 20).map((s, i) => (
            <div key={`a${i}`}>− {s}</div>
          ))}
          {cmp.onlyB.slice(0, 20).map((s, i) => (
            <div key={`b${i}`}>+ {s}</div>
          ))}
        </div>
      )}
      <Btn
        icon={Globe}
        onClick={() =>
          void run(async () => {
            const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
            saveBlob(await api.noteSite(folder, ""), "mini-site.zip");
          })
        }
      >
        {t("myspace.tools.site")}
      </Btn>
      {err && <div style={{ color: "var(--danger, #e66)", fontSize: 12 }}>{err}</div>}
    </div>
  );
}

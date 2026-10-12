import { useState } from "react";
import { Paperclip } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Kind = "file" | "folder" | "site";

/**
 * Прикрепление материалов к чату: файл, папка или сайт. Из них по вопросу
 * выбираются самые близкие отрывки, и блок контекста дописывается к системному
 * промпту — его видно и можно отредактировать или удалить.
 */
export default function ChatContextAttach({ onAttach }: { onAttach: (block: string) => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<Kind>("file");
  const [target, setTarget] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const attach = async () => {
    if (!target.trim() || busy) return;
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const r = await api.chatContext(kind, target.trim(), question.trim());
      if (!r.context) setMsg(t("aichat.ctx.nothing"));
      else {
        onAttach(r.context);
        setMsg(t("aichat.ctx.attached", { n: r.sources.length }));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      <div className="muted-sm">
        <Paperclip size={11} /> {t("aichat.ctx.title")}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <select
          className="text-input"
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          aria-label={t("aichat.ctx.kind")}
        >
          <option value="file">{t("aichat.ctx.file")}</option>
          <option value="folder">{t("aichat.ctx.folder")}</option>
          <option value="site">{t("aichat.ctx.site")}</option>
        </select>
        <input
          className="text-input"
          style={{ flex: 1 }}
          value={target}
          placeholder={t(`aichat.ctx.ph.${kind}`)}
          onChange={(e) => setTarget(e.target.value)}
        />
      </div>
      <input
        className="text-input"
        value={question}
        placeholder={t("aichat.ctx.question")}
        onChange={(e) => setQuestion(e.target.value)}
      />
      <button onClick={() => void attach()} disabled={busy || !target.trim()}>
        {busy ? t("aichat.ctx.loading") : t("aichat.ctx.attach")}
      </button>
      {msg && <div className="muted-sm">{msg}</div>}
      {err && <div style={{ color: "var(--danger, #e66)", fontSize: 12 }}>{err}</div>}
    </div>
  );
}

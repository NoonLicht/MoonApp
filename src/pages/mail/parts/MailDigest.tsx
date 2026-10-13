import { useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { Btn, Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

/** Сводка входящих за день или неделю: ИИ группирует письма по темам и отмечает важное. */
export function MailDigest({
  account,
  lang,
  onClose,
}: {
  account: string;
  lang: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [period, setPeriod] = useState<"day" | "week">("day");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [count, setCount] = useState(0);
  const [err, setErr] = useState("");

  const run = async (p: "day" | "week") => {
    setPeriod(p);
    setBusy(true);
    setErr("");
    setText("");
    try {
      const r = await api.mailAi({
        action: "digest",
        period: p,
        lang,
        ...(account !== "all" ? { account } : {}),
      });
      setCount(Number(r.list?.[0] ?? 0));
      if (!r.text) setErr(t("mail.digestEmpty"));
      else setText(r.text);
    } catch (e) {
      const m = (e as Error).message;
      setErr(m.includes("ai_disabled") ? t("mail.aiDisabled") : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <Glass
        className="modal-panel mail-digest"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="mail-modal-head">
          <div className="media-title">{t("mail.digestTitle")}</div>
          <button className="mail-x" onClick={onClose} aria-label="close">
            <X size={16} />
          </button>
        </div>
        <div className="mail-row-gap">
          <Btn
            variant={period === "day" && (text || busy) ? "primary" : undefined}
            icon={busy && period === "day" ? Loader2 : Sparkles}
            disabled={busy}
            onClick={() => void run("day")}
          >
            {t("mail.digestDay")}
          </Btn>
          <Btn
            variant={period === "week" && (text || busy) ? "primary" : undefined}
            icon={busy && period === "week" ? Loader2 : Sparkles}
            disabled={busy}
            onClick={() => void run("week")}
          >
            {t("mail.digestWeek")}
          </Btn>
        </div>
        {!text && !busy && !err && <div className="mail-hint">{t("mail.digestHint")}</div>}
        {count > 0 && text && (
          <div className="mail-hint">{t("mail.digestCount", { n: count })}</div>
        )}
        {err && <div className="mail-err">{err}</div>}
        {text && <div className="mail-digest-body">{text}</div>}
      </Glass>
    </div>
  );
}

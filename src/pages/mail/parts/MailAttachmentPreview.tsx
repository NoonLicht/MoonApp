import { useEffect, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { Btn, Glass } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { MailAttachment } from "@/api/apiMail";
import { fmtSize } from "@/pages/mail/parts/mailUtil";

type Kind = "image" | "pdf" | "text" | "video" | "audio" | "none";

function kindOf(a: MailAttachment): Kind {
  const t = a.contentType.toLowerCase();
  const n = a.filename.toLowerCase();
  if (t.startsWith("image/") && !t.includes("svg")) return "image";
  if (t === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("text/") || /\.(txt|md|csv|log|json|xml|ics|html?)$/.test(n)) return "text";
  return "none";
}

export function canPreview(a: MailAttachment): boolean {
  return kindOf(a) !== "none";
}

/** Окно просмотра вложения: картинки, PDF, текст, аудио и видео без сохранения на диск. */
export function MailAttachmentPreview({
  messageId,
  att,
  onClose,
}: {
  messageId: string;
  att: MailAttachment;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const kind = kindOf(att);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let revoked = "";
    let live = true;
    api
      .mailAttachmentBlob(messageId, att.index)
      .then(async (r) => {
        if (!live) return URL.revokeObjectURL(r.url);
        revoked = r.url;
        if (kind === "text") {
          const res = await fetch(r.url);
          setText((await res.text()).slice(0, 200_000));
        }
        setUrl(r.url);
      })
      .catch((e: Error) => setErr(e.message));
    return () => {
      live = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [messageId, att.index, kind]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <Glass
        className="modal-panel mail-preview"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="mail-modal-head">
          <div className="media-title">
            {att.filename} <em className="mail-dim">{fmtSize(att.size)}</em>
          </div>
          <div className="mail-row-gap">
            <Btn
              icon={Download}
              onClick={() => void api.mailDownloadAttachment(messageId, att.index)}
            >
              {t("mail.download")}
            </Btn>
            <button className="mail-x" onClick={onClose} aria-label="close">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="mail-preview-body">
          {err ? (
            <div className="mail-err">{err}</div>
          ) : !url ? (
            <Loader2 className="spin" />
          ) : kind === "image" ? (
            <img src={url} alt={att.filename} />
          ) : kind === "pdf" ? (
            <object data={url} type="application/pdf" aria-label={att.filename}>
              <a href={url} download={att.filename}>
                {t("mail.download")}
              </a>
            </object>
          ) : kind === "video" ? (
            <video src={url} controls />
          ) : kind === "audio" ? (
            <audio src={url} controls />
          ) : (
            <pre>{text}</pre>
          )}
        </div>
      </Glass>
    </div>
  );
}

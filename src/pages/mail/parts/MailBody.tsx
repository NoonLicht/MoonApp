import { useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { escapeHtml, prepareHtml } from "@/pages/mail/parts/mailUtil";

/**
 * Тело письма в изолированном iframe: очищенный HTML, CSP без скриптов,
 * удалённые картинки блокируются до явного разрешения.
 */
export function MailBody({ html, text }: { html: string; text: string }) {
  const { t } = useI18n();
  const [allow, setAllow] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const { doc, blocked } = useMemo(() => {
    const src = html || `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(text)}</pre>`;
    const p = prepareHtml(src, allow);
    const csp = `default-src 'none'; img-src data: ${allow ? "https: http:" : ""}; style-src 'unsafe-inline'`;
    return {
      blocked: p.blocked,
      doc: `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank"><style>
html,body{margin:0}
body{padding:14px 16px;font:14px/1.55 system-ui,"Segoe UI",sans-serif;color:#1c1c1e;background:#fff;word-wrap:break-word;overflow-wrap:anywhere}
img{max-width:100%;height:auto}img[data-blocked]{display:none}
a{color:#0b57d0}blockquote{margin:8px 0;padding:0 0 0 12px;border-left:3px solid #d0d4da;color:#555}
table{max-width:100%}pre{white-space:pre-wrap}
</style></head><body>${p.html}</body></html>`,
    };
  }, [html, text, allow]);

  const fit = () => {
    const d = frame.current?.contentDocument;
    if (!d) return;
    setHeight(Math.max(60, d.documentElement.scrollHeight + 2));
    d.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const href = a.getAttribute("href") || "";
        if (!/^(https?:|mailto:)/i.test(href)) return;
        if (window.appBridge?.openExternal) void window.appBridge.openExternal(href);
        else window.open(href, "_blank", "noopener");
      });
    });
  };

  return (
    <div className="mail-body">
      {blocked > 0 && !allow && (
        <button className="mail-img-banner" onClick={() => setAllow(true)}>
          <ImageOff size={14} />
          <span>{t("mail.imagesBlocked")}</span>
          <b>{t("mail.showImages")}</b>
        </button>
      )}
      <iframe
        ref={frame}
        title="mail"
        sandbox="allow-same-origin allow-popups"
        srcDoc={doc}
        onLoad={fit}
        style={{ height }}
      />
    </div>
  );
}

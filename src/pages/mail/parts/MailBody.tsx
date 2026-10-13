import { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import { escapeHtml, prepareHtml } from "@/pages/mail/parts/mailUtil";

/**
 * Тело письма в изолированном iframe: очищенный HTML, CSP без скриптов,
 * удалённые картинки блокируются до явного разрешения. Тёмная тема письма — инверсия
 * светлого шаблона с возвратом цветов картинкам.
 */
export function MailBody({
  html,
  text,
  dark,
  fontSize,
  autoLoad,
}: {
  html: string;
  text: string;
  dark: boolean;
  fontSize: number;
  /** Показывать удалённые картинки сразу, без кнопки. */
  autoLoad?: boolean;
}) {
  const { t } = useI18n();
  const [allow, setAllow] = useState(!!autoLoad);
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const src = html || `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(text)}</pre>`;

  // адреса картинок письма: загружаем через сервер и подставляем blob-адреса
  const remote = useMemo(() => (allow ? prepareHtml(src, true).remote : []), [allow, src]);
  useEffect(() => {
    let alive = true;
    const todo = remote.filter((u) => !(u in resolved));
    if (!todo.length) return;
    void Promise.all(todo.map(async (u) => [u, await api.mailRemoteImage(u)] as const)).then(
      (pairs) => {
        if (!alive) return;
        setResolved((prev) => {
          const next = { ...prev };
          for (const [u, b] of pairs)
            if (b) next[u] = b;
            else next[u] = "";
          return next;
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [remote, resolved]);

  const { doc, blocked } = useMemo(() => {
    const p = prepareHtml(src, allow, resolved);
    const csp = `default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'`;
    const darkCss = dark
      ? `html{filter:invert(1) hue-rotate(180deg);background:#fff}img,video,picture{filter:invert(1) hue-rotate(180deg)}`
      : "";
    return {
      blocked: p.blocked,
      doc: `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank"><style>
html,body{margin:0}
body{padding:14px 16px;font:${fontSize}px/1.55 system-ui,"Segoe UI",sans-serif;color:#1c1c1e;background:#fff;word-wrap:break-word;overflow-wrap:anywhere}
img{max-width:100%;height:auto}img[data-blocked]{display:none}
a{color:#0b57d0}blockquote{margin:8px 0;padding:0 0 0 12px;border-left:3px solid #d0d4da;color:#555}
table{max-width:100%}pre{white-space:pre-wrap}
${darkCss}
</style></head><body>${p.html}</body></html>`,
    };
  }, [src, allow, dark, fontSize, resolved]);

  const fit = () => {
    const d = frame.current?.contentDocument;
    if (!d) return;
    const measure = () => setHeight(Math.max(60, d.documentElement.scrollHeight + 2));
    measure();
    // картинки догружаются после onLoad и меняют высоту письма
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(measure).observe(d.body);
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

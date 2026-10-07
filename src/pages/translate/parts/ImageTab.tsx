import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, Download, Eye, ImageIcon, Languages, Square } from "lucide-react";
import { Glass, Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { TrBlock, TrStatus } from "@/api/client";
import LangSelect from "@/pages/translate/parts/LangSelect";
import JobStatus from "@/pages/translate/parts/JobStatus";
import { memo, useJob } from "@/pages/translate/parts/useTranslate";
import type { TrSettings } from "@/pages/translate/parts/useTranslate";

/** Средний цвет вокруг рамки — им закрашиваем исходный текст. */
function backdrop(
  ctx: CanvasRenderingContext2D,
  b: TrBlock,
  w: number,
  h: number,
): [number, number, number] {
  const pts: [number, number][] = [
    [b.x - 3, b.y - 3],
    [b.x + b.w + 3, b.y - 3],
    [b.x - 3, b.y + b.h + 3],
    [b.x + b.w + 3, b.y + b.h + 3],
    [b.x + b.w / 2, b.y - 3],
    [b.x + b.w / 2, b.y + b.h + 3],
  ];
  let r = 0;
  let g = 0;
  let bl = 0;
  let n = 0;
  for (const [px, py] of pts) {
    const x = Math.min(w - 1, Math.max(0, Math.round(px)));
    const y = Math.min(h - 1, Math.max(0, Math.round(py)));
    const d = ctx.getImageData(x, y, 1, 1).data;
    r += d[0];
    g += d[1];
    bl += d[2];
    n++;
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const spaced = /\s/.test(text);
  const tokens = spaced ? text.split(/\s+/) : [...text];
  const lines: string[] = [];
  let cur = "";
  for (const tk of tokens) {
    const probe = cur ? (spaced ? `${cur} ${tk}` : cur + tk) : tk;
    if (cur && ctx.measureText(probe).width > maxW) {
      lines.push(cur);
      cur = tk;
    } else cur = probe;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Рисует перевод поверх изображения: подбирает размер шрифта, чтобы текст влез в рамку. */
function paint(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  blocks: TrBlock[],
  original: boolean,
): void {
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(img, 0, 0);
  if (original) return;
  // Цвета фона снимаем с неизменённой картинки, до закраски соседних блоков.
  const fills = blocks.map((b) => backdrop(ctx, b, canvas.width, canvas.height));
  blocks.forEach((b, i) => {
    const [r, g, bl] = fills[i];
    const pad = 3;
    ctx.fillStyle = `rgb(${r},${g},${bl})`;
    ctx.fillRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
    ctx.fillStyle = lum > 140 ? "#111" : "#f5f5f5";
    ctx.textBaseline = "top";
    let size = Math.max(8, Math.min(b.lineH * 1.05, b.h));
    let lines: string[] = [];
    for (; size >= 8; size -= 1) {
      ctx.font = `${size}px "Segoe UI", system-ui, sans-serif`;
      lines = wrap(ctx, b.dst, b.w + pad);
      if (lines.length * size * 1.18 <= b.h + pad * 2) break;
    }
    lines.forEach((ln, k) => ctx.fillText(ln, b.x, b.y + k * size * 1.18));
  });
}

/** Картинке из буфера нужно имя и расширение: сервер определяет формат по ним. */
function named(blob: Blob): File {
  if (blob instanceof File && blob.name) return blob;
  const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return new File([blob], `pasted-${Date.now()}.${ext}`, { type: blob.type });
}

/**
 * Перевод текста на изображении: Tesseract находит абзацы с рамками, TranslateGemma
 * переводит каждый, а перевод рисуется поверх картинки. Работает со скриншотами,
 * плакатами, схемами; для рукописного или очень стилизованного текста OCR слаб.
 */
export default function ImageTab({
  status,
  settings,
  set,
  ready,
  notify,
}: {
  status: TrStatus;
  settings: TrSettings;
  set: (p: Partial<TrSettings>) => void;
  ready: boolean;
  notify: (text: string, ok?: boolean) => void;
}) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(memo.image);
  const [url, setUrl] = useState(() => (memo.image ? URL.createObjectURL(memo.image) : ""));
  const [original, setOriginal] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const { job, running, start, cancel, error } = useJob("image");

  const ocrOk = settings.src === "auto" || status.ocrLanguages.includes(settings.src);

  const pick = (f: File | undefined): void => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      notify(t("translate.notImage"), false);
      return;
    }
    memo.image = f;
    setFile(f);
    setUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(f);
    });
  };
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  // Вставка из буфера (Ctrl+V). Вкладки страницы остаются в DOM скрытыми, поэтому реагируем
  // только когда эта вкладка видна, и не мешаем вставке текста в поля ввода.
  const root = useRef<HTMLDivElement>(null);
  const pickRef = useRef(pick);
  useEffect(() => {
    pickRef.current = pick;
  });
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (!root.current || root.current.offsetParent === null) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
        return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/"),
      );
      const blob = item?.getAsFile();
      if (!blob) return;
      e.preventDefault();
      pickRef.current(named(blob));
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  /** Кнопка «Вставить»: читает картинку из буфера через Clipboard API (нужно разрешение браузера). */
  const pasteBtn = async (): Promise<void> => {
    try {
      for (const it of await navigator.clipboard.read()) {
        const type = it.types.find((x) => x.startsWith("image/"));
        if (type) {
          pick(named(await it.getType(type)));
          return;
        }
      }
      notify(t("translate.pasteEmpty"), false);
    } catch {
      notify(t("translate.pasteDenied"), false);
    }
  };

  const blocks = job?.blocks;
  useEffect(() => {
    if (!url) return;
    const el = new Image();
    el.onload = () => {
      img.current = el;
      if (canvas.current) paint(canvas.current, el, blocks ?? [], original || !blocks?.length);
    };
    el.src = url;
  }, [url, blocks, original]);

  const save = (): void => {
    canvas.current?.toBlob((b) => {
      if (!b) return;
      const u = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = u;
      a.download = `${(file?.name || "image").replace(/\.[^.]+$/, "")}.${settings.tgt}.png`;
      a.click();
      URL.revokeObjectURL(u);
    }, "image/png");
  };

  return (
    <Glass style={{ padding: 14 }}>
      <div className="tr-langs" ref={root}>
        <LangSelect
          value={settings.src}
          onChange={(src) => set({ src })}
          codes={status.languages}
          auto
        />
        <span className="muted-sm">→</span>
        <LangSelect
          value={settings.tgt}
          onChange={(tgt) => set({ tgt })}
          codes={status.languages}
        />
        <div style={{ flex: 1 }} />
        <Btn icon={ClipboardPaste} onClick={() => void pasteBtn()}>
          {t("translate.pasteImage")}
        </Btn>
        <Btn icon={ImageIcon} onClick={() => input.current?.click()}>
          {t("translate.pickImage")}
        </Btn>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => pick(e.target.files?.[0])}
        />
        {running ? (
          <Btn icon={Square} onClick={cancel}>
            {t("translate.cancel")}
          </Btn>
        ) : (
          <Btn
            variant="primary"
            icon={Languages}
            disabled={!ready || !file || !ocrOk}
            onClick={() =>
              file &&
              void start(() =>
                api.trFile(
                  file,
                  {
                    src: settings.src,
                    tgt: settings.tgt,
                    provider: settings.provider,
                    variant: settings.variant,
                  },
                  "image",
                ),
              )
            }
          >
            {t("translate.run")}
          </Btn>
        )}
      </div>
      {!ocrOk && <div className="muted-sm">{t("translate.ocrUnsupported")}</div>}
      <div className="muted-sm" style={{ marginTop: 6 }}>
        {settings.src === "auto" ? t("translate.imageAutoHint") : t("translate.imageHint")}
      </div>
      {url ? (
        <div className="tr-canvas-wrap">
          <canvas ref={canvas} className="tr-canvas" />
        </div>
      ) : (
        <div className="tr-drop" onClick={() => input.current?.click()} role="button" tabIndex={0}>
          <ImageIcon size={22} />
          <div>{t("translate.dropImage")}</div>
        </div>
      )}
      {job && <JobStatus job={job} />}
      {job?.status === "done" && (
        <>
          <div className="tr-foot">
            <span className="muted-sm">{t("translate.blocks", { n: job.blocks.length })}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn icon={Eye} onClick={() => setOriginal((v) => !v)}>
                {original ? t("translate.showTranslation") : t("translate.showOriginal")}
              </Btn>
              <Btn variant="primary" icon={Download} onClick={save}>
                {t("translate.savePng")}
              </Btn>
            </div>
          </div>
          <div className="tn-list">
            {job.blocks.map((b, i) => (
              <div key={i} className="tn-row">
                <div className="tn-row-main">
                  <div className="muted-sm">{b.text}</div>
                  <div className="tn-row-title">{b.dst}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {error && <div className="tn-msg bad">{error}</div>}
    </Glass>
  );
}

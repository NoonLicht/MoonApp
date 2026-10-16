import { useEffect, useRef, useState } from "react";
import { Download, FilePlus2, FolderOpen, Search, X } from "lucide-react";
import { Glass, Btn, Select, EmptyHint } from "@/components/ui";
import { SectionHead } from "@/components/ui";
import { usePageBusy } from "@/components/Toolbar";
import { useI18n } from "@/app/i18n";
import { useWordDocs } from "@/pages/word/useWordDocs";
import Ribbon from "@/pages/word/parts/Ribbon";
import PageCanvas from "@/pages/word/parts/PageCanvas";

const TEMPLATES = ["blank", "letter", "resume", "report", "sample"] as const;
const FORMATS = ["docx", "pdf", "odt", "rtf", "html", "md", "txt"] as const;
const OPEN_ACCEPT = ".docx,.doc,.odt,.rtf,.html,.htm,.md,.txt,.tex,.dotx,.docm";

/** Файл → base64 без префикса data:. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * «Документы»: текстовый редактор. Движок документа — ядро WordCraft (сайдкар), интерфейс — наш:
 * лента, страницы с кареткой и выделением, вкладки открытых документов, поиск и замена.
 */
export default function WordPage() {
  const { t } = useI18n();
  const docs = useWordDocs();
  const { active, status } = docs;
  const [zoom, setZoom] = useState(1);
  const [focused, setFocused] = useState(false);
  const [template, setTemplate] = useState<string>("blank");
  const [format, setFormat] = useState<string>("docx");
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const openRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  usePageBusy(docs.busy);

  // Масштаб колёсиком с Ctrl, как в офисных редакторах.
  const area = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(2.5, Math.max(0.4, +(z + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(2))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [active?.id]);

  if (status && !status.available) {
    return (
      <div className="page wd-page-root">
        <SectionHead eyebrow={t("word.eyebrow")} title={t("word.title")} />
        <Glass className="wd-missing">
          <b>{t("word.coreMissing")}</b>
          <span className="muted-sm">{t("word.coreMissingHint")}</span>
          <code>npm run build:wordcore</code>
          {status.searched.length > 0 && <pre className="ph-log">{status.searched.join("\n")}</pre>}
        </Glass>
      </div>
    );
  }

  return (
    <div className="page wd-page-root">
      <SectionHead eyebrow={t("word.eyebrow")} title={t("word.title")} />

      <div className="wd-files">
        <Select
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          options={TEMPLATES.map((k) => ({ value: k, label: t(`word.template.${k}`) }))}
        />
        <Btn
          variant="primary"
          icon={FilePlus2}
          disabled={docs.busy}
          onClick={() => void docs.create(template, t(`word.template.${template}`))}
        >
          {t("word.new")}
        </Btn>
        <Btn icon={FolderOpen} disabled={docs.busy} onClick={() => openRef.current?.click()}>
          {t("word.open")}
        </Btn>
        <input
          ref={openRef}
          type="file"
          hidden
          accept={OPEN_ACCEPT}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void docs.openFile(f);
            e.target.value = "";
          }}
        />
        <input
          ref={imgRef}
          type="file"
          hidden
          accept="image/*"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f)
              void docs.run("insert.picture", { data: await toBase64(f), width: 300, alt: f.name });
          }}
        />
        <span className="wd-grow" />
        {active && (
          <>
            <Select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              options={FORMATS.map((k) => ({ value: k, label: k.toUpperCase() }))}
            />
            <Btn icon={Download} disabled={docs.busy} onClick={() => void docs.exportAs(format)}>
              {t("word.save")}
            </Btn>
          </>
        )}
      </div>

      {docs.docs.length > 0 && (
        <div className="wd-doctabs">
          {docs.docs.map((d) => (
            <div key={d.id} className={`wd-doctab${d.id === docs.activeId ? " active" : ""}`}>
              <button type="button" onClick={() => docs.setActiveId(d.id)}>
                {d.name}
                {d.state.dirty ? " •" : ""}
              </button>
              <button
                type="button"
                className="wd-x-btn"
                aria-label={t("word.close")}
                title={t("word.close")}
                onClick={() => void docs.close(d.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {docs.error && (
        <div className="ph-error wd-error" role="alert">
          {docs.error}
          <button
            type="button"
            className="wd-x-btn"
            aria-label={t("word.close")}
            onClick={() => docs.setError("")}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {!active ? (
        <Glass className="wd-empty">
          <EmptyHint icon={FilePlus2} text={t("word.emptyHint")} />
        </Glass>
      ) : (
        <>
          <Ribbon
            docs={docs}
            state={active.state}
            zoom={zoom}
            setZoom={setZoom}
            onFind={() => setFindOpen((v) => !v)}
            onPickImage={() => imgRef.current?.click()}
          />
          {findOpen && (
            <div className="wd-find">
              <Search size={14} />
              <input
                value={findText}
                placeholder={t("word.find")}
                onChange={(e) => setFindText(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" &&
                  findText &&
                  void docs.run("edit.findNext", { text: findText })
                }
              />
              <input
                value={replaceText}
                placeholder={t("word.replaceWith")}
                onChange={(e) => setReplaceText(e.target.value)}
              />
              <Btn
                disabled={!findText}
                onClick={() => void docs.run("edit.findNext", { text: findText })}
              >
                {t("word.findNext")}
              </Btn>
              <Btn
                disabled={!findText}
                onClick={() =>
                  void docs.run("edit.replaceAll", { text: findText, with: replaceText })
                }
              >
                {t("word.replaceAll")}
              </Btn>
            </div>
          )}
          <div className="wd-area" ref={area}>
            <PageCanvas
              docs={docs}
              docId={active.id}
              state={active.state}
              zoom={zoom}
              focused={focused}
              onFocusChange={setFocused}
            />
          </div>
          <div className="wd-status">
            <span>
              {t("word.words", { n: active.state.words })} ·{" "}
              {t("word.pages", { n: active.state.pages.length })}
            </span>
            <span className="wd-grow" />
            <span>{Math.round(zoom * 100)}%</span>
          </div>
        </>
      )}
    </div>
  );
}

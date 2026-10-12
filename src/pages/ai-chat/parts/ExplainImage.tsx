import { useRef, useState } from "react";
import { ScanText, Sigma } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Mode = "explain" | "formulas";
type Result = Awaited<ReturnType<typeof api.chatExplainImage>>;

/**
 * Объяснение скриншота, слайда или доски: текст с картинки распознаётся (OCR) и
 * разбирается текстовой моделью; режим «формулы» выдаёт формулы в LaTeX.
 * Картинку можно выбрать файлом или вставить из буфера (Ctrl+V в поле).
 */
export default function ExplainImage({ onUse }: { onUse: (text: string) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("explain");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (file: File | Blob) => {
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      setRes(await api.chatExplainImage(file, mode, question.trim()));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      <div className="muted-sm">
        <ScanText size={11} /> {t("aichat.explain.title")}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <select
          className="text-input"
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
          aria-label={t("aichat.explain.mode")}
        >
          <option value="explain">{t("aichat.explain.modeExplain")}</option>
          <option value="formulas">{t("aichat.explain.modeFormulas")}</option>
        </select>
        <input
          className="text-input"
          style={{ flex: 1 }}
          placeholder={t("aichat.explain.paste")}
          value={question}
          disabled={mode === "formulas"}
          onChange={(e) => setQuestion(e.target.value)}
          onPaste={(e) => {
            const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/"));
            if (f) {
              e.preventDefault();
              void run(f);
            }
          }}
        />
      </div>
      <button onClick={() => fileRef.current?.click()} disabled={busy}>
        {mode === "formulas" ? <Sigma size={12} /> : <ScanText size={12} />}{" "}
        {busy ? t("aichat.explain.working") : t("aichat.explain.pick")}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void run(f);
        }}
      />
      {err && <div style={{ color: "var(--danger, #e66)", fontSize: 12 }}>{err}</div>}
      {res && !res.answer && <div className="muted-sm">{t("aichat.explain.noText")}</div>}
      {res?.answer && (
        <div style={{ fontSize: 13 }}>
          <div style={{ whiteSpace: "pre-wrap" }}>{res.answer}</div>
          {res.formulas.length > 0 && (
            <div className="muted-sm" style={{ marginTop: 4 }}>
              {res.formulas.map((f, i) => (
                <div key={i}>
                  <code>{f}</code>
                </div>
              ))}
            </div>
          )}
          <button style={{ marginTop: 4 }} onClick={() => onUse(res.answer)}>
            {t("aichat.explain.use")}
          </button>
        </div>
      )}
    </div>
  );
}

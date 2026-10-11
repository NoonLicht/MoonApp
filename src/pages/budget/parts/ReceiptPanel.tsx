import { useRef, useState } from "react";
import { Camera, Check, Receipt } from "lucide-react";
import { Glass, Btn, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Draft = Awaited<ReturnType<typeof api.budgetParseReceipt>>;
type Row = Draft["items"][number] & { on: boolean };

/**
 * Чек → операции: фото распознаётся локально (tesseract), текст разбирается в
 * позиции с категориями. Ничего не сохраняется, пока пользователь не проверит
 * черновик: распознавание ошибается, а расхождение с итогом показано явно.
 */
export default function ReceiptPanel({
  currency,
  categories,
  onChanged,
}: {
  currency: string;
  categories: string[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(0);

  const pick = async (file: File) => {
    setBusy(true);
    setError("");
    setSaved(0);
    try {
      const { text } = await api.ocrRecognize(file);
      const d = await api.budgetParseReceipt(text);
      setDraft(d);
      setRows(d.items.map((i) => ({ ...i, on: true })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const date = draft.date || new Date().toISOString().slice(0, 10);
      const chosen = rows.filter((r) => r.on);
      for (const r of chosen) {
        await api.budgetCreate({
          type: "expense",
          amount: r.amount,
          category: r.category,
          note: [draft.merchant, r.name].filter(Boolean).join(" · "),
          date,
          currency,
        });
      }
      setSaved(chosen.length);
      setDraft(null);
      setRows([]);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patch = (i: number, p: Partial<Row>) =>
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)));

  return (
    <>
      <SectionHead eyebrow={t("budget.receipt.eyebrow")} title={t("budget.receipt.title")} />
      <Glass className="p-4">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void pick(f);
          }}
        />
        <Btn onClick={() => fileRef.current?.click()} disabled={busy}>
          <Camera size={14} /> {busy ? t("budget.receipt.working") : t("budget.receipt.pick")}
        </Btn>
        {error && <div style={{ color: "var(--danger, #e66)", marginTop: 8 }}>{error}</div>}
        {saved > 0 && (
          <div style={{ marginTop: 8 }}>
            <Check size={14} /> {t("budget.receipt.saved", { n: saved })}
          </div>
        )}
        {draft && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Receipt size={14} />
              <strong>{draft.merchant || t("budget.receipt.unknownShop")}</strong>
              <span className="muted-sm">{draft.date || t("budget.receipt.noDate")}</span>
              {draft.total !== null && (
                <span className="muted-sm">
                  {t("budget.receipt.total")}: {draft.total.toFixed(2)}
                </span>
              )}
            </div>
            {draft.mismatch !== null && Math.abs(draft.mismatch) > 0.009 && (
              <div style={{ color: "var(--warn, #d9a441)", fontSize: 12, marginTop: 4 }}>
                {t("budget.receipt.mismatch", { diff: draft.mismatch.toFixed(2) })}
              </div>
            )}
            {rows.length === 0 && <div className="muted-sm">{t("budget.receipt.noItems")}</div>}
            {rows.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={r.on}
                  onChange={(e) => patch(i, { on: e.target.checked })}
                />
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={r.name}
                  onChange={(e) => patch(i, { name: e.target.value })}
                />
                <input
                  className="input"
                  style={{ width: 90 }}
                  type="number"
                  step="0.01"
                  value={r.amount}
                  onChange={(e) => patch(i, { amount: Number(e.target.value) })}
                />
                <select
                  className="input"
                  value={r.category}
                  onChange={(e) => patch(i, { category: e.target.value })}
                >
                  {[...new Set([r.category, ...categories])].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
            ))}
            {rows.some((r) => r.on) && (
              <Btn variant="primary" onClick={save} disabled={busy} style={{ marginTop: 10 }}>
                {t("budget.receipt.save")}
              </Btn>
            )}
          </div>
        )}
      </Glass>
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  Wallet,
  Plus,
  Trash2,
  X,
  Save,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Upload,
  Sparkles,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Glass, Btn, Badge, EmptyHint, SectionHead, Select } from "@/components/ui";
import { AiFeatureToggle } from "@/components/AiFeatureToggle";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { Transaction, TxType, BudgetCategories, MonthSummary } from "@/api/types";

const PIE_COLORS = [
  "var(--amber)",
  "var(--teal)",
  "var(--violet)",
  "var(--coral)",
  "#8bd5ff",
  "#c9a0ff",
  "#ffd479",
];

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

interface FormState {
  type: TxType;
  amount: string;
  category: string;
  note: string;
  date: string;
  currency: string;
}

function emptyForm(categories: BudgetCategories | null, currency: string): FormState {
  return {
    type: "expense",
    amount: "",
    category: categories?.expense[0] || "",
    note: "",
    date: new Date().toISOString().slice(0, 10),
    currency,
  };
}

export default function BudgetPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<MonthSummary[]>([]);
  const [categories, setCategories] = useState<BudgetCategories | null>(null);
  const [currencies, setCurrencies] = useState<string[]>(["RUB"]);
  const [displayCurrency, setDisplayCurrency] = useState("RUB");
  const [period, setPeriod] = useState<"day" | "week" | "month">("month");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm(null, "RUB"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [catBusy, setCatBusy] = useState(false);

  const aiCategorize = async () => {
    if (!form.note.trim()) return;
    setCatBusy(true);
    try {
      const all = [...(categories?.expense || []), ...(categories?.income || [])];
      const r = await api.aiBudgetCategorize(form.note.trim(), all);
      const suggested = r.text.trim();
      if (suggested) setForm((f) => ({ ...f, category: suggested }));
    } catch {
      /* тумблер рядом покажет причину отказа */
    } finally {
      setCatBusy(false);
    }
  };

  const periodCount: Record<"day" | "week" | "month", number> = { day: 14, week: 8, month: 6 };

  const load = (currency = displayCurrency, gran = period) => {
    setLoading(true);
    Promise.all([
      api.budgetList(currency),
      api.budgetSummary(gran, periodCount[gran], currency),
      api.budgetCategories(),
      api.budgetCurrencies(),
    ])
      .then(([tx, sum, cats, currList]) => {
        setItems(tx);
        setSummary(sum);
        setCategories(cats);
        setCurrencies(currList);
        setForm((f) => (f.category ? f : { ...f, category: cats.expense[0] || "" }));
      })
      .catch(() => {
        setItems([]);
        setSummary([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentMonth = summary[summary.length - 1];
  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    let unconverted = 0;
    for (const x of items) {
      const amount = x.displayAmount ?? (x.currency === displayCurrency ? x.amount : null);
      if (amount === null) {
        unconverted++;
        continue;
      }
      if (x.type === "income") income += amount;
      else expense += amount;
    }
    return { income, expense, balance: income - expense, unconverted };
  }, [items, displayCurrency]);

  const categoryBreakdown = useMemo(() => {
    if (!currentMonth) return [];
    return Object.entries(currentMonth.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([category, amount]) => ({ category, amount }));
  }, [currentMonth]);

  const save = async () => {
    const amount = parseFloat(form.amount.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0 || !form.category) return;
    setSaving(true);
    setError("");
    try {
      await api.budgetCreate({
        type: form.type,
        amount,
        category: form.category,
        note: form.note.trim(),
        date: form.date,
        currency: form.currency,
      });
      setForm(emptyForm(categories, displayCurrency));
      setShowForm(false);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await api.budgetDelete(id);
    load();
  };

  const importCsv = async (file: File) => {
    setImporting(true);
    setImportMsg("");
    try {
      const text = await file.text();
      const r = await api.budgetImportCsv(text);
      setImportMsg(t("budget.importResult", { imported: r.imported, skipped: r.skipped }));
      load();
    } catch (e) {
      setImportMsg((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const categoryOptions = form.type === "income" ? categories?.income : categories?.expense;

  return (
    <div className="page">
      <SectionHead
        eyebrow={t("budget.eyebrow")}
        title={t("budget.title")}
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Select
              value={displayCurrency}
              onChange={(e) => {
                const c = e.target.value;
                setDisplayCurrency(c);
                load(c);
              }}
              options={currencies.map((c) => ({ value: c, label: c }))}
            />
            <label className="btn" style={{ cursor: importing ? "default" : "pointer" }}>
              <Upload size={14} />
              {importing ? t("budget.importing") : t("budget.import")}
              <input
                type="file"
                accept=".csv,text/csv"
                hidden
                disabled={importing}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importCsv(f);
                  e.target.value = "";
                }}
              />
            </label>
            <Btn variant="primary" icon={Plus} onClick={() => setShowForm(true)}>
              {t("budget.add")}
            </Btn>
            <AiFeatureToggle feature="budget" />
          </div>
        }
      />

      {importMsg && <div className="muted-sm">{importMsg}</div>}

      <div className="budget-totals">
        <Glass className="budget-total-card">
          <TrendingUp size={16} style={{ color: "var(--teal)" }} />
          <div>
            <div className="muted-sm">{t("budget.totalIncome")}</div>
            <div className="budget-total-value">
              {fmtMoney(totals.income)} {displayCurrency}
            </div>
          </div>
        </Glass>
        <Glass className="budget-total-card">
          <TrendingDown size={16} style={{ color: "var(--coral)" }} />
          <div>
            <div className="muted-sm">{t("budget.totalExpense")}</div>
            <div className="budget-total-value">
              {fmtMoney(totals.expense)} {displayCurrency}
            </div>
          </div>
        </Glass>
        <Glass className="budget-total-card">
          <Wallet size={16} style={{ color: "var(--amber)" }} />
          <div>
            <div className="muted-sm">{t("budget.balance")}</div>
            <div className="budget-total-value">
              {fmtMoney(totals.balance)} {displayCurrency}
            </div>
          </div>
        </Glass>
      </div>

      {totals.unconverted > 0 && (
        <div className="muted-sm" style={{ color: "var(--coral)" }}>
          {t("budget.unconvertedHint", { n: totals.unconverted })}
        </div>
      )}

      {error && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)" }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{error}</span>
        </Glass>
      )}

      {showForm && (
        <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              variant={form.type === "expense" ? "primary" : "default"}
              onClick={() =>
                setForm((f) => ({ ...f, type: "expense", category: categories?.expense[0] || "" }))
              }
            >
              {t("budget.expense")}
            </Btn>
            <Btn
              variant={form.type === "income" ? "primary" : "default"}
              onClick={() =>
                setForm((f) => ({ ...f, type: "income", category: categories?.income[0] || "" }))
              }
            >
              {t("budget.income")}
            </Btn>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="text-input"
              style={{ flex: 1 }}
              type="number"
              step="0.01"
              placeholder={t("budget.fAmount")}
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            />
            <Select
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              options={currencies.map((c) => ({ value: c, label: c }))}
            />
          </div>
          <input
            className="text-input"
            placeholder={t("budget.fNote")}
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Select
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              options={(categoryOptions || []).map((c) => ({ value: c, label: c }))}
              style={{ flex: 1 }}
            />
            <Btn icon={Sparkles} onClick={aiCategorize} disabled={catBusy || !form.note.trim()}>
              {catBusy ? t("budget.aiCatBusy") : t("budget.aiCatBtn")}
            </Btn>
          </div>
          <input
            className="text-input"
            type="date"
            value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              variant="primary"
              icon={Save}
              disabled={saving || !form.amount || !form.category}
              onClick={() => void save()}
            >
              {t("budget.save")}
            </Btn>
            <Btn icon={X} onClick={() => setShowForm(false)}>
              {t("ctx.clear")}
            </Btn>
          </div>
        </Glass>
      )}

      <SectionHead
        eyebrow={t("budget.chartEyebrow")}
        title={t("budget.chartTitle")}
        action={
          <div style={{ display: "flex", gap: 4 }}>
            {(["day", "week", "month"] as const).map((p) => (
              <Btn
                key={p}
                variant={period === p ? "primary" : "secondary"}
                onClick={() => {
                  setPeriod(p);
                  load(displayCurrency, p);
                }}
              >
                {t(`budget.period.${p}`)}
              </Btn>
            ))}
          </div>
        }
      />
      {summary.length > 0 && (
        <Glass style={{ padding: 12 }}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={summary}>
              <XAxis dataKey="month" stroke="var(--text-tertiary)" fontSize={11} />
              <YAxis stroke="var(--text-tertiary)" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: "var(--bg-base-2)",
                  border: "1px solid var(--glass-border)",
                  borderRadius: 8,
                }}
                formatter={(value: number) => [`${fmtMoney(value)} ${displayCurrency}`, undefined]}
              />
              <Legend />
              <Bar dataKey="income" name={t("budget.income")} fill="var(--teal)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="expense" name={t("budget.expense")} fill="var(--coral)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Glass>
      )}

      {categoryBreakdown.length > 0 && (
        <Glass style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
          <div className="muted-sm">{t("budget.categoryBreakdown")}</div>
          {categoryBreakdown.map((c, i) => (
            <div key={c.category} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: PIE_COLORS[i % PIE_COLORS.length],
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1 }}>{c.category}</span>
              <span className="muted-sm">{fmtMoney(c.amount)}</span>
            </div>
          ))}
        </Glass>
      )}

      <SectionHead eyebrow={t("budget.listEyebrow")} title={t("budget.listTitle")} />
      {loading && <div className="muted-sm">{t("passwordVault.loading")}</div>}
      {!loading && items.length === 0 && <EmptyHint icon={Wallet} text={t("budget.empty")} />}

      <div className="budget-tx-list">
        {items.map((x) => (
          <Glass key={x.id} className="budget-tx-row">
            <Badge tone={x.type === "income" ? "teal" : "coral"}>{x.category}</Badge>
            <span className="muted-sm" style={{ flex: 1 }}>
              {x.date}
              {x.note ? ` · ${x.note}` : ""}
            </span>
            <span
              style={{
                fontWeight: 600,
                color: x.type === "income" ? "var(--teal)" : "var(--coral)",
                textAlign: "right",
              }}
            >
              {x.type === "income" ? "+" : "−"}
              {fmtMoney(x.amount)} {x.currency}
              {x.currency !== displayCurrency && (
                <div className="muted-sm" style={{ fontWeight: 400 }}>
                  {x.displayAmount != null
                    ? `≈ ${fmtMoney(x.displayAmount)} ${displayCurrency}`
                    : t("budget.noRate")}
                </div>
              )}
            </span>
            <button type="button" className="icon-btn" onClick={() => void remove(x.id)}>
              <Trash2 size={14} />
            </button>
          </Glass>
        ))}
      </div>
    </div>
  );
}

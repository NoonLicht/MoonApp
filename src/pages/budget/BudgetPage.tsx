import { useEffect, useMemo, useState } from "react";
import { Wallet, Plus, Trash2, X, Save, TrendingUp, TrendingDown, AlertTriangle } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Glass, Btn, Badge, EmptyHint, SectionHead, Select } from "@/components/ui";
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
}

function emptyForm(categories: BudgetCategories | null): FormState {
  return {
    type: "expense",
    amount: "",
    category: categories?.expense[0] || "",
    note: "",
    date: new Date().toISOString().slice(0, 10),
  };
}

export default function BudgetPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<MonthSummary[]>([]);
  const [categories, setCategories] = useState<BudgetCategories | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm(null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    Promise.all([api.budgetList(), api.budgetSummary(6), api.budgetCategories()])
      .then(([tx, sum, cats]) => {
        setItems(tx);
        setSummary(sum);
        setCategories(cats);
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
  }, []);

  const currentMonth = summary[summary.length - 1];
  const totals = useMemo(() => {
    const income = items.reduce((s, x) => (x.type === "income" ? s + x.amount : s), 0);
    const expense = items.reduce((s, x) => (x.type === "expense" ? s + x.amount : s), 0);
    return { income, expense, balance: income - expense };
  }, [items]);

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
      });
      setForm(emptyForm(categories));
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

  const categoryOptions = form.type === "income" ? categories?.income : categories?.expense;

  return (
    <div className="page">
      <SectionHead
        eyebrow={t("budget.eyebrow")}
        title={t("budget.title")}
        action={
          <Btn variant="primary" icon={Plus} onClick={() => setShowForm(true)}>
            {t("budget.add")}
          </Btn>
        }
      />

      <div className="budget-totals">
        <Glass className="budget-total-card">
          <TrendingUp size={16} style={{ color: "var(--teal)" }} />
          <div>
            <div className="muted-sm">{t("budget.totalIncome")}</div>
            <div className="budget-total-value">{fmtMoney(totals.income)}</div>
          </div>
        </Glass>
        <Glass className="budget-total-card">
          <TrendingDown size={16} style={{ color: "var(--coral)" }} />
          <div>
            <div className="muted-sm">{t("budget.totalExpense")}</div>
            <div className="budget-total-value">{fmtMoney(totals.expense)}</div>
          </div>
        </Glass>
        <Glass className="budget-total-card">
          <Wallet size={16} style={{ color: "var(--amber)" }} />
          <div>
            <div className="muted-sm">{t("budget.balance")}</div>
            <div className="budget-total-value">{fmtMoney(totals.balance)}</div>
          </div>
        </Glass>
      </div>

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
          <input
            className="text-input"
            type="number"
            step="0.01"
            placeholder={t("budget.fAmount")}
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
          />
          <Select
            value={form.category}
            onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            options={(categoryOptions || []).map((c) => ({ value: c, label: c }))}
          />
          <input
            className="text-input"
            type="date"
            value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
          />
          <input
            className="text-input"
            placeholder={t("budget.fNote")}
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
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

      <SectionHead eyebrow={t("budget.chartEyebrow")} title={t("budget.chartTitle")} />
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
              }}
            >
              {x.type === "income" ? "+" : "−"}
              {fmtMoney(x.amount)}
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

/**
 * Выделено из SettingsPage.tsx при разбиении крупного файла (поведение не менялось).
 */
import { useI18n } from "@/app/i18n";
import { useState, useEffect } from "react";
import type { PasswordEntry } from "@/api/types";
import { api } from "@/api/client";
import { copyToClipboard } from "@/components/ContextMenu";
import { Lock, EyeOff, Eye, Copy, Trash2, Dices, Settings2, Save, Plus } from "lucide-react";
import { EmptyHint, Btn, Badge } from "@/components/ui";
import { GEN_OPTS_KEY, loadGenOpts, type GenOpts } from "@/pages/settings/parts/SettingsApiKeys";
import { Section } from "@/pages/settings/parts/SettingsControls";

export function PasswordVaultSection() {
  const { t } = useI18n();
  const [items, setItems] = useState<PasswordEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", username: "", password: "", url: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [genOpts, setGenOpts] = useState<GenOpts>(loadGenOpts);
  const [genOpen, setGenOpen] = useState(false);

  const updateGenOpts = (patch: Partial<GenOpts>) => {
    setGenOpts((prev) => {
      // Хотя бы один набор символов должен остаться включённым — иначе
      // генератору не из чего собирать пароль (сервер на этот случай молча
      // откатывается на строчные буквы, но в UI лучше не давать выключить
      // всё до конца).
      const next = { ...prev, ...patch };
      if (!next.lower && !next.upper && !next.digits && !next.symbols) return prev;
      try {
        localStorage.setItem(GEN_OPTS_KEY, JSON.stringify(next));
      } catch {
        /* квота переполнена — не критично, просто не запомнится */
      }
      return next;
    });
  };

  const load = () => {
    setLoading(true);
    api
      .passwordsList()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleReveal = async (id: string) => {
    if (revealed[id] != null) {
      setRevealed((r) => {
        const next = { ...r };
        delete next[id];
        return next;
      });
      return;
    }
    try {
      const full = await api.passwordsReveal(id);
      setRevealed((r) => ({ ...r, [id]: full.password }));
    } catch {
      /* не удалось расшифровать — оставляем скрытым */
    }
  };

  const copy = async (id: string) => {
    try {
      const full =
        revealed[id] != null ? { password: revealed[id] } : await api.passwordsReveal(id);
      copyToClipboard(full.password);
    } catch {
      /* ignore */
    }
  };

  const remove = async (id: string) => {
    await api.passwordsDelete(id);
    setRevealed((r) => {
      const next = { ...r };
      delete next[id];
      return next;
    });
    load();
  };

  const generate = async () => {
    try {
      const { password } = await api.passwordsGenerate(genOpts);
      setForm((f) => ({ ...f, password }));
    } catch {
      /* ignore */
    }
  };

  const save = async () => {
    if (!form.password.trim()) return;
    setSaving(true);
    try {
      await api.passwordsCreate(form);
      setForm({ title: "", username: "", password: "", url: "", notes: "" });
      setShowForm(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={t("passwordVault.title")} icon={Lock}>
      <div className="muted-sm" style={{ marginBottom: 8 }}>
        {t("passwordVault.hint")}
      </div>

      {loading && <div className="muted-sm">{t("passwordVault.loading")}</div>}
      {!loading && items.length === 0 && !showForm && (
        <EmptyHint icon={Lock} text={t("passwordVault.empty")} />
      )}

      {items.map((it) => (
        <div key={it.id} className="set-row" style={{ alignItems: "flex-start" }}>
          <div className="set-info">
            <div className="set-label">{it.title}</div>
            <div className="muted-sm">
              {it.username || "—"}
              {it.url ? ` · ${it.url}` : ""}
            </div>
            {revealed[it.id] != null && (
              <div className="muted-sm mono" style={{ marginTop: 4 }}>
                {revealed[it.id]}
              </div>
            )}
          </div>
          <div className="set-control" style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="icon-btn"
              title={revealed[it.id] != null ? t("passwordVault.hide") : t("passwordVault.show")}
              onClick={() => void toggleReveal(it.id)}
            >
              {revealed[it.id] != null ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              title={t("passwordVault.copy")}
              onClick={() => void copy(it.id)}
            >
              <Copy size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title={t("ctx.remove")}
              onClick={() => void remove(it.id)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
      ))}

      {showForm ? (
        <div className="set-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <input
            className="text-input"
            placeholder={t("passwordVault.fTitle")}
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          />
          <input
            className="text-input"
            placeholder={t("passwordVault.fUsername")}
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="text-input"
              style={{ flex: 1 }}
              placeholder={t("passwordVault.fPassword")}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
            <Btn icon={Dices} onClick={() => void generate()} title={t("passwordVault.generate")} />
            <Btn
              icon={Settings2}
              onClick={() => setGenOpen((v) => !v)}
              title={t("passwordVault.genOptions")}
            />
          </div>

          {genOpen && (
            <div className="pv-gen-opts">
              <div className="pv-gen-len">
                <span className="muted-sm">
                  {t("passwordVault.genLength")}: {genOpts.length}
                </span>
                <input
                  type="range"
                  min={4}
                  max={64}
                  value={genOpts.length}
                  onChange={(e) => updateGenOpts({ length: Number(e.target.value) })}
                />
              </div>
              <div className="pv-gen-toggles">
                {(
                  [
                    ["lower", t("passwordVault.genLower")],
                    ["upper", t("passwordVault.genUpper")],
                    ["digits", t("passwordVault.genDigits")],
                    ["symbols", t("passwordVault.genSymbols")],
                  ] as const
                ).map(([key, label]) => (
                  <Badge
                    key={key}
                    tone="amber"
                    active={genOpts[key]}
                    onClick={() => updateGenOpts({ [key]: !genOpts[key] })}
                  >
                    {label}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <input
            className="text-input"
            placeholder={t("passwordVault.fUrl")}
            value={form.url}
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              variant="primary"
              icon={Save}
              disabled={saving || !form.password.trim()}
              onClick={() => void save()}
            >
              {t("passwordVault.save")}
            </Btn>
            <Btn onClick={() => setShowForm(false)}>{t("ctx.clear")}</Btn>
          </div>
        </div>
      ) : (
        <Btn icon={Plus} onClick={() => setShowForm(true)}>
          {t("passwordVault.add")}
        </Btn>
      )}
    </Section>
  );
}

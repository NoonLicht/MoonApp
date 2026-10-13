import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { AiBinding, AiBindingsData } from "@/api/apiLlama";
import { Btn, Select } from "@/components/ui";

const GROUPS = ["chat", "notes", "mail", "lecture", "translate"] as const;

/**
 * «Привязка моделей ИИ»: для каждой ИИ-функции — «Авто» (как раньше) или свои провайдер и модель.
 * Изменения сохраняются сразу, перезапуск не нужен.
 */
export function AiBindings() {
  const { t } = useI18n();
  const [data, setData] = useState<AiBindingsData | null>(null);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    api
      .aiBindings()
      .then(setData)
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(() => load(), [load]);

  const fetchModels = useCallback(async (provider: string): Promise<string[]> => {
    if (!provider) return [];
    try {
      const list = await api.chatModels(provider);
      setModels((s) => ({ ...s, [provider]: list }));
      return list;
    } catch {
      setModels((s) => ({ ...s, [provider]: [] }));
      return [];
    }
  }, []);

  // Список моделей нужен для каждого провайдера, выбранного в функциях со снятым «Авто».
  useEffect(() => {
    if (!data) return;
    const need = new Set<string>();
    for (const b of Object.values(data.bindings)) if (!b.auto && b.provider) need.add(b.provider);
    for (const p of need) void fetchModels(p);
  }, [data, fetchModels]);

  if (err) return <div className="proxy-error">{err}</div>;
  if (!data) return <div className="muted-sm">…</div>;

  const bindingOf = (id: string): AiBinding =>
    data.bindings[id] ?? { auto: true, provider: "", model: "" };

  const save = async (id: string, patch: Partial<AiBinding>) => {
    try {
      const next = await api.aiBindingSet(id, patch);
      setData((d) => (d ? { ...d, bindings: { ...d.bindings, [id]: next } } : d));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const toggleAuto = async (id: string, auto: boolean) => {
    if (auto) return save(id, { auto: true });
    const cur = bindingOf(id);
    // Снимаем «Авто»: подставляем разумные значения, чтобы привязка сразу стала рабочей.
    const provider =
      cur.provider ||
      data.providers.find((p) => p.id === "llamacpp")?.id ||
      data.providers.find((p) => p.configured)?.id ||
      "";
    const list = models[provider] ?? (await fetchModels(provider));
    return save(id, { auto: false, provider, model: cur.model || list[0] || "" });
  };

  const changeProvider = async (id: string, provider: string) => {
    const list = models[provider] ?? (await fetchModels(provider));
    await save(id, { provider, model: list[0] || "" });
  };

  const boundCount = data.features.filter((f) => {
    const b = data.bindings[f.id];
    return b && !b.auto && b.provider && b.model;
  }).length;

  return (
    <div className="aibind">
      <div className="muted-sm">{t("aibind.intro")}</div>
      <div className="aibind-top">
        <span className="muted-sm">{t("aibind.bound", { n: boundCount })}</span>
        <Btn
          icon={RotateCcw}
          disabled={boundCount === 0}
          onClick={async () => {
            await api.aiBindingsReset();
            load();
          }}
        >
          {t("aibind.reset")}
        </Btn>
      </div>
      {GROUPS.map((g) => {
        const items = data.features.filter((f) => f.group === g);
        if (!items.length) return null;
        return (
          <div key={g} className="aibind-group">
            <div className="aibind-group-title">{t(`aibind.g_${g}`)}</div>
            {items.map((f) => {
              const b = bindingOf(f.id);
              const prov = data.providers.find((p) => p.id === b.provider);
              const list = models[b.provider] ?? [];
              const options = !b.model || list.includes(b.model) ? list : [b.model, ...list];
              return (
                <div key={f.id} className="aibind-row">
                  <div className="aibind-info">
                    <b>{t(`aibind.f_${f.id.replaceAll(".", "_")}`)}</b>
                    <span className="muted-sm">{t(`aibind.h_${f.id.replaceAll(".", "_")}`)}</span>
                  </div>
                  <label className="aibind-auto">
                    <input
                      type="checkbox"
                      checked={b.auto}
                      onChange={(e) => void toggleAuto(f.id, e.target.checked)}
                    />
                    <span>{t("aibind.auto")}</span>
                  </label>
                  {b.auto ? (
                    <span className="muted-sm aibind-note">{t("aibind.autoNote")}</span>
                  ) : (
                    <div className="aibind-pick">
                      <Select
                        value={b.provider}
                        onChange={(e) => void changeProvider(f.id, e.target.value)}
                        options={data.providers.map((p) => ({
                          value: p.id,
                          label: p.local ? `${p.label} · ${t("aibind.local")}` : p.label,
                        }))}
                      />
                      <Select
                        value={b.model}
                        onChange={(e) => void save(f.id, { model: e.target.value })}
                        options={
                          options.length
                            ? options.map((m) => ({ value: m, label: m }))
                            : [{ value: "", label: t("aibind.noModels") }]
                        }
                      />
                      {prov && !prov.configured && (
                        <span className="aibind-warn">{t("aibind.noKey")}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

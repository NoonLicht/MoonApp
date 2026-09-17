import { useCallback, useEffect, useMemo, useState } from "react";
import { Sparkles, X, RefreshCw, Check, AlertTriangle, Zap, Hand, ListChecks } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { TranslateFn } from "@/app/i18n";
import { api } from "@/api/client";
import type { LectureConspectusSettings, LectureConspectusTrigger } from "@/api/client";
import type { ModelNameError } from "@/lib/modelError";

/**
 * Панель «ИИ-конспект»: каким ИИ делать конспект лекции и когда его запускать.
 *
 * Зачем отдельная панель: раньше провайдер конспекта молча брался из настроек
 * AI-чата. Пользователь не видел ни провайдера, ни модели — и не понимал, почему
 * конспект «не собирается» (а причина была в отсутствующем ключе).
 *
 * Три режима запуска:
 *   smart  — сам после окончания записи, но только если есть что конспектировать
 *            (текста не меньше autoMinChars и он заметно вырос с прошлой сборки);
 *   auto   — сам всегда после записи;
 *   manual — только кнопкой «ИИ-конспект» на странице.
 */

/** Коды ошибок бэкенда → текст (неизвестный код показываем как есть). */
function errorText(t: TranslateFn, raw: string): string {
  if (!raw) return "";
  if (/conspectus_not_configured/.test(raw)) {
    return t("lecture.errConspectusKey", { provider: raw.split(": ")[1] || "" });
  }
  if (/conspectus_provider_unknown/.test(raw)) {
    return t("lecture.errConspectusProvider", { provider: raw.split(": ")[1] || "" });
  }
  if (/conspectus_trigger_unknown/.test(raw)) return t("lecture.conspectusPanel.errTrigger");
  return raw;
}

/** Пиктограмма режима запуска: умный — молния, авто — список, вручную — рука. */
function TriggerIcon({ id }: { id: LectureConspectusTrigger }) {
  if (id === "smart") return <Zap size={13} />;
  if (id === "auto") return <ListChecks size={13} />;
  return <Hand size={13} />;
}

/** Подпись опции «как в чате»: показываем, какой провайдер сейчас в настройках чата. */
function chatLabel(cfg: LectureConspectusSettings | null): string {
  const id = cfg?.chatProvider || "";
  const found = cfg?.providers.find((p) => p.id === id);
  return found?.label || id || "—";
}

export default function LectureConspectusPanel({
  onClose,
  inline = false,
  onChanged,
  modelHints = null,
}: {
  onClose?: () => void;
  inline?: boolean;
  onChanged?: () => void;
  /**
   * Разбор ошибки «провайдер не принимает модель» (см. src/lib/modelError.ts):
   * показываем имена, которые сервис реально принимает, — одним кликом.
   */
  modelHints?: ModelNameError | null;
}) {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<LectureConspectusSettings | null>(null);
  const [draft, setDraft] = useState<LectureConspectusSettings | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const apply = useCallback((next: LectureConspectusSettings) => {
    setCfg(next);
    setDraft(next);
  }, []);

  /** Метка «Сохранено» на 1.5 секунды — одинаковая для кнопки и для авто-сохранения. */
  const flashSaved = useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .lectureConspectusSettings()
      .then((s) => {
        if (alive) apply(s);
      })
      .catch(() => {
        /* бэкенд ещё поднимается — панель покажет «нет данных» */
      });
    return () => {
      alive = false;
    };
  }, [apply]);

  /** Живой список моделей выбранного провайдера (обновляется кнопкой рядом). */
  const loadModels = useCallback(
    async (providerId: string) => {
      if (!providerId) {
        setModels(null);
        return;
      }
      setBusy("models");
      setError("");
      try {
        const r = await api.lectureProviderModels(providerId);
        setModels(r.models);
      } catch (e) {
        setModels(null);
        setError(errorText(t, String((e as Error)?.message || e)));
      }
      setBusy("");
    },
    [t],
  );

  // При смене провайдера список моделей прежнего неактуален — перезагружаем.
  useEffect(() => {
    if (!draft?.providerId) {
      setModels(null);
      return;
    }
    void loadModels(draft.providerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.providerId]);

  /**
   * Сохранить ОДНО поле сразу (модель, провайдер).
   *
   * Зачем: без этого выбранная модель жила только в черновике и терялась, как
   * только панель закрывали без нажатия «Сохранить» — жалоба «не сохраняется
   * выбранная мною модель». Патч частичный, поэтому несохранённые правки
   * остальных полей (режим, порог, нарезка) не задеваются.
   *
   * cfg (сохранённая копия) обновляем ТОЧЕЧНО по полям патча: если записать
   * туда весь ответ сервера, «dirty» обнулился бы и кнопка «Сохранить» перестала
   * бы замечать правки в других полях.
   */
  const saveField = useCallback(
    async (patch: Partial<LectureConspectusSettings>) => {
      setBusy("field");
      setError("");
      try {
        const next = await api.lectureConspectusSetSettings(patch);
        setCfg((c) => {
          if (!c) return next;
          const merged: Record<string, unknown> = { ...c };
          for (const k of Object.keys(patch))
            merged[k] = (next as unknown as Record<string, unknown>)[k];
          return merged as unknown as LectureConspectusSettings;
        });
        flashSaved();
        onChanged?.();
      } catch (e) {
        setError(errorText(t, String((e as Error)?.message || e)));
      }
      setBusy("");
    },
    [t, onChanged, flashSaved],
  );

  const pickModel = useCallback(
    (model: string) => {
      setDraft((d) => (d ? { ...d, model } : d));
      void saveField({ model });
    },
    [saveField],
  );

  /** Смена провайдера: модель прежнего провайдера к новому не относится — сбрасываем. */
  const pickProvider = useCallback(
    (providerId: string) => {
      setDraft((d) => (d ? { ...d, providerId, model: "" } : d));
      void saveField({ providerId, model: "" });
    },
    [saveField],
  );

  /**
   * Опции селекта модели: живой список провайдера + сохранённая модель.
   * Сохранённой модели может не быть в списке (кастомное имя или список ещё не
   * загрузился) — тогда показываем её первой, чтобы выбор не «исчезал» из UI.
   */
  const modelOptions = useMemo(() => {
    const savedModel = draft?.model || "";
    const list = (models || []).map(String).filter(Boolean);
    return savedModel && !list.includes(savedModel) ? [savedModel, ...list] : list;
  }, [models, draft?.model]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy("save");
    setError("");
    try {
      apply(
        await api.lectureConspectusSetSettings({
          providerId: draft.providerId,
          model: draft.model,
          trigger: draft.trigger,
          autoMinChars: draft.autoMinChars,
          chunkChars: draft.chunkChars,
          overlapChars: draft.overlapChars,
          maxChunks: draft.maxChunks,
        }),
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onChanged?.();
    } catch (e) {
      setError(errorText(t, String((e as Error)?.message || e)));
    }
    setBusy("");
  }, [draft, apply, onChanged, t, flashSaved]);

  const setTrigger = (trigger: LectureConspectusTrigger) =>
    setDraft((d) => (d ? { ...d, trigger } : d));

  const active = cfg?.providers.find((p) => p.id === cfg.providerId);
  const noKey = !!cfg && !cfg.hasKey;
  /**
   * Сохранённая модель, которой НЕТ в живом списке провайдера: типичный случай —
   * опечатка («depseek-flash» вместо «deepseek-flash»). Раньше такое значение
   * просто показывалось первой опцией селекта (чтобы выбор «не исчезал»), и
   * проблема маскировалась: конспект падал только при сборке, сырым ответом
   * шлюза. Теперь панель сразу предупреждает и предлагает имена из списка.
   */
  const modelUnknown =
    !!draft?.model && !!models?.length && !models.includes(draft.model.trim());
  /** Чем заменить неверную модель: живой список провайдера или имена из ошибки. */
  const modelChoices = modelUnknown
    ? (models || []).slice(0, 8)
    : (modelHints?.names || []).slice(0, 8);
  const modelWarn = modelUnknown
    ? t("lecture.conspectusPanel.modelUnknown", { model: draft?.model || "" })
    : modelHints?.names?.length
      ? t("lecture.conspectusPanel.modelRejected", { model: modelHints.model || "—" })
      : "";
  const dirty = !!draft && !!cfg && JSON.stringify(draft) !== JSON.stringify(cfg);
  const body = (
    <div className={inline ? "lecs-inline-body" : "lecs-panel"}>
      {/* Шапка */}
      <div className="lecs-head">
        <span className="lecs-icon">
          <Sparkles size={17} />
        </span>
        <div className="lecs-title">
          <div className="lecs-eyebrow">{t("lecture.conspectusPanel.eyebrow")}</div>
          <div className="lecs-h1">{t("lecture.conspectusPanel.title")}</div>
        </div>
        <span className={`lecs-pill ${cfg?.hasKey ? "on" : "off"}`}>
          {active ? active.label : cfg?.providerId || t("lecture.conspectusPanel.notReady")}
        </span>
        {!inline && (
          <button className="lecs-close" onClick={onClose} title={t("common.close")}>
            <X size={15} />
          </button>
        )}
      </div>
      {!!error && <div className="lecs-error">{error}</div>}
      {/* Ключа нет — предупреждаем ЗАРАНЕЕ, а не при сборке конспекта. */}
      {noKey && (
        <div className="lecs-warn">
          <AlertTriangle size={13} />
          <span>
            {t("lecture.conspectusPanel.needKey", {
              provider: active?.label || cfg?.providerId || "",
            })}
          </span>
        </div>
      )}
      {/* --- Режим запуска --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.conspectusPanel.mode")}</div>
        <div className="lecs-mode">
          {(draft?.triggerOptions || ["smart", "auto", "manual"]).map((id) => (
            <button
              key={id}
              className={`lecs-mode-btn ${draft?.trigger === id ? "on" : ""}`}
              onClick={() => setTrigger(id)}
              disabled={!draft}
            >
              <TriggerIcon id={id} />
              {t(`lecture.conspectusPanel.trigger.${id}`)}
            </button>
          ))}
        </div>
        <div className="lecs-dim lecs-hint">
          {t(`lecture.conspectusPanel.triggerHint.${draft?.trigger || "smart"}`)}
        </div>
      </div>
      {/* --- Провайдер и модель --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.conspectusPanel.provider")}</div>
        <select
          className="lecs-select leca-select"
          value={draft?.providerId ?? ""}
          disabled={!draft || busy === "field"}
          aria-label={t("lecture.conspectusPanel.provider")}
          onChange={(e) => pickProvider(e.target.value)}
        >
          <option value="">
            {t("lecture.conspectusPanel.providerChat", { provider: chatLabel(cfg) })}
          </option>
          {(cfg?.providers || []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.hasKey ? "" : ` — ${t("lecture.conspectusPanel.noKeyShort")}`}
            </option>
          ))}
        </select>

        {/* Модель — обычный <select>, а не <input list>+<datalist>: попап даталиста
            рисует сам браузер, и в этой модалке он уезжал за левый край окна, а
            выбранное значение ещё и требовало нажатия «Сохранить» — иначе терялось.
            Теперь список приезжает от провайдера (кнопка рядом), а выбор
            сохраняется сразу, как в панели «Говорящие». */}
        <div className="leca-field">
          <span className="leca-pair grow">
            <span className="lecs-dim leca-label">{t("lecture.conspectusPanel.model")}</span>
            <select
              className="lecs-select leca-select"
              value={draft?.model ?? ""}
              disabled={!draft || busy === "field"}
              aria-label={t("lecture.conspectusPanel.model")}
              onChange={(e) => pickModel(e.target.value)}
            >
              <option value="">{t("lecture.conspectusPanel.modelAuto")}</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </span>
          <Btn
            variant="secondary"
            icon={RefreshCw}
            onClick={() => void loadModels(draft?.providerId || "")}
            disabled={busy === "models" || !draft?.providerId}
          >
            {busy === "models"
              ? t("lecture.conspectusPanel.modelLoading")
              : t("lecture.conspectusPanel.modelRefresh")}
          </Btn>
        </div>
        <div className="lecs-dim lecs-hint">
          {models?.length
            ? t("lecture.conspectusPanel.modelFound", { count: models.length })
            : t("lecture.conspectusPanel.modelHint")}
        </div>
        {/* Неверная модель: что случилось и на что её заменить (один клик). */}
        {!!modelWarn && (
          <div className="lecs-warn lecs-model-warn">
            <AlertTriangle size={13} />
            <div className="lecs-model-warn-body">
              <span>{modelWarn}</span>
              {!!modelChoices.length && (
                <span className="lec-model-chips">
                  {modelChoices.map((m) => (
                    <button
                      key={m}
                      className="lec-model-chip"
                      title={t("lecture.modelPick", { model: m })}
                      onClick={() => pickModel(m)}
                    >
                      {m}
                    </button>
                  ))}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      {/* --- Умный порог: что считать «есть что конспектировать» --- */}
      {draft?.trigger === "smart" && (
        <div className="lecs-block">
          <div className="lecs-block-label">{t("lecture.conspectusPanel.minChars")}</div>
          <div className="leca-row">
            <input
              className="lecs-input leca-num"
              type="number"
              min={0}
              max={200000}
              step={100}
              value={draft.autoMinChars}
              onChange={(e) =>
                setDraft((d) => (d ? { ...d, autoMinChars: Number(e.target.value) || 0 } : d))
              }
            />
            <span className="lecs-dim lecs-hint">{t("lecture.conspectusPanel.minCharsHint")}</span>
          </div>
        </div>
      )}{" "}
      {/* --- Тонкая настройка нарезки расшифровки --- */}
      <div className="lecs-block">
        <div className="lecs-block-label">{t("lecture.conspectusPanel.advanced")}</div>
        {/* Каждое поле — своя группа «подпись + значение + единица». Раньше три
            пары лежали плоским списком в одном .leca-row и переносились как
            попало: число отрывалось от подписи («Шов» уезжало к чужому 6000,
            «Лимит» вставало между 600 и 60) — понять, что есть что, было нельзя. */}
        <div className="leca-field">
          <span className="leca-pair">
            <span className="lecs-dim leca-label">{t("lecture.conspectusPanel.chunkChars")}</span>
            <input
              className="lecs-input leca-num"
              type="number"
              min={1500}
              max={20000}
              step={500}
              aria-label={t("lecture.conspectusPanel.chunkChars")}
              value={draft?.chunkChars ?? 6000}
              onChange={(e) =>
                setDraft((d) => (d ? { ...d, chunkChars: Number(e.target.value) || 6000 } : d))
              }
            />
          </span>
          <span className="lecs-dim leca-unit">{t("lecture.conspectusPanel.chunkCharsUnit")}</span>
        </div>
        <div className="leca-field">
          <span className="leca-pair">
            <span className="lecs-dim leca-label">{t("lecture.conspectusPanel.overlapChars")}</span>
            <input
              className="lecs-input leca-num"
              type="number"
              min={0}
              max={2000}
              step={50}
              aria-label={t("lecture.conspectusPanel.overlapChars")}
              value={draft?.overlapChars ?? 600}
              onChange={(e) =>
                setDraft((d) => (d ? { ...d, overlapChars: Number(e.target.value) || 0 } : d))
              }
            />
          </span>
          <span className="lecs-dim leca-unit">
            {t("lecture.conspectusPanel.overlapCharsUnit")}
          </span>
        </div>
        <div className="leca-field">
          <span className="leca-pair">
            <span className="lecs-dim leca-label">{t("lecture.conspectusPanel.maxChunks")}</span>
            <input
              className="lecs-input leca-num"
              type="number"
              min={1}
              max={300}
              step={1}
              aria-label={t("lecture.conspectusPanel.maxChunks")}
              value={draft?.maxChunks ?? 60}
              onChange={(e) =>
                setDraft((d) => (d ? { ...d, maxChunks: Number(e.target.value) || 60 } : d))
              }
            />
          </span>
          <span className="lecs-dim leca-unit">{t("lecture.conspectusPanel.maxChunksUnit")}</span>
        </div>
        <div className="lecs-dim lecs-hint">{t("lecture.conspectusPanel.advancedHint")}</div>
      </div>
      <div className="lecs-verify">
        <Btn
          variant="primary"
          icon={Check}
          onClick={() => void save()}
          disabled={!dirty || busy === "save"}
        >
          {t("common.save")}
        </Btn>
        {saved && (
          <span className="lecs-ok">
            <Check size={12} /> {t("common.saved")}
          </span>
        )}
        {!cfg && <span className="lecs-dim">{t("lecture.conspectusPanel.notReady")}</span>}
      </div>
    </div>
  );

  if (inline) return body;
  return (
    <div className="lecs-overlay" onClick={onClose}>
      <div className="lecs-modal leca-modal" onClick={(e) => e.stopPropagation()}>
        {/* .lecs-body — тело со скроллом: шапка с крестиком остаётся видимой. */}
        <div className="lecs-body">{body}</div>
      </div>
    </div>
  );
}

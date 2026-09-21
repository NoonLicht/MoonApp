import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Download, Search, Zap } from "lucide-react";
import { Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { UpModelInfo } from "@/api/types";

/**
 * Селектор модели апскейла вместо системного `<select>`.
 *
 * Список — только названия: он читается как обычное меню и не «разъезжается» от
 * значков. Все подробности модели (скачана ли, размер, лицензия, архитектура,
 * собранный движок и — главное — замеры скорости на этой машине) живут в окне
 * каталога моделей: там их и получают кнопкой «Замерить все модели».
 * Поиск и фильтры остаются здесь: выбрать модель из семидесяти иначе неудобно.
 */
export default function UpscaleModelPicker({
  models,
  value,
  onPick,
  onOpenCatalog,
  noneLabel = "",
}: {
  /** Апскейлеры (интерполяторы выбираются отдельно, в Pro-настройках). */
  models: UpModelInfo[];
  value: string;
  onPick: (id: string) => void;
  /** Переход в каталог моделей: «нет нужной модели» — частая причина открыть его. */
  onOpenCatalog: () => void;
  /** Подпись «Без апскейла» (пусто — такого пункта нет). */
  noneLabel?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  /** 0 — все кратности, иначе ×N. */
  const [scale, setScale] = useState(0);
  const [tag, setTag] = useState("");
  const [onlyReady, setOnlyReady] = useState(false);
  const [onlyTrt, setOnlyTrt] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Клик мимо панели и Esc закрывают список — как у обычного выпадающего меню.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = models.find((m) => m.id === value) || null;
  /** Кратности, которые реально есть в каталоге (лишних кнопок не рисуем). */
  const scales = useMemo(
    () => [...new Set(models.map((m) => m.scale))].sort((a, b) => a - b),
    [models],
  );
  const tags = useMemo(() => [...new Set(models.flatMap((m) => m.tags))], [models]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return models.filter((m) => {
      if (scale && m.scale !== scale) return false;
      if (tag && !m.tags.includes(tag)) return false;
      if (onlyReady && !m.available) return false;
      if (onlyTrt && !m.trtEngine) return false;
      if (!needle) return true;
      return (
        m.label.toLowerCase().includes(needle) ||
        m.id.toLowerCase().includes(needle) ||
        m.arch.toLowerCase().includes(needle)
      );
    });
  }, [models, q, scale, tag, onlyReady, onlyTrt]);

  const trtTitle = (m: UpModelInfo) => `${t("up.mdlTrtHas")} · ${m.trtEngine}`;

  return (
    <div className="up-pick" ref={rootRef}>
      <button
        type="button"
        className={`up-pick-btn${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={current?.label || t("up.model")}
      >
        <span className="up-pick-cur">
          {noneLabel && value === "none" ? (
            <span className="up-pick-cur-name">{noneLabel}</span>
          ) : current ? (
            <>
              <span className="up-pick-cur-name">{current.label}</span>
              {/* Значки в самом селекторе — мелкие иконки без подписей: строка
                  стоит рядом с селектом кратности и не должна его перевешивать. */}
              {current.trtEngine ? (
                <span className="up-pick-mark" title={trtTitle(current)}>
                  <Zap size={12} />
                </span>
              ) : null}
              {!current.available ? (
                <span className="up-pick-mark is-warn" title={t("up.mdlNotDownloaded")}>
                  <Download size={12} />
                </span>
              ) : null}
            </>
          ) : (
            <span className="up-pick-cur-name">{t("up.pickNone")}</span>
          )}
        </span>
        <ChevronDown size={14} />
      </button>

      {open ? (
        <div className="up-pick-pop">
          <div className="up-pick-head">
            <span className="up-pick-search">
              <Search size={13} />
              <input
                className="text-input"
                value={q}
                autoFocus
                placeholder={t("up.pickSearch")}
                onChange={(e) => setQ(e.target.value)}
              />
            </span>
            <span className="muted-sm">
              {t("up.pickFound", { n: list.length, total: models.length })}
            </span>
          </div>

          <div className="up-pick-filters">
            <Badge tone="neutral" active={scale === 0} onClick={() => setScale(0)}>
              {t("up.mdlAll")}
            </Badge>
            {scales.map((s) => (
              <Badge key={s} tone="teal" active={scale === s} onClick={() => setScale(s)}>
                ×{s}
              </Badge>
            ))}
            <span className="up-pick-sep" />
            {tags.map((tg) => (
              <Badge
                key={tg}
                tone="neutral"
                active={tag === tg}
                onClick={() => setTag(tag === tg ? "" : tg)}
              >
                {t(`up.tag_${tg}`)}
              </Badge>
            ))}
            <span className="up-pick-sep" />
            <Badge tone="amber" active={onlyReady} onClick={() => setOnlyReady((v) => !v)}>
              {t("up.pickOnlyReady")}
            </Badge>
            <Badge tone="violet" active={onlyTrt} onClick={() => setOnlyTrt((v) => !v)}>
              <Zap size={11} /> {t("up.pickOnlyTrt")}
            </Badge>
          </div>

          <div className="up-pick-list">
            {noneLabel ? (
              <button
                type="button"
                className={`up-pick-row${value === "none" ? " is-cur" : ""}`}
                onClick={() => {
                  onPick("none");
                  setOpen(false);
                }}
              >
                <span className="up-pick-row-name">
                  {value === "none" ? <Check size={13} /> : null}
                  {noneLabel}
                </span>
              </button>
            ) : null}
            {list.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`up-pick-row${m.id === value ? " is-cur" : ""}${
                  m.available ? "" : " is-missing"
                }`}
                onClick={() => {
                  onPick(m.id);
                  setOpen(false);
                }}
                /* Подробности — в подсказке: список остаётся списком названий. */
                title={m.available ? `${m.id} · ${m.arch}` : t("up.mdlNotDownloaded")}
              >
                <span className="up-pick-row-name">
                  {m.id === value ? <Check size={13} /> : null}
                  {m.label}
                </span>
              </button>
            ))}
            {list.length === 0 ? (
              <div className="muted-sm up-pick-empty">{t("up.pickEmpty")}</div>
            ) : null}
          </div>

          <div className="up-pick-foot">
            <button
              type="button"
              className="up-pick-catalog"
              onClick={() => {
                setOpen(false);
                onOpenCatalog();
              }}
            >
              <Download size={13} /> {t("up.pickCatalog")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

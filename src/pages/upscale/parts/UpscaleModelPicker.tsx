import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Download, Search, Sparkles, Zap } from "lucide-react";
import { Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { UpModelInfo } from "@/api/types";

/**
 * Значок «только для показа»: `Badge` — это `<button>`, а вкладывать кнопку в
 * кнопку (строка выбора — тоже кнопка) нельзя. Классы те же, что у `Badge`.
 */
function Chip({ tone, children, mono }: { tone: string; children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={`badge tone-${tone}`}
      style={mono ? { fontFamily: "var(--font-mono)" } : undefined}
    >
      {children}
    </span>
  );
}

/**
 * Селектор модели апскейла вместо системного `<select>`.
 *
 * Системный список показывал только название: по нему нельзя было понять, скачана
 * ли модель, под какую кратность она обучена и — главное — собрана ли под неё
 * тензорная (TensorRT) версия. Здесь это видно сразу, плюс есть поиск и фильтры,
 * а строки идут в две колонки, когда панель широкая.
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
              <Chip tone="neutral" mono>
                ×{current.scale || current.mult}
              </Chip>
              {current.trtEngine ? (
                <span title={trtTitle(current)}>
                  <Chip tone="violet">
                    <Zap size={11} /> TRT
                  </Chip>
                </span>
              ) : null}
              {!current.available ? <Chip tone="coral">{t("up.mdlNotDownloaded")}</Chip> : null}
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
                <span className="up-pick-row-badges">
                  <Chip tone="neutral" mono>
                    ×1
                  </Chip>
                </span>
                <span className="up-pick-row-tags" />
              </button>
            ) : null}
            {list.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`up-pick-row${m.id === value ? " is-cur" : ""}`}
                onClick={() => {
                  onPick(m.id);
                  setOpen(false);
                }}
                title={`${m.id} · ${m.arch}`}
              >
                <span className="up-pick-row-name">
                  {m.id === value ? (
                    <Check size={13} />
                  ) : m.kind === "interp" ? (
                    <Sparkles size={13} />
                  ) : null}
                  {m.label}
                </span>
                <span className="up-pick-row-badges">
                  <Chip tone="neutral" mono>
                    ×{m.scale}
                  </Chip>
                  {m.trtEngine ? (
                    <span title={trtTitle(m)}>
                      <Chip tone="violet">
                        <Zap size={11} /> TRT
                      </Chip>
                    </span>
                  ) : null}
                  {!m.available ? (
                    <span title={t("up.mdlNotDownloaded")}>
                      <Download size={12} />
                    </span>
                  ) : null}
                  {m.measured ? <span className="up-pick-meas">{m.measured}</span> : null}
                </span>
                <span className="up-pick-row-tags">
                  {/* «без пачки» — граф ждёт ровно один кадр: в Pro-настройках
                      поля пачки для такой модели не показываются. */}
                  {m.batch === 1 ? <span className="up-pick-tag">{t("up.batchNone")}</span> : null}
                  {m.tags.map((tg) => (
                    <span key={tg} className="up-pick-tag">
                      {t(`up.tag_${tg}`)}
                    </span>
                  ))}
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

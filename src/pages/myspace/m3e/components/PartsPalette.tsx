import { useMemo, useState } from "react";
import {
  CATEGORIES,
  KIND_ORDER,
  KIND_SPEC,
  PALETTE_HIDDEN,
  Category,
  Kind,
  Palette,
} from "@/pages/myspace/m3e/lib/tokens";
import { Icon } from "@/pages/myspace/m3e/components/M3Node";
import { t, useLang, nounOf, isRuUi } from "@/pages/myspace/m3e/lib/i18n";
import { RU_CATEGORY } from "@/pages/myspace/m3e/lib/ru";
import { Field, Section, Tile } from "@/pages/myspace/m3e/components/ui";
import { ElementStudio, PresetTiles } from "@/pages/myspace/m3e/components/ElementLibrary";
import type { CustomSpec } from "@/pages/myspace/m3e/lib/custom";
import type { AiSettings } from "@/pages/myspace/m3e/lib/ai";

const CATEGORY_TEXT = {
  ja: {
    actions: "操作",
    navigation: "ナビゲーション",
    containment: "コンテナ",
    inputs: "入力",
    content: "コンテンツ",
    progress: "進捗",
  },
  zh: {
    actions: "操作",
    navigation: "导航",
    containment: "容器",
    inputs: "输入",
    content: "内容",
    progress: "进度",
  },
  ko: {
    actions: "동작",
    navigation: "내비게이션",
    containment: "컨테이너",
    inputs: "입력",
    content: "콘텐츠",
    progress: "진행 상태",
  },
} satisfies Record<string, Record<Category, string>>;

export function PartsPalette({
  palette: p,
  favorites,
  onToggleFavorite,
  onPartPointerDown,
  onPartActivate,
  ai,
  mine,
  onSaveCustom,
  onRemoveCustom,
  onCustomAdd,
  onCustomDown,
}: {
  palette: Palette;
  favorites: Kind[];
  onToggleFavorite: (k: Kind) => void;
  onPartPointerDown: (e: React.PointerEvent, kind: Kind) => void;
  /** a tile chosen with the keyboard or a screen reader adds its part without a drag */
  onPartActivate: (kind: Kind) => void;
  ai: AiSettings;
  mine: CustomSpec[];
  onSaveCustom: (spec: CustomSpec) => void;
  onRemoveCustom: (i: number) => void;
  onCustomAdd: (spec: CustomSpec) => void;
  onCustomDown: (e: React.PointerEvent, spec: CustomSpec) => void;
}) {
  const lang = useLang();
  const [q, setQ] = useState("");
  const labelOf = (k: Kind) =>
    lang === "en" && !isRuUi() ? KIND_SPEC[k].label : nounOf(lang, k, KIND_SPEC[k].label);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    /* the shapes a part switches into in its own panel are not tiles of their own */
    const listed = KIND_ORDER.filter((k) => !PALETTE_HIDDEN.includes(k));
    if (!s) return listed;
    return listed.filter((k) => {
      const sp = KIND_SPEC[k];
      return (
        labelOf(k).toLowerCase().includes(s) ||
        sp.label.toLowerCase().includes(s) ||
        sp.noun.toLowerCase().includes(s) ||
        k.toLowerCase().includes(s)
      );
    });
  }, [q, lang]);

  const tile = (k: Kind) => {
    const s = KIND_SPEC[k];
    return (
      <Tile
        key={k}
        icon={s.paletteIcon}
        label={labelOf(k)}
        p={p}
        onPointerDown={(e) => onPartPointerDown(e, k)}
        onClick={() => onPartActivate(k)}
        starred={favorites.includes(k)}
        onStar={() => onToggleFavorite(k)}
      />
    );
  };

  const grid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(78px, 1fr))",
    gap: 6,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      <div style={{ padding: "12px 12px 8px" }}>
        <Field
          value={q}
          onChange={setQ}
          placeholder={t("search", lang)}
          p={p}
          icon="search"
          height={40}
        />
      </div>

      <div
        className="no-scrollbar"
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "0 8px" }}
      >
        {!q && favorites.length > 0 && (
          <Section id="fav" icon="star" title={t("favorites", lang)} p={p}>
            <div style={grid}>
              {favorites.filter((k) => KIND_SPEC[k] && !PALETTE_HIDDEN.includes(k)).map(tile)}
            </div>
          </Section>
        )}
        {q ? (
          <div style={{ ...grid, padding: "4px 4px 12px" }}>
            {filtered.map(tile)}
            {filtered.length === 0 && (
              <div
                role="status"
                style={{
                  gridColumn: "1 / -1",
                  color: p.outline,
                  fontSize: 13,
                  padding: 12,
                  textAlign: "center",
                  display: "grid",
                  placeItems: "center",
                  gap: 6,
                }}
              >
                <Icon name="search_off" size={28} />
                <span>{t("noMatch", lang)}</span>
              </div>
            )}
          </div>
        ) : (
          CATEGORIES.map((c) => (
            <Section
              key={c.key}
              id={`cat:${c.key}`}
              icon={c.icon}
              title={
                isRuUi() ? RU_CATEGORY[c.key] : lang === "en" ? c.label : CATEGORY_TEXT[lang][c.key]
              }
              p={p}
            >
              <div style={grid}>
                {KIND_ORDER.filter(
                  (k) => KIND_SPEC[k].category === c.key && !PALETTE_HIDDEN.includes(k),
                ).map(tile)}
              </div>
              <PresetTiles category={c.key} p={p} onAdd={onCustomAdd} onDown={onCustomDown} />
            </Section>
          ))
        )}
        {!q && (
          <ElementStudio
            p={p}
            ai={ai}
            mine={mine}
            onSave={onSaveCustom}
            onRemove={onRemoveCustom}
            onAdd={onCustomAdd}
            onDown={onCustomDown}
          />
        )}
      </div>
    </div>
  );
}

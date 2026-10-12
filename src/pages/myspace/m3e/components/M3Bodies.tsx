import {
  Item,
  NAV_BAR_H,
  Palette,
  CARD_MEDIA_GAP,
  CARD_PADDING,
  CARD_TEXT_GAP,
  cardContentAlignOf,
  cardTextAlignOf,
  cardImagePosOf,
  cardImageSizeOf,
  cardBodyColorOf,
  cardScrimOf,
  cardTextColorOf,
  scaleR,
  sizeOf,
  RAIL_TOP,
  RAIL_W,
  RAIL_ITEM_H,
  RAIL_GAP,
  isWideRail,
  railMetrics,
  isScrollableTabs,
  tabScrollOffset,
  SCROLL_TAB_W,
  TOP_BAR_SIZES,
  topBarHeightOf,
  topBarFontOf,
} from "@/pages/myspace/m3e/lib/tokens";
import { useLang } from "@/pages/myspace/m3e/lib/i18n";
import { railSelectedLabelColor } from "@/pages/myspace/m3e/lib/color";
import { Icon } from "@/pages/myspace/m3e/components/M3Ripple";
import { ellipsis } from "@/pages/myspace/m3e/components/M3Content";

export interface BodyProps {
  item: Item;
  p: Palette;
  lang: ReturnType<typeof useLang>;
  w: (normal: number, strong: number) => number;
  hasLabel: boolean;
  hasSupporting: boolean;
  tabScroll?: number;
  menuShown?: boolean;
}

/** Содержимое части «topAppBar» (вынесено из Body в M3Node). */
export function TopAppBarBody(props: BodyProps) {
  const { item, p, w } = props;
  {
    /* the small bar keeps its title between the icons; the medium and large ones let it down
     onto a line of its own at the foot, the way M3's flexible bars do */
    const barH = topBarHeightOf(item);
    const tall = barH > TOP_BAR_SIZES[0].h;
    const font = topBarFontOf(item);
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          /* the inset the bar has, if any (see sizeOf) */
          padding: `${sizeOf(item, {}).h - barH}px 0 0`,
          height: "100%",
          boxSizing: "border-box",
          position: "relative",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 4px",
            height: 64,
            flex: "0 0 auto",
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              display: "grid",
              placeItems: "center",
              flex: "0 0 auto",
            }}
          >
            {item.icon && <Icon name={item.icon} size={24} color={p.onSurface} />}
          </div>
          <div
            className="m3-size-ease"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: tall ? 0 : font,
              opacity: tall ? 0 : 1,
              fontWeight: w(400, 600),
              color: p.onSurface,
              transition: "opacity 200ms",
              ...ellipsis,
            }}
          >
            {item.label}
          </div>
          <div
            style={{
              width: 48,
              height: 48,
              display: "grid",
              placeItems: "center",
              flex: "0 0 auto",
            }}
          >
            {item.icon2 && <Icon name={item.icon2} size={24} color={p.onSurfaceVariant} />}
          </div>
        </div>
        {tall && (
          <div
            className="m3-size-ease"
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "flex-end",
              padding: "0 16px 24px",
              fontSize: font,
              lineHeight: 1.2,
              fontWeight: w(400, 600),
              color: p.onSurface,
              ...ellipsis,
            }}
          >
            {item.label}
          </div>
        )}
      </div>
    );
  }
}

/** Содержимое части «card» (вынесено из Body в M3Node). */
export function CardBody(props: BodyProps) {
  const { item, p, w, hasLabel, hasSupporting } = props;
  {
    const pos = cardImagePosOf(item);
    const hasImage = !item.noImage;
    const padding = CARD_PADDING;
    const align = cardContentAlignOf(item);
    const justifyContent = { start: "flex-start", center: "center", end: "flex-end" }[
      align
    ] as React.CSSProperties["justifyContent"];
    const across = cardTextAlignOf(item);
    const alignItems = { start: "flex-start", center: "center", end: "flex-end" }[
      across
    ] as React.CSSProperties["alignItems"];
    const textAlign = { start: "start", center: "center", end: "end" }[
      across
    ] as React.CSSProperties["textAlign"];
    const ink = cardTextColorOf(item, p);
    const body = cardBodyColorOf(item, p);
    const picture = item.src ? (
      <img
        src={item.src}
        alt=""
        draggable={false}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
    ) : (
      item.icon && <Icon name={item.icon} size={34} />
    );
    const media = (style: React.CSSProperties) => (
      <div
        style={{
          borderRadius: scaleR(14),
          background: p.primaryContainer,
          color: p.onPrimaryContainer,
          display: "grid",
          placeItems: "center",
          flex: "0 0 auto",
          overflow: "hidden",
          ...style,
        }}
      >
        {picture}
      </div>
    );
    const text = (
      /* the column may shrink under a large picture: what does not fit is clipped, never pushed out of the card */
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          gap: CARD_TEXT_GAP,
          justifyContent,
          alignItems,
          textAlign,
        }}
      >
        {hasLabel && (
          <div
            style={{
              fontSize: 16,
              fontWeight: w(600, 700),
              color: ink,
              maxWidth: "100%",
              ...ellipsis,
            }}
          >
            {item.label}
          </div>
        )}
        {hasSupporting && (
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              color: body.color,
              opacity: body.opacity,
              overflow: "hidden",
            }}
          >
            {item.supporting}
          </div>
        )}
      </div>
    );
    if (hasImage && pos === "background") {
      /* Full-bleed media behind the text. A photo, or a chosen text color that the placeholder's
       * container may not carry, gets a scrim on the text's side: dark under light text, light under dark. */
      const scrim = item.src || item.textColor ? cardScrimOf(ink, align) : undefined;
      return (
        <div style={{ position: "relative", height: "100%", boxSizing: "border-box" }}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: p.primaryContainer,
              color: p.onPrimaryContainer,
              display: "grid",
              placeItems: "center",
            }}
          >
            {picture}
          </div>
          {scrim && <div style={{ position: "absolute", inset: 0, background: scrim }} />}
          <div
            style={{
              position: "relative",
              height: "100%",
              boxSizing: "border-box",
              padding,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {text}
          </div>
        </div>
      );
    }
    /* top / bottom: the image band above or under the text; leading / trailing: a full-height column beside it */
    const side = hasImage && (pos === "leading" || pos === "trailing");
    const after = pos === "trailing" || pos === "bottom";
    return (
      <div
        style={{
          padding,
          height: "100%",
          display: "flex",
          flexDirection: side ? "row" : "column",
          gap: CARD_MEDIA_GAP,
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      >
        {hasImage &&
          !after &&
          media(
            side
              ? { width: cardImageSizeOf(item), alignSelf: "stretch" }
              : { height: cardImageSizeOf(item) },
          )}
        {text}
        {hasImage &&
          after &&
          media(
            side
              ? { width: cardImageSizeOf(item), alignSelf: "stretch" }
              : { height: cardImageSizeOf(item) },
          )}
      </div>
    );
  }
}

/** Содержимое части «textField» (вынесено из Body в M3Node). */
export function TextFieldBody(props: BodyProps) {
  const { item, p, hasLabel, hasSupporting } = props;
  {
    const filled = item.variant === "filled";
    return (
      <div style={{ position: "relative", height: "100%" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 16px",
            height: "100%",
          }}
        >
          {item.icon && <Icon name={item.icon} size={24} color={p.onSurfaceVariant} />}
          <span
            style={{ flex: 1, minWidth: 0, fontSize: 16, color: p.onSurfaceVariant, ...ellipsis }}
          >
            {filled ? "" : ""}
          </span>
        </div>
        {hasLabel && (
          <span
            style={{
              position: "absolute",
              left: item.icon ? 52 : 16,
              top: filled ? 8 : -8,
              fontSize: 12,
              lineHeight: "16px",
              color: p.primary,
              background: filled ? "transparent" : p.surface,
              padding: filled ? 0 : "0 4px",
              marginLeft: filled ? 0 : -4,
            }}
          >
            {item.label}
          </span>
        )}
        {filled && (
          <span
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 2,
              background: p.primary,
            }}
          />
        )}
        {hasSupporting && (
          <span
            style={{
              position: "absolute",
              left: 16,
              top: "100%",
              marginTop: 4,
              fontSize: 12,
              color: p.onSurfaceVariant,
              whiteSpace: "nowrap",
            }}
          >
            {item.supporting}
          </span>
        )}
      </div>
    );
  }
}

/** Содержимое части «select» (вынесено из Body в M3Node). */
export function SelectBody(props: BodyProps) {
  const { item, p, hasLabel, hasSupporting } = props;
  {
    /* a closed dropdown: the chosen option is the value and the label floats; with
     * nothing chosen the label sits in the field */
    const filled = item.variant === "filled";
    const value = item.selected === undefined ? undefined : item.tabs?.[item.selected]?.label;
    return (
      <div style={{ position: "relative", height: "100%" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 12px 0 16px",
            height: "100%",
          }}
        >
          {item.icon && <Icon name={item.icon} size={24} color={p.onSurfaceVariant} />}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 16,
              color: value ? p.onSurface : p.onSurfaceVariant,
              paddingTop: value && filled ? 16 : 0,
              ...ellipsis,
            }}
          >
            {value ?? item.label}
          </span>
          <Icon name="arrow_drop_down" size={24} color={p.onSurfaceVariant} />
        </div>
        {value && hasLabel && (
          <span
            style={{
              position: "absolute",
              left: item.icon ? 52 : 16,
              top: filled ? 8 : -8,
              fontSize: 12,
              lineHeight: "16px",
              color: p.onSurfaceVariant,
              background: filled ? "transparent" : p.surface,
              padding: filled ? 0 : "0 4px",
              marginLeft: filled ? 0 : -4,
            }}
          >
            {item.label}
          </span>
        )}
        {filled && (
          <span
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 1,
              background: p.onSurfaceVariant,
            }}
          />
        )}
        {hasSupporting && (
          <span
            style={{
              position: "absolute",
              left: 16,
              top: "100%",
              marginTop: 4,
              fontSize: 12,
              color: p.onSurfaceVariant,
              whiteSpace: "nowrap",
            }}
          >
            {item.supporting}
          </span>
        )}
      </div>
    );
  }
}

/** Содержимое части «slider» (вынесено из Body в M3Node). */
export function SliderBody(props: BodyProps) {
  const { item, p } = props;
  {
    const v = Math.min(100, Math.max(0, item.value ?? 40)) / 100;
    const w = item.size ?? 280;
    const handleX = 2 + (w - 4) * v;
    return (
      <div style={{ position: "relative", height: "100%" }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            width: Math.max(0, handleX - 8),
            top: 14,
            height: 16,
            borderRadius: "8px 2px 2px 8px",
            background: p.primary,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: handleX + 8,
            right: 0,
            top: 14,
            height: 16,
            borderRadius: "2px 8px 8px 2px",
            background: p.secondaryContainer,
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 6,
            top: 20,
            width: 4,
            height: 4,
            borderRadius: 2,
            background: p.onSecondaryContainer,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: handleX - 2,
            top: 0,
            width: 4,
            height: 44,
            borderRadius: 2,
            background: p.primary,
          }}
        />
      </div>
    );
  }
}

/** Содержимое части «navRail» (вынесено из Body в M3Node). */
export function NavRailBody(props: BodyProps) {
  const { item, p, w } = props;
  {
    const tabs = item.tabs ?? [];
    const wide = isWideRail(item);
    const expanded = !!item.railExpanded;
    const rail = railMetrics(item);
    if (wide)
      return (
        <div style={{ position: "relative", height: "100%" }}>
          <div
            className="m3-rail-geometry"
            style={{
              position: "absolute",
              left: rail.headerLeft,
              top: RAIL_TOP,
              width: 48,
              height: 48,
              display: "grid",
              placeItems: "center",
              color: p.onSurfaceVariant,
            }}
          >
            <Icon name={expanded ? "menu_open" : "menu"} size={24} />
          </div>
          {tabs.map((tab, i) => {
            const on = i === Math.min(item.selected ?? 0, Math.max(0, tabs.length - 1));
            return (
              <div
                key={i}
                className="m3-rail-geometry"
                style={{
                  position: "absolute",
                  left: rail.inset,
                  top: rail.top + i * (rail.itemHeight + rail.gap),
                  width: rail.width - rail.inset * 2,
                  height: rail.itemHeight,
                }}
              >
                <div
                  className="m3-rail-geometry"
                  style={{
                    position: "absolute",
                    left: expanded ? 0 : 8,
                    top: 0,
                    width: expanded ? rail.width - rail.inset * 2 : 56,
                    height: expanded ? 56 : 32,
                    borderRadius: expanded ? 28 : 16,
                    background: on ? p.secondaryContainer : "transparent",
                  }}
                />
                <div
                  className="m3-rail-geometry"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: 24,
                    height: 24,
                    transform: `translate(${expanded ? 16 : 24}px, ${expanded ? 16 : 4}px)`,
                    color: on ? p.onSecondaryContainer : p.onSurfaceVariant,
                  }}
                >
                  {tab.icon && <Icon name={tab.icon} size={24} fill={on} />}
                </div>
                {tab.label.trim() && (
                  <span
                    className="m3-rail-geometry"
                    style={{
                      position: "absolute",
                      left: expanded ? 48 : 0,
                      top: expanded ? 18 : 36,
                      width: expanded ? rail.width - 88 : 72,
                      textAlign: expanded ? "left" : "center",
                      fontSize: expanded ? 14 : 12,
                      lineHeight: "20px",
                      fontWeight: on ? w(600, 700) : w(400, 500),
                      color: on ? railSelectedLabelColor(p, expanded) : p.onSurfaceVariant,
                      ...ellipsis,
                    }}
                  >
                    {tab.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      );
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: RAIL_GAP,
          height: "100%",
          padding: `${RAIL_TOP}px 0`,
          boxSizing: "border-box",
          position: "relative",
        }}
      >
        {tabs.map((t, i) => {
          const on = i === Math.min(item.selected ?? 0, Math.max(0, tabs.length - 1));
          const withLabel = t.label.trim().length > 0;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                width: RAIL_W - 12,
                height: RAIL_ITEM_H,
                flex: "0 0 auto",
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 32,
                  borderRadius: scaleR(16),
                  display: "grid",
                  placeItems: "center",
                  background: on ? p.secondaryContainer : "transparent",
                  color: on ? p.onSecondaryContainer : p.onSurfaceVariant,
                  transition: "background 160ms, color 160ms",
                }}
              >
                {t.icon && <Icon name={t.icon} size={22} fill={on} />}
              </div>
              {withLabel && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: on ? w(600, 700) : w(400, 500),
                    color: on ? p.onSurface : p.onSurfaceVariant,
                    maxWidth: "100%",
                    ...ellipsis,
                  }}
                >
                  {t.label}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }
}

/** Содержимое части «bottomNav» (вынесено из Body в M3Node). */
export function BottomNavBody(props: BodyProps) {
  const { item, p, w } = props;
  {
    const tabs = item.tabs ?? [];
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-around",
          height: "100%",
          padding: `0 4px ${NAV_BAR_H}px`,
          boxSizing: "border-box",
          position: "relative",
        }}
      >
        {tabs.map((t, i) => {
          const on = i === Math.min(item.selected ?? 0, Math.max(0, tabs.length - 1));
          const withLabel = t.label.trim().length > 0;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                flex: 1,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 32,
                  borderRadius: scaleR(16),
                  display: "grid",
                  placeItems: "center",
                  background: on ? p.secondaryContainer : "transparent",
                  color: on ? p.onSecondaryContainer : p.onSurfaceVariant,
                  transition: "background 160ms, color 160ms",
                }}
              >
                {t.icon && <Icon name={t.icon} size={22} fill={on} />}
              </div>
              {withLabel && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: on ? w(600, 700) : w(400, 500),
                    color: on ? p.onSurface : p.onSurfaceVariant,
                    maxWidth: "100%",
                    ...ellipsis,
                  }}
                >
                  {t.label}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }
}

/** Содержимое части «tabs» (вынесено из Body в M3Node). */
export function TabsBody(props: BodyProps) {
  const { item, p, w, tabScroll } = props;
  {
    const tabs = item.tabs ?? [];
    const scroll = isScrollableTabs(item);
    const offset = tabScroll ?? tabScrollOffset(item, sizeOf(item, {}).w);
    return (
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          height: "100%",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {tabs.map((tab, i) => {
          const on = i === Math.min(item.selected ?? 0, Math.max(0, tabs.length - 1));
          return (
            <div
              key={i}
              style={{
                flex: scroll ? "none" : 1,
                width: scroll ? SCROLL_TAB_W : undefined,
                marginLeft: scroll && i === 0 ? -offset : undefined,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "flex-end",
                position: "relative",
                padding: "0 8px",
              }}
            >
              <span
                style={{
                  fontSize: 14,
                  fontWeight: w(500, 700),
                  color: on ? p.primary : p.onSurfaceVariant,
                  padding: "0 4px 14px",
                  maxWidth: "100%",
                  ...ellipsis,
                }}
              >
                {tab.label}
              </span>
              {on && (
                <span
                  style={{
                    position: "absolute",
                    left: "50%",
                    bottom: 0,
                    transform: "translateX(-50%)",
                    width: `calc(100% - 24px)`,
                    height: 3,
                    borderTopLeftRadius: 3,
                    borderTopRightRadius: 3,
                    background: p.primary,
                  }}
                />
              )}
            </div>
          );
        })}
        <span
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 1,
            background: p.outlineVariant,
          }}
        />
      </div>
    );
  }
}

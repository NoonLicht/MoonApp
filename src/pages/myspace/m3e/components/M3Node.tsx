import { useMemo } from "react";
import { CustomBody } from "@/pages/myspace/m3e/components/CustomNode";
import { motion, useReducedMotion } from "motion/react";
import {
  Item,
  MEASURED,
  Palette,
  Radii,
  SPLIT_MAIN_SLOT,
  SPLIT_MENU_SLOT,
  baseRadii,
  buttonHeightOf,
  fabOpen,
  isMeasured,
  menuOpen,
  buttonMetrics,
  cardFillOf,
  dateLayoutOf,
  onToken,
  scaleR,
  sizeOf,
  splitMetrics,
  variantShadow,
  variantStyle,
  SETTLE_MS,
  progressThickness,
  isWideRail,
  RIPPLE_KINDS,
} from "@/pages/myspace/m3e/lib/tokens";
import {
  CircularProgress,
  LinearProgress,
  LoadingIndicator,
} from "@/pages/myspace/m3e/components/Loading";
import {
  CarouselBody,
  DatePickerBody,
  TimePickerBody,
} from "@/pages/myspace/m3e/components/Pickers";
import { t, useLang } from "@/pages/myspace/m3e/lib/i18n";

import {
  useWeight,
  Icon,
  type Ripple,
  RIPPLE_GROW,
  rippleSize,
  RippleCtx,
  RippleShape,
  useRipples,
} from "@/pages/myspace/m3e/components/M3Ripple";
import {
  ellipsis,
  NO_BOX,
  SwitchControl,
  SplitMenuContent,
  MeasuredContent,
} from "@/pages/myspace/m3e/components/M3Content";
import { useMenuPhase, FabMenuContent } from "@/pages/myspace/m3e/components/M3Menu";
import {
  TopAppBarBody,
  CardBody,
  TextFieldBody,
  SelectBody,
  SliderBody,
  NavRailBody,
  BottomNavBody,
  TabsBody,
} from "@/pages/myspace/m3e/components/M3Bodies";
export { Icon, RIPPLE_GROW, rippleSize, Ripples } from "@/pages/myspace/m3e/components/M3Ripple";
export type { Ripple } from "@/pages/myspace/m3e/components/M3Ripple";
export { ButtonContent, MeasuredContent } from "@/pages/myspace/m3e/components/M3Content";
export { menuShutMs } from "@/pages/myspace/m3e/components/M3Menu";

function Body({
  item,
  p,
  tabScroll,
  menuShown,
}: {
  item: Item;
  p: Palette;
  tabScroll?: number;
  menuShown?: boolean;
}) {
  const lang = useLang();
  const w = useWeight();
  const hasLabel = item.label.trim().length > 0;
  const hasSupporting = !!item.supporting?.trim();

  if (menuOpen(item))
    return item.kind === "splitButton" ? (
      <SplitMenuContent item={item} p={p} shown={menuShown} />
    ) : (
      <FabMenuContent item={item} p={p} shown={menuShown} />
    );
  if (MEASURED.includes(item.kind)) return <MeasuredContent item={item} p={p} />;

  switch (item.kind) {
    case "bottomSheet":
      return (
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 16 }}>
          <div
            style={{
              width: 32,
              height: 4,
              borderRadius: 2,
              background: onToken(item.fill ?? "surfaceContainerLow", p),
              opacity: 0.4,
            }}
          />
        </div>
      );

    case "iconButton":
      /* the icon is the one the M3 size the circle lands on asks for */
      return (
        <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
          {item.icon && (
            <Icon
              name={item.icon}
              size={buttonMetrics(buttonHeightOf(item)).icon}
              fill={item.variant === "filled"}
            />
          )}
        </div>
      );

    case "fab": {
      const s = item.size ?? 56;
      return (
        <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
          {item.icon && <Icon name={item.icon} size={Math.round(s * 0.42)} />}
        </div>
      );
    }

    case "topAppBar":
      return (
        <TopAppBarBody
          item={item}
          p={p}
          lang={lang}
          w={w}
          hasLabel={hasLabel}
          hasSupporting={hasSupporting}
          tabScroll={tabScroll}
          menuShown={menuShown}
        />
      );

    case "searchBar":
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 16px",
            height: "100%",
          }}
        >
          {item.icon && <Icon name={item.icon} size={24} color={p.onSurface} />}
          <div
            style={{ flex: 1, minWidth: 0, fontSize: 16, color: p.onSurfaceVariant, ...ellipsis }}
          >
            {item.label}
          </div>
          {item.icon2 && <Icon name={item.icon2} size={24} color={p.onSurfaceVariant} />}
        </div>
      );

    case "card":
      return (
        <CardBody
          item={item}
          p={p}
          lang={lang}
          w={w}
          hasLabel={hasLabel}
          hasSupporting={hasSupporting}
          tabScroll={tabScroll}
          menuShown={menuShown}
        />
      );

    case "listItem": {
      const iconBg = item.iconFill === "none" ? null : (item.iconFill ?? "primaryContainer");
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "0 16px",
            height: "100%",
          }}
        >
          {item.icon && (
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                background: iconBg ? p[iconBg] : "transparent",
                color: iconBg ? onToken(iconBg, p) : onToken(item.fill ?? "surfaceContainerLow", p),
                display: "grid",
                placeItems: "center",
                flex: "0 0 auto",
              }}
            >
              <Icon name={item.icon} size={22} />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            {hasLabel && (
              <div style={{ fontSize: 16, color: p.onSurface, ...ellipsis }}>{item.label}</div>
            )}
            {hasSupporting && (
              <div style={{ fontSize: 13, color: p.onSurfaceVariant, ...ellipsis }}>
                {item.supporting}
              </div>
            )}
          </div>
          {item.switch ? (
            <SwitchControl on={!!item.checked} p={p} />
          ) : (
            item.icon2 && <Icon name={item.icon2} size={22} color={p.onSurfaceVariant} />
          )}
        </div>
      );
    }

    case "dialog":
      return (
        <div
          style={{
            padding: 24,
            height: "100%",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {item.icon && (
            <div style={{ textAlign: "center", color: p.primary }}>
              <Icon name={item.icon} size={24} />
            </div>
          )}
          {hasLabel && (
            <div
              style={{
                fontSize: 24,
                fontWeight: w(400, 600),
                color: p.onSurface,
                textAlign: item.icon ? "center" : "left",
                ...ellipsis,
              }}
            >
              {item.label}
            </div>
          )}
          {hasSupporting && (
            <div
              style={{
                fontSize: 14,
                lineHeight: 1.5,
                color: p.onSurfaceVariant,
                flex: 1,
                overflow: "hidden",
              }}
            >
              {item.supporting}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {[t("cancel", lang), t("ok", lang)].map((t) => (
              <span
                key={t}
                style={{
                  padding: "0 12px",
                  height: 40,
                  display: "inline-flex",
                  alignItems: "center",
                  color: p.primary,
                  fontSize: 14,
                  fontWeight: 500,
                }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      );

    case "snackbar":
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 8px 0 16px",
            height: "100%",
          }}
        >
          <div
            style={{ flex: 1, minWidth: 0, fontSize: 14, color: p.inverseOnSurface, ...ellipsis }}
          >
            {item.label}
          </div>
          {hasSupporting && (
            <span
              style={{
                padding: "0 12px",
                height: 36,
                display: "inline-flex",
                alignItems: "center",
                color: p.inversePrimary,
                fontSize: 14,
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {item.supporting}
            </span>
          )}
        </div>
      );

    case "textField":
      return (
        <TextFieldBody
          item={item}
          p={p}
          lang={lang}
          w={w}
          hasLabel={hasLabel}
          hasSupporting={hasSupporting}
          tabScroll={tabScroll}
          menuShown={menuShown}
        />
      );

    case "select":
      return (
        <SelectBody
          item={item}
          p={p}
          lang={lang}
          w={w}
          hasLabel={hasLabel}
          hasSupporting={hasSupporting}
          tabScroll={tabScroll}
          menuShown={menuShown}
        />
      );

    case "slider":
      return (
        <SliderBody
          item={item}
          p={p}
          lang={lang}
          w={w}
          hasLabel={hasLabel}
          hasSupporting={hasSupporting}
          tabScroll={tabScroll}
          menuShown={menuShown}
        />
      );

    case "image":
      if (item.src) {
        return (
          <img
            src={item.src}
            alt=""
            draggable={false}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        );
      }
      return (
        <div style={{ display: "grid", placeItems: "center", height: "100%", color: p.outline }}>
          {item.icon && (
            <Icon name={item.icon} size={Math.min(48, Math.round((item.size ?? 200) * 0.3))} />
          )}
        </div>
      );

    case "camera":
      /* a viewfinder: the live feed is dark, with focus brackets and a shutter row. The body
         paints the dark ground itself, on a layer of its own, so a box resized in a hurry never
         shows the screen through it while the clipped box behind it catches up. */
      return (
        <div
          style={{
            position: "relative",
            height: "100%",
            color: p.inverseOnSurface,
            background: p.inverseSurface,
            transform: "translateZ(0)",
          }}
        >
          {(["left", "right"] as const).map((side) =>
            (["top", "bottom"] as const).map((edge) => (
              <div
                key={`${side}-${edge}`}
                style={{
                  position: "absolute",
                  [side]: 24,
                  [edge]: 24,
                  width: 28,
                  height: 28,
                  opacity: 0.7,
                  [`border${side === "left" ? "Left" : "Right"}`]: `3px solid ${p.inverseOnSurface}`,
                  [`border${edge === "top" ? "Top" : "Bottom"}`]: `3px solid ${p.inverseOnSurface}`,
                  [`border${edge === "top" ? "Top" : "Bottom"}${side === "left" ? "Left" : "Right"}Radius`]: 6,
                }}
              />
            )),
          )}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              opacity: 0.5,
            }}
          >
            {item.icon && <Icon name={item.icon} size={40} />}
          </div>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 20,
              display: "grid",
              placeItems: "center",
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                border: `4px solid ${p.inverseOnSurface}`,
                display: "grid",
                placeItems: "center",
              }}
            >
              <div
                style={{ width: 48, height: 48, borderRadius: 24, background: p.inverseOnSurface }}
              />
            </div>
          </div>
        </div>
      );

    case "map":
      /* a stylised city: blocks on a light ground, two main roads and a river, one pin. Painted
         on its own layer, like the camera, so a quick resize never leaves it see-through. */
      return (
        <div
          style={{
            position: "relative",
            height: "100%",
            overflow: "hidden",
            background: p.surfaceContainerLow,
            transform: "translateZ(0)",
          }}
        >
          <svg
            width="100%"
            height="100%"
            viewBox="0 0 400 300"
            preserveAspectRatio="xMidYMid slice"
            style={{ position: "absolute", inset: 0 }}
            aria-hidden
          >
            <rect width="400" height="300" fill={p.surfaceContainerLow} />
            <path
              d="M-20 210 C 80 170, 140 260, 240 220 S 380 150, 430 190 L 430 240 C 380 200, 300 260, 240 250 S 120 230, -20 250 Z"
              fill={p.primaryContainer}
              opacity={0.6}
            />
            {[
              [20, 20, 90, 60],
              [130, 20, 110, 60],
              [260, 20, 120, 60],
              [20, 100, 90, 70],
              [130, 100, 60, 70],
              [210, 100, 170, 70],
              [20, 190, 60, 40],
              [300, 200, 80, 30],
            ].map(([x, y, w, h], i) => (
              <rect
                key={i}
                x={x}
                y={y}
                width={w}
                height={h}
                rx={6}
                fill={p.surfaceContainerHighest}
              />
            ))}
            <path
              d="M0 90 H400 M110 0 V300 M250 0 V300"
              stroke={p.surface}
              strokeWidth={10}
              fill="none"
            />
            <path
              d="M0 90 H400 M110 0 V300 M250 0 V300"
              stroke={p.outlineVariant}
              strokeWidth={1}
              fill="none"
              opacity={0.6}
            />
            <g transform="translate(200 150)">
              <path
                d="M0 24 C -14 6, -20 -2, -20 -12 A 20 20 0 0 1 20 -12 C 20 -2, 14 6, 0 24 Z"
                fill={p.primary}
              />
              <circle cx="0" cy="-12" r="7" fill={p.onPrimary} />
            </g>
          </svg>
        </div>
      );

    case "custom":
      return <CustomBody node={item.node} p={p} />;

    case "banner":
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "0 8px 0 16px",
            height: "100%",
          }}
        >
          {item.icon && <Icon name={item.icon} size={24} color={p.primary} />}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 14,
              lineHeight: "20px",
              color: p.onSurface,
              ...ellipsis,
            }}
          >
            {item.label}
          </div>
          {hasSupporting && (
            <span
              style={{
                padding: "0 12px",
                height: 40,
                display: "inline-flex",
                alignItems: "center",
                color: p.primary,
                fontSize: 14,
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {item.supporting}
            </span>
          )}
        </div>
      );

    case "avatar": {
      const d = item.size ?? 40;
      return (
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: "100%",
            height: "100%",
            overflow: "hidden",
            fontSize: Math.round(d * 0.4),
            fontWeight: 500,
          }}
        >
          {item.src ? (
            <img
              src={item.src}
              alt=""
              draggable={false}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : item.icon ? (
            <Icon name={item.icon} size={Math.round(d * 0.6)} />
          ) : (
            <span>{item.label.trim().slice(0, 2)}</span>
          )}
        </div>
      );
    }

    case "segmentedButton": {
      const tabs = item.tabs ?? [];
      const sel = Math.min(item.selected ?? 0, Math.max(0, tabs.length - 1));
      return (
        <div
          style={{
            display: "flex",
            height: "100%",
            borderRadius: "inherit",
            border: `1px solid ${p.outline}`,
            overflow: "hidden",
            boxSizing: "border-box",
          }}
        >
          {tabs.map((tab, i) => {
            const on = i === sel;
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "0 8px",
                  background: on ? p.secondaryContainer : "transparent",
                  color: on ? p.onSecondaryContainer : p.onSurface,
                  borderLeft: i > 0 ? `1px solid ${p.outline}` : "none",
                  fontSize: 14,
                  fontWeight: 500,
                }}
              >
                {on ? (
                  <Icon name="check" size={18} />
                ) : tab.icon ? (
                  <Icon name={tab.icon} size={18} />
                ) : null}
                <span style={{ ...ellipsis }}>{tab.label}</span>
              </div>
            );
          })}
        </div>
      );
    }

    case "tooltip":
      return hasSupporting ? (
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
          {hasLabel && (
            <div
              style={{
                fontSize: 14,
                fontWeight: 500,
                lineHeight: "20px",
                color: p.onSurfaceVariant,
              }}
            >
              {item.label}
            </div>
          )}
          <div style={{ fontSize: 14, lineHeight: "20px", color: p.onSurfaceVariant }}>
            {item.supporting}
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: "100%",
            padding: "0 8px",
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: 0.5,
            ...ellipsis,
          }}
        >
          {item.label}
        </div>
      );

    case "menu": {
      const tabs = item.tabs ?? [];
      return (
        <div style={{ padding: "8px 0" }}>
          {tabs.map((tab, i) => {
            const on = i === item.selected;
            return (
              <div
                key={i}
                style={{
                  height: 48,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "0 12px",
                  background: on ? p.secondaryContainer : "transparent",
                  color: on ? p.onSecondaryContainer : p.onSurface,
                  fontSize: 16,
                }}
              >
                {tab.icon ? <Icon name={tab.icon} size={24} /> : null}
                <span style={{ flex: 1, minWidth: 0, ...ellipsis }}>{tab.label}</span>
              </div>
            );
          })}
        </div>
      );
    }

    case "rating": {
      const stars = Math.min(10, Math.max(3, Math.round(item.count ?? 5)));
      const filled = Math.min(stars, Math.max(0, Math.round(item.selected ?? 4)));
      const d = item.size ?? 28;
      return (
        <div style={{ display: "flex", gap: 4, height: "100%", alignItems: "center" }}>
          {Array.from({ length: stars }, (_, i) => (
            <Icon
              key={i}
              name="star"
              size={d}
              color={i < filled ? p.primary : p.outlineVariant}
              fill
            />
          ))}
        </div>
      );
    }

    case "divider":
      return (
        <div style={{ display: "flex", alignItems: "center", height: "100%" }}>
          <div style={{ width: "100%", height: 1, background: p.outlineVariant }} />
        </div>
      );

    case "carousel":
      /* the same measure a scrolling tab row is drawn at: how far the row has been carried */
      return <CarouselBody item={item} p={p} scroll={tabScroll} />;
    case "datePicker":
      return <DatePickerBody item={item} p={p} />;
    case "timePicker":
      return <TimePickerBody item={item} p={p} />;

    case "navRail":
      return (
        <NavRailBody
          item={item}
          p={p}
          lang={lang}
          w={w}
          hasLabel={hasLabel}
          hasSupporting={hasSupporting}
          tabScroll={tabScroll}
          menuShown={menuShown}
        />
      );

    case "bottomNav":
      return (
        <BottomNavBody
          item={item}
          p={p}
          lang={lang}
          w={w}
          hasLabel={hasLabel}
          hasSupporting={hasSupporting}
          tabScroll={tabScroll}
          menuShown={menuShown}
        />
      );

    case "circularProgress":
      return (
        <CircularProgress
          size={item.size ?? 48}
          color={p.primary}
          trackColor={p.secondaryContainer}
          wavy={item.wavy}
          trackThickness={progressThickness(item)}
          value={item.value === undefined ? undefined : item.value / 100}
        />
      );

    case "linearProgress":
      return (
        <div style={{ display: "flex", alignItems: "center", height: "100%" }}>
          <LinearProgress
            width={item.size ?? 320}
            color={p.primary}
            trackColor={p.secondaryContainer}
            wavy={item.wavy}
            trackThickness={progressThickness(item)}
            value={item.value === undefined ? undefined : item.value / 100}
          />
        </div>
      );

    case "fabMenu":
      return <FabMenuContent item={item} p={p} />;

    case "toolbar": {
      const tabs = item.tabs ?? [];
      const vibrant = item.variant === "filled";
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 8px",
            height: "100%",
            boxSizing: "border-box",
          }}
        >
          {tabs.map((tab, i) => (
            <span
              key={i}
              style={{
                width: 48,
                height: 48,
                borderRadius: scaleR(24),
                display: "grid",
                placeItems: "center",
                color: vibrant ? p.onPrimaryContainer : p.onSurfaceVariant,
                flex: "0 0 auto",
              }}
            >
              {tab.icon && <Icon name={tab.icon} size={24} />}
            </span>
          ))}
        </div>
      );
    }

    case "tabs":
      return (
        <TabsBody
          item={item}
          p={p}
          lang={lang}
          w={w}
          hasLabel={hasLabel}
          hasSupporting={hasSupporting}
          tabScroll={tabScroll}
          menuShown={menuShown}
        />
      );

    case "loadingIndicator": {
      const s = item.size ?? 48;
      return (
        <LoadingIndicator
          size={s}
          color={item.contained ? p.onPrimaryContainer : p.primary}
          contained={item.contained}
          containerColor={p.primaryContainer}
        />
      );
    }
  }
  return null;
}

/** The colour whatever is written on a part is drawn in, and so the colour a ripple over it
 *  takes: white over a filled button, the text's own colour over a pale surface. A split button
 *  paints no box of its own, so its two segments answer for it. */
export function contentColor(item: Item, p: Palette): string {
  const c =
    item.kind === "splitButton" ? variantStyle(item.variant, p).color : boxStyle(item, p).color;
  return typeof c === "string" ? c : p.onSurface;
}

/** how the part's box is painted: the panel paints its style cells with the same answer */
export function boxStyle(item: Item, p: Palette): React.CSSProperties {
  if (NO_BOX.includes(item.kind) || menuOpen(item))
    return { background: "transparent", border: "none" };
  switch (item.kind) {
    case "box":
    case "bottomSheet": {
      const t = item.fill ?? "surfaceContainerLow";
      return { background: p[t], color: onToken(t, p), border: "none" };
    }
    case "button":
    case "iconButton":
    case "fab":
    case "extendedFab":
      return variantStyle(item.variant, p);
    case "chip":
      if (item.checked)
        return { background: p.secondaryContainer, color: p.onSecondaryContainer, border: "none" };
      return item.variant === "outlined"
        ? {
            background: "transparent",
            color: p.onSurfaceVariant,
            border: `1px solid ${p.outlineVariant}`,
          }
        : { background: p.surfaceContainerLow, color: p.onSurfaceVariant, border: "none" };
    case "card":
      return {
        background: p[cardFillOf(item)],
        border: item.variant === "outlined" ? `1px solid ${p.outlineVariant}` : "none",
      };
    case "textField":
    case "select":
      return item.variant === "filled"
        ? { background: p.surfaceContainerHighest, border: "none", color: p.onSurface }
        : { background: p.surface, border: `1px solid ${p.outline}`, color: p.onSurface };
    case "topAppBar":
    case "bottomNav":
    case "navRail":
      return { background: p.surfaceContainer, border: "none", color: p.onSurface };
    case "toolbar":
      return item.variant === "filled"
        ? { background: p.primaryContainer, border: "none", color: p.onPrimaryContainer }
        : { background: p.surfaceContainer, border: "none", color: p.onSurfaceVariant };
    case "tabs":
      return { background: p.surface, border: "none", color: p.onSurface };
    case "searchBar":
      return item.variant === "outlined"
        ? { background: p.surface, border: `1px solid ${p.outline}`, color: p.onSurface }
        : { background: p.surfaceContainerHigh, border: "none", color: p.onSurface };
    case "dialog":
      return { background: p.surfaceContainerHigh, border: "none", color: p.onSurface };
    case "datePicker":
      /* typed in, a date is a field on the screen rather than a surface over it */
      return dateLayoutOf(item) === "input"
        ? { background: "transparent", border: "none", color: p.onSurface }
        : { background: p.surfaceContainerHigh, border: "none", color: p.onSurface };
    case "timePicker":
      return { background: p.surfaceContainerHigh, border: "none", color: p.onSurface };
    case "snackbar":
      return { background: p.inverseSurface, border: "none", color: p.inverseOnSurface };
    case "custom":
      return { background: "transparent", color: p.onSurface, border: "none" };
    case "banner":
      return { background: p.surfaceContainer, color: p.onSurface, border: "none" };
    case "avatar":
      return item.variant === "filled"
        ? { background: p.primary, color: p.onPrimary, border: "none" }
        : item.variant === "outlined"
          ? { background: "transparent", color: p.onSurface, border: `1px solid ${p.outline}` }
          : { background: p.primaryContainer, color: p.onPrimaryContainer, border: "none" };
    case "tooltip":
      return item.supporting?.trim()
        ? { background: p.surfaceContainer, color: p.onSurfaceVariant, border: "none" }
        : { background: p.inverseSurface, color: p.inverseOnSurface, border: "none" };
    case "menu":
      return { background: p.surfaceContainer, color: p.onSurface, border: "none" };
    case "image":
    case "map":
      return { background: p.surfaceContainerHighest, border: "none" };
    case "camera":
      return { background: p.inverseSurface, border: "none", color: p.inverseOnSurface };
    case "listItem": {
      const t = item.fill ?? "surfaceContainerLow";
      return { background: p[t], border: "none", color: onToken(t, p) };
    }
    default:
      return { background: p.surfaceContainerHigh, border: "none", color: p.onSurface };
  }
}

function shadowOf(item: Item): string {
  if (NO_BOX.includes(item.kind) || menuOpen(item)) return "none";
  switch (item.kind) {
    case "navRail":
      return item.railModal && item.railExpanded
        ? "0 2px 6px rgba(0,0,0,0.16), 0 1px 2px rgba(0,0,0,0.10)"
        : "none";
    case "button":
    case "iconButton":
    case "extendedFab":
      return variantShadow(item.variant);
    case "fab":
      return "0 3px 8px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12)";
    case "card":
      return item.variant === "elevated"
        ? "0 1px 3px rgba(0,0,0,0.20), 0 2px 6px rgba(0,0,0,0.10)"
        : "none";
    case "dialog":
      return "0 8px 24px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.10)";
    case "timePicker":
      return "0 8px 24px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.10)";
    case "datePicker":
      return dateLayoutOf(item) === "input"
        ? "none"
        : "0 8px 24px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.10)";
    case "snackbar":
      return "0 3px 8px rgba(0,0,0,0.18)";
    case "toolbar":
      return "0 2px 6px rgba(0,0,0,0.14), 0 1px 2px rgba(0,0,0,0.10)";
    case "menu":
      return "0 2px 6px rgba(0,0,0,0.16), 0 1px 2px rgba(0,0,0,0.10)";
    case "tooltip":
      return item.supporting?.trim()
        ? "0 2px 6px rgba(0,0,0,0.16), 0 1px 2px rgba(0,0,0,0.10)"
        : "none";
    default:
      return "none";
  }
}

export type { Radii };

/** Corner radii are driven continuously by the magnet; a stiff spring keeps them on the pointer. */
const RADIUS_TWEEN = { type: "spring" as const, stiffness: 900, damping: 48, mass: 0.4 };

export function M3Node({
  item,
  palette,
  radii,
  widths,
  pressed,
  dragging,
  selected,
  inRun = false,
  interactive = true,
  onPointerDown,
  tabScroll,
  instant,
  ripple,
  lit,
}: {
  item: Item;
  palette: Palette;
  radii?: Radii;
  widths: Record<string, number>;
  pressed?: boolean;
  dragging?: boolean;
  selected?: boolean;
  /** the part sits in a connected run (non-free group, or a hidden run inside a free group) */
  inRun?: boolean;
  /** the width is being dragged on the canvas: it must follow the pointer with no easing */
  instant?: boolean;
  interactive?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  /** how far a scrollable tab row is scrolled in the preview; the canvas uses the resting position */
  tabScroll?: number;
  /** a press lights the part up from inside, the way Android does. The preview lights its own
   *  parts through the hit areas it lays over them, so it leaves this off. */
  ripple?: boolean;
  /** a light the part is given rather than one it took itself: where the finger is on a part
   *  being carried across the canvas, and where it was on one that has just landed. It stays for
   *  as long as it is given, and goes out on its own once it is taken away. `at` is when the
   *  press began, so a light handed over mid-spread carries on rather than starting again. */
  lit?: { x: number; y: number; at?: number; grown?: boolean } | null;
}) {
  const reducedMotion = useReducedMotion();
  const instantRail = reducedMotion && item.kind === "navRail" && isWideRail(item);
  const radiusTransition = instantRail ? { duration: 0 } : RADIUS_TWEEN;
  /* a menu on its way out is still drawn open, so the part is measured and boxed as it looks */
  const menu = useMenuPhase(item);
  const drawn = menu.drawn && !menuOpen(item) ? ({ ...item, [fabOpen]: true } as Item) : item;
  const r = radii ?? baseRadii(item);
  const size = sizeOf(drawn, widths);
  const measured = isMeasured(drawn);
  const clips =
    !NO_BOX.includes(item.kind) &&
    !menuOpen(drawn) &&
    item.kind !== "textField" &&
    item.kind !== "select";
  /* only the button family lights up from inside; everything else is left as it was drawn */
  const lights = !!ripple && RIPPLE_KINDS.includes(item.kind);
  const ripples = useRipples(lights);
  /* the light a part carries in from wherever it was dropped belongs to the same family: a bar
   * landing on a screen simply arrives, it does not light up */
  const carried = RIPPLE_KINDS.includes(item.kind) ? lit : null;
  /* a given light belongs to the shape it was given inside: on a split button, the half the
   * finger is on */
  const litPart =
    carried && item.kind === "splitButton"
      ? carried.x > size.w - splitMetrics(buttonHeightOf(item)).trailW
        ? SPLIT_MENU_SLOT
        : SPLIT_MAIN_SLOT
      : null;
  /* how far the light had already spread where it came from: read once, when it arrives, so the
   * circle picks up where the other drawing left off and keeps going at the same pace. It is read
   * off the clock only when a new light arrives, never on a render that merely repeats. */
  const litSpread = useMemo(() => {
    if (!carried) return null;
    const gone = carried.grown
      ? RIPPLE_GROW
      : carried.at
        ? Math.max(0, (performance.now() - carried.at) / 1000)
        : 0;
    return { from: Math.min(1, gone / RIPPLE_GROW), dur: Math.max(0, RIPPLE_GROW - gone) };
  }, [carried]);
  const shown: Ripple[] = carried
    ? [
        ...ripples.list,
        {
          id: 0,
          part: litPart,
          x: carried.x,
          y: carried.y,
          d: rippleSize({ width: size.w, height: size.h }, carried.x, carried.y),
          from: litSpread?.from,
          dur: litSpread?.dur,
        },
      ]
    : ripples.list;

  return (
    <motion.div
      className="m3e-pop"
      data-node={item.id}
      data-kind={item.kind}
      data-wide-rail={item.kind === "navRail" && isWideRail(item) ? "true" : undefined}
      onPointerDown={(e) => {
        ripples.add(e);
        onPointerDown?.(e);
      }}
      onPointerCancel={ripples.end}
      initial={false}
      animate={{
        borderTopLeftRadius: r.tl,
        borderBottomLeftRadius: r.bl,
        borderTopRightRadius: r.tr,
        borderBottomRightRadius: r.br,
        scale: pressed ? 0.97 : 1,
      }}
      transition={{
        borderTopLeftRadius: radiusTransition,
        borderBottomLeftRadius: radiusTransition,
        borderTopRightRadius: radiusTransition,
        borderBottomRightRadius: radiusTransition,
        scale: instantRail
          ? { duration: 0 }
          : { type: "spring", stiffness: 700, damping: 30, mass: 0.5 },
      }}
      style={{
        ...boxStyle(drawn, palette),
        width: measured ? undefined : size.w,
        height: size.h,
        display: measured ? "inline-flex" : "block",
        alignItems: "center",
        overflow: clips ? "hidden" : "visible",
        /* the selection ring sticks out 5px (3px offset + 2px ring); in a run the next
           sibling sits 3px away and would overpaint that edge — lift the selected part.
           Runs never overlap, so the lift only beats the sibling that hides the ring.
           Lone parts in free groups may overlap by design: keep their layer order. */
        position: selected && inRun ? "relative" : undefined,
        zIndex: selected && inRun ? 1 : undefined,
        cursor: !interactive ? "default" : dragging ? "grabbing" : "grab",
        userSelect: "none",
        touchAction: "none",
        boxSizing: "border-box",
        boxShadow: shadowOf(drawn),
        outline: selected ? `2px solid ${palette.primary}` : "2px solid transparent",
        outlineOffset: 3,
        /* a part that changes size with its screen, or with the size the author picked,
           eases the way the screen does; a measured part has no width of its own to ease */
        transition:
          instant || menu.snap
            ? "outline-color 120ms"
            : `outline-color 120ms, height ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)${measured ? "" : `, width ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`}`,
        flex: "0 0 auto",
      }}
    >
      <RippleCtx.Provider value={{ list: shown, color: contentColor(drawn, palette) }}>
        <Body item={drawn} p={palette} tabScroll={tabScroll} menuShown={menu.open} />
        {/* a part drawn as one shape is lit through its own box; one made of several -- a split
            button -- carries the light inside each of them instead */}
        {(lights || !!carried) && item.kind !== "splitButton" && <RippleShape part={null} />}
      </RippleCtx.Provider>
    </motion.div>
  );
}

/** Plain (non-animated) rendering of a part; used where frames must be deterministic. */
export function M3Static({
  item,
  palette,
  radii,
  style,
}: {
  item: Item;
  palette: Palette;
  radii?: Radii;
  style?: React.CSSProperties;
}) {
  const r = radii ?? baseRadii(item);
  const size = sizeOf(item, {});
  const measured = isMeasured(item);
  const clips =
    !NO_BOX.includes(item.kind) &&
    !menuOpen(item) &&
    item.kind !== "textField" &&
    item.kind !== "select";
  return (
    <div
      style={{
        ...boxStyle(item, palette),
        width: measured ? undefined : size.w,
        height: size.h,
        display: measured ? "inline-flex" : "block",
        alignItems: "center",
        overflow: clips ? "hidden" : "visible",
        boxSizing: "border-box",
        boxShadow: shadowOf(item),
        borderTopLeftRadius: r.tl,
        borderTopRightRadius: r.tr,
        borderBottomLeftRadius: r.bl,
        borderBottomRightRadius: r.br,
        flex: "0 0 auto",
        ...style,
      }}
    >
      <Body item={item} p={palette} />
    </div>
  );
}

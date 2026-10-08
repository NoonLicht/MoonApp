import type { ColorToken } from "@/pages/myspace/m3e/lib/tokens";

/**
 * Составной элемент: дерево из простых узлов (контейнер, текст, иконка, кнопка…), которое рисуется
 * цветами и формами темы документа. Из таких деревьев сделаны готовые элементы библиотеки, и их же
 * возвращает ИИ: модель описывает макет данными, а не кодом, поэтому элемент всегда выходит
 * в стиле остальных и не может сломать редактор.
 */

export type Role = "headline" | "title" | "body" | "label" | "caption";
export type Align = "start" | "center" | "end" | "stretch";
export type Justify = "start" | "center" | "end" | "between";

export type CNode =
  | {
      t: "box";
      /** направление: row — в строку, col — в столбец */
      dir?: "row" | "col";
      gap?: number;
      pad?: number | [number, number];
      fill?: ColorToken;
      border?: ColorToken;
      r?: number;
      align?: Align;
      justify?: Justify;
      /** доля свободного места внутри родителя */
      grow?: number;
      w?: number;
      h?: number;
      c?: CNode[];
    }
  | {
      t: "text";
      s: string;
      role?: Role;
      color?: ColorToken | "variant" | "primary";
      bold?: boolean;
      align?: "start" | "center" | "end";
      grow?: number;
    }
  | {
      t: "icon";
      n: string;
      size?: number;
      color?: ColorToken | "variant" | "primary";
      bg?: ColorToken;
    }
  | {
      t: "button";
      s: string;
      v?: "filled" | "tonal" | "outlined" | "text";
      icon?: string;
      grow?: number;
    }
  | { t: "chip"; s: string; icon?: string; on?: boolean }
  | { t: "avatar"; s?: string; size?: number; fill?: ColorToken }
  | { t: "image"; h?: number; w?: number; icon?: string; r?: number; grow?: number }
  | { t: "progress"; v: number; grow?: number }
  | { t: "switch"; on?: boolean }
  | { t: "badge"; s: string }
  | { t: "divider" }
  | { t: "spacer"; grow?: number };

export const MAX_DEPTH = 6;
export const MAX_NODES = 80;

const TOKENS: ColorToken[] = [
  "surface",
  "surfaceContainerLow",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
  "primaryContainer",
  "secondaryContainer",
  "tertiaryContainer",
  "primary",
  "inverseSurface",
];
const ROLES: Role[] = ["headline", "title", "body", "label", "caption"];
const TEXT_COLORS = [...TOKENS, "variant", "primary"];

const num = (v: unknown, lo: number, hi: number, d?: number): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v)) return d;
  return Math.max(lo, Math.min(hi, Math.round(v)));
};
const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
const tok = (v: unknown): ColorToken | undefined =>
  typeof v === "string" && (TOKENS as string[]).includes(v) ? (v as ColorToken) : undefined;
const icon = (v: unknown): string => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return /^[a-z0-9_]{1,40}$/.test(s) ? s : "";
};
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/**
 * Приводит произвольные данные (например, ответ модели) к безопасному дереву:
 * лишние поля отбрасываются, числа зажимаются в разумные границы, глубина и число узлов ограничены.
 * Возвращает null, если из данных нельзя получить ни одного узла.
 */
export function sanitizeNode(input: unknown): CNode | null {
  let count = 0;
  const walk = (raw: unknown, depth: number): CNode | null => {
    if (!raw || typeof raw !== "object" || depth > MAX_DEPTH || count >= MAX_NODES) return null;
    const n = raw as Record<string, unknown>;
    count++;
    const grow = num(n.grow, 0, 10);
    switch (n.t) {
      case "box": {
        const kids = Array.isArray(n.c) ? n.c : [];
        const c: CNode[] = [];
        for (const k of kids) {
          const s = walk(k, depth + 1);
          if (s) c.push(s);
        }
        const pad = Array.isArray(n.pad)
          ? ([num(n.pad[0], 0, 64, 0)!, num(n.pad[1], 0, 64, 0)!] as [number, number])
          : num(n.pad, 0, 64);
        return {
          t: "box",
          dir: n.dir === "row" ? "row" : "col",
          gap: num(n.gap, 0, 48),
          pad,
          fill: tok(n.fill),
          border: tok(n.border),
          r: num(n.r, 0, 64),
          align: oneOf(n.align, ["start", "center", "end", "stretch"]),
          justify: oneOf(n.justify, ["start", "center", "end", "between"]),
          grow,
          w: num(n.w, 8, 460),
          h: num(n.h, 8, 900),
          c,
        };
      }
      case "text": {
        const s = str(n.s, 160);
        if (!s) return null;
        return {
          t: "text",
          s,
          role: oneOf(n.role, ROLES),
          color: oneOf(n.color, TEXT_COLORS as (ColorToken | "variant" | "primary")[]),
          bold: n.bold === true ? true : undefined,
          align: oneOf(n.align, ["start", "center", "end"]),
          grow,
        };
      }
      case "icon": {
        const name = icon(n.n);
        if (!name) return null;
        return {
          t: "icon",
          n: name,
          size: num(n.size, 12, 64),
          color: oneOf(n.color, TEXT_COLORS as (ColorToken | "variant" | "primary")[]),
          bg: tok(n.bg),
        };
      }
      case "button": {
        const s = str(n.s, 40);
        if (!s) return null;
        return {
          t: "button",
          s,
          v: oneOf(n.v, ["filled", "tonal", "outlined", "text"]),
          icon: icon(n.icon) || undefined,
          grow,
        };
      }
      case "chip": {
        const s = str(n.s, 40);
        if (!s) return null;
        return {
          t: "chip",
          s,
          icon: icon(n.icon) || undefined,
          on: n.on === true ? true : undefined,
        };
      }
      case "avatar":
        return {
          t: "avatar",
          s: str(n.s, 3) || undefined,
          size: num(n.size, 20, 96),
          fill: tok(n.fill),
        };
      case "image":
        return {
          t: "image",
          h: num(n.h, 16, 400),
          w: num(n.w, 16, 460),
          icon: icon(n.icon) || undefined,
          r: num(n.r, 0, 64),
          grow,
        };
      case "progress":
        return { t: "progress", v: num(n.v, 0, 100, 50)!, grow };
      case "switch":
        return { t: "switch", on: n.on === true ? true : undefined };
      case "badge": {
        const s = str(n.s, 12);
        return s ? { t: "badge", s } : null;
      }
      case "divider":
        return { t: "divider" };
      case "spacer":
        return { t: "spacer", grow: grow ?? 1 };
      default:
        return null;
    }
  };
  return walk(input, 0);
}

/** Дерево целиком: размер элемента и его содержимое. */
export type CustomSpec = { name: string; w: number; h: number; node: CNode };

export function sanitizeSpec(input: unknown): CustomSpec | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const node = sanitizeNode(o.node ?? o.root ?? o);
  if (!node) return null;
  return {
    name: str(o.name, 40) || "Element",
    w: num(o.w, 80, 412, 360)!,
    h: num(o.h, 24, 600, 120)!,
    node: node.t === "box" ? node : { t: "box", c: [node] },
  };
}

/* ───────────── готовые элементы ───────────── */

type P = {
  key: string;
  category: "actions" | "navigation" | "containment" | "inputs" | "content" | "progress";
  icon: string;
  ru: string;
  en: string;
  w: number;
  h: number;
  node: CNode;
};

const row = (c: CNode[], o: Partial<Extract<CNode, { t: "box" }>> = {}): CNode => ({
  t: "box",
  dir: "row",
  align: "center",
  gap: 12,
  ...o,
  c,
});
const col = (c: CNode[], o: Partial<Extract<CNode, { t: "box" }>> = {}): CNode => ({
  t: "box",
  dir: "col",
  gap: 4,
  ...o,
  c,
});
const txt = (
  s: string,
  role: Role = "body",
  o: Partial<Extract<CNode, { t: "text" }>> = {},
): CNode => ({
  t: "text",
  s,
  role,
  ...o,
});
const ic = (n: string, o: Partial<Extract<CNode, { t: "icon" }>> = {}): CNode => ({
  t: "icon",
  n,
  ...o,
});

export const PRESETS: P[] = [
  /* действия */
  {
    key: "btnGroup",
    category: "actions",
    icon: "ads_click",
    ru: "Две кнопки",
    en: "Button pair",
    w: 360,
    h: 48,
    node: row(
      [
        { t: "button", s: "Cancel", v: "outlined", grow: 1 },
        { t: "button", s: "Confirm", v: "filled", grow: 1 },
      ],
      { pad: 0 },
    ),
  },
  {
    key: "ctaBar",
    category: "actions",
    icon: "shopping_cart_checkout",
    ru: "Панель покупки",
    en: "Purchase bar",
    w: 360,
    h: 72,
    node: row(
      [
        col(
          [txt("Total", "caption", { color: "variant" }), txt("$48.00", "title", { bold: true })],
          {
            grow: 1,
          },
        ),
        { t: "button", s: "Checkout", v: "filled", icon: "arrow_forward" },
      ],
      { pad: [16, 12], fill: "surfaceContainerHigh", r: 28 },
    ),
  },
  {
    key: "quickActions",
    category: "actions",
    icon: "bolt",
    ru: "Быстрые действия",
    en: "Quick actions",
    w: 360,
    h: 88,
    node: row(
      ["send", "qr_code_scanner", "add_card", "history"].map((n, i) =>
        col(
          [
            ic(n, { size: 24, bg: "secondaryContainer", color: "secondaryContainer" }),
            txt(["Send", "Scan", "Top up", "History"][i], "caption"),
          ],
          { align: "center", grow: 1 },
        ),
      ),
      { justify: "between", pad: [8, 8] },
    ),
  },
  {
    key: "chipRow",
    category: "actions",
    icon: "label",
    ru: "Ряд фильтров",
    en: "Filter chips",
    w: 360,
    h: 40,
    node: row(
      [
        { t: "chip", s: "All", on: true },
        { t: "chip", s: "Nearby", icon: "near_me" },
        { t: "chip", s: "Open now" },
        { t: "chip", s: "Top rated" },
      ],
      { gap: 8 },
    ),
  },
  /* навигация */
  {
    key: "stepper",
    category: "navigation",
    icon: "linear_scale",
    ru: "Шаги",
    en: "Stepper",
    w: 360,
    h: 64,
    node: col(
      [
        row(
          [
            { t: "avatar", s: "1", size: 28, fill: "primary" },
            { t: "progress", v: 100, grow: 1 },
            { t: "avatar", s: "2", size: 28, fill: "primary" },
            { t: "progress", v: 40, grow: 1 },
            { t: "avatar", s: "3", size: 28, fill: "surfaceContainerHighest" },
          ],
          { gap: 8 },
        ),
        row(
          [
            txt("Cart", "caption", { grow: 1 }),
            txt("Address", "caption", { grow: 1, align: "center" }),
            txt("Payment", "caption", { grow: 1, align: "end", color: "variant" }),
          ],
          { gap: 0 },
        ),
      ],
      { gap: 8, pad: [4, 4] },
    ),
  },
  {
    key: "breadcrumb",
    category: "navigation",
    icon: "chevron_right",
    ru: "Хлебные крошки",
    en: "Breadcrumbs",
    w: 360,
    h: 32,
    node: row(
      [
        txt("Home", "label", { color: "variant" }),
        ic("chevron_right", { size: 16, color: "variant" }),
        txt("Catalog", "label", { color: "variant" }),
        ic("chevron_right", { size: 16, color: "variant" }),
        txt("Shoes", "label", { bold: true }),
      ],
      { gap: 4 },
    ),
  },
  {
    key: "profileHeader",
    category: "navigation",
    icon: "account_circle",
    ru: "Шапка профиля",
    en: "Profile header",
    w: 360,
    h: 96,
    node: row(
      [
        { t: "avatar", s: "AK", size: 56, fill: "primaryContainer" },
        col(
          [
            txt("Alex Kim", "title", { bold: true }),
            txt("alex@mail.com", "body", { color: "variant" }),
          ],
          {
            grow: 1,
          },
        ),
        ic("settings", { size: 24, color: "variant" }),
      ],
      { pad: 16, fill: "surfaceContainerLow", r: 28 },
    ),
  },
  /* контейнеры */
  {
    key: "productCard",
    category: "containment",
    icon: "storefront",
    ru: "Карточка товара",
    en: "Product card",
    w: 200,
    h: 280,
    node: col(
      [
        { t: "image", h: 150, icon: "image", r: 20 },
        col(
          [
            txt("Wireless headphones", "title", { bold: true }),
            txt("Noise cancelling", "caption", { color: "variant" }),
          ],
          {
            gap: 2,
          },
        ),
        row(
          [
            txt("$129", "title", { color: "primary", bold: true, grow: 1 }),
            ic("favorite", { size: 22, color: "variant" }),
          ],
          { gap: 8 },
        ),
      ],
      { gap: 10, pad: 10, fill: "surfaceContainerHigh", r: 28 },
    ),
  },
  {
    key: "pricing",
    category: "containment",
    icon: "workspace_premium",
    ru: "Тариф",
    en: "Pricing plan",
    w: 300,
    h: 300,
    node: col(
      [
        row([txt("Pro", "title", { bold: true, grow: 1 }), { t: "badge", s: "Popular" }]),
        row(
          [txt("$12", "headline", { bold: true }), txt("/ month", "body", { color: "variant" })],
          {
            align: "end",
            gap: 4,
          },
        ),
        { t: "divider" },
        ...["Unlimited projects", "Priority support", "Team sharing"].map((s) =>
          row([ic("check_circle", { size: 20, color: "primary" }), txt(s, "body")], { gap: 10 }),
        ),
        { t: "spacer", grow: 1 },
        { t: "button", s: "Choose plan", v: "filled" },
      ],
      { gap: 10, pad: 20, fill: "surfaceContainerLow", border: "surfaceContainerHighest", r: 28 },
    ),
  },
  {
    key: "statTile",
    category: "containment",
    icon: "monitoring",
    ru: "Плитка статистики",
    en: "Stat tile",
    w: 170,
    h: 110,
    node: col(
      [
        row(
          [
            ic("trending_up", { size: 20, color: "primary" }),
            txt("Revenue", "label", { color: "variant" }),
          ],
          {
            gap: 6,
          },
        ),
        txt("$24.8k", "headline", { bold: true }),
        txt("+12% this week", "caption", { color: "primary" }),
      ],
      { gap: 6, pad: 16, fill: "primaryContainer", r: 24 },
    ),
  },
  {
    key: "emptyState",
    category: "containment",
    icon: "inbox",
    ru: "Пустое состояние",
    en: "Empty state",
    w: 320,
    h: 240,
    node: col(
      [
        ic("inbox", { size: 40, bg: "surfaceContainerHighest", color: "variant" }),
        txt("Nothing here yet", "title", { bold: true, align: "center" }),
        txt("Items you add will show up in this list", "body", {
          color: "variant",
          align: "center",
        }),
        { t: "button", s: "Add item", v: "tonal", icon: "add" },
      ],
      { gap: 12, align: "center", justify: "center", pad: 16 },
    ),
  },
  {
    key: "notice",
    category: "containment",
    icon: "warning",
    ru: "Предупреждение",
    en: "Notice",
    w: 360,
    h: 72,
    node: row(
      [
        ic("warning", { size: 24, color: "inverseSurface" }),
        col(
          [
            txt("Storage almost full", "label", { bold: true }),
            txt("92% of 15 GB used", "caption", { color: "variant" }),
          ],
          {
            grow: 1,
            gap: 2,
          },
        ),
        { t: "button", s: "Manage", v: "text" },
      ],
      { pad: [16, 12], fill: "tertiaryContainer", r: 20 },
    ),
  },
  /* ввод */
  {
    key: "settingSwitch",
    category: "inputs",
    icon: "toggle_on",
    ru: "Строка с переключателем",
    en: "Switch row",
    w: 360,
    h: 64,
    node: row(
      [
        ic("notifications", { size: 22, bg: "secondaryContainer", color: "secondaryContainer" }),
        col(
          [
            txt("Notifications", "body", { bold: true }),
            txt("Push and email", "caption", { color: "variant" }),
          ],
          {
            grow: 1,
            gap: 2,
          },
        ),
        { t: "switch", on: true },
      ],
      { pad: [16, 10] },
    ),
  },
  {
    key: "loginForm",
    category: "inputs",
    icon: "login",
    ru: "Форма входа",
    en: "Login form",
    w: 340,
    h: 270,
    node: col(
      [
        txt("Welcome back", "headline", { bold: true }),
        row(
          [ic("mail", { size: 20, color: "variant" }), txt("Email", "body", { color: "variant" })],
          {
            pad: [16, 14],
            fill: "surfaceContainerHighest",
            r: 16,
          },
        ),
        row(
          [
            ic("lock", { size: 20, color: "variant" }),
            txt("Password", "body", { color: "variant", grow: 1 }),
            ic("visibility", { size: 20, color: "variant" }),
          ],
          { pad: [16, 14], fill: "surfaceContainerHighest", r: 16 },
        ),
        { t: "button", s: "Sign in", v: "filled" },
        { t: "button", s: "Create account", v: "text" },
      ],
      { gap: 12, pad: 8 },
    ),
  },
  {
    key: "searchFilters",
    category: "inputs",
    icon: "manage_search",
    ru: "Поиск с фильтрами",
    en: "Search with filters",
    w: 360,
    h: 108,
    node: col(
      [
        row(
          [
            ic("search", { size: 22, color: "variant" }),
            txt("Search places", "body", { color: "variant", grow: 1 }),
            ic("tune", { size: 22, color: "variant" }),
          ],
          { pad: [16, 12], fill: "surfaceContainerHigh", r: 28 },
        ),
        row(
          [
            { t: "chip", s: "Cafe", on: true },
            { t: "chip", s: "Park" },
            { t: "chip", s: "Museum" },
          ],
          { gap: 8 },
        ),
      ],
      { gap: 12 },
    ),
  },
  /* контент */
  {
    key: "chatBubble",
    category: "content",
    icon: "chat_bubble",
    ru: "Сообщение",
    en: "Chat bubble",
    w: 280,
    h: 64,
    node: col(
      [
        txt("Are we still on for tomorrow?", "body"),
        txt("12:41", "caption", { color: "variant", align: "end" }),
      ],
      { gap: 4, pad: [14, 10], fill: "secondaryContainer", r: 20 },
    ),
  },
  {
    key: "notification",
    category: "content",
    icon: "notifications_active",
    ru: "Уведомление",
    en: "Notification",
    w: 360,
    h: 80,
    node: row(
      [
        { t: "avatar", s: "M", size: 40, fill: "tertiaryContainer" },
        col(
          [
            txt("Maria commented", "body", { bold: true }),
            txt("“Looks great, ship it!”", "caption", { color: "variant" }),
          ],
          {
            grow: 1,
            gap: 2,
          },
        ),
        txt("2m", "caption", { color: "variant" }),
      ],
      { pad: 14, fill: "surfaceContainerHigh", r: 24 },
    ),
  },
  {
    key: "musicPlayer",
    category: "content",
    icon: "music_note",
    ru: "Плеер",
    en: "Music player",
    w: 360,
    h: 120,
    node: col(
      [
        row(
          [
            { t: "image", w: 56, h: 56, icon: "album", r: 16 },
            col(
              [
                txt("Midnight City", "title", { bold: true }),
                txt("M83", "caption", { color: "variant" }),
              ],
              {
                grow: 1,
                gap: 2,
              },
            ),
            ic("favorite", { size: 22, color: "primary" }),
          ],
          { gap: 12 },
        ),
        { t: "progress", v: 38 },
        row(
          ["skip_previous", "pause_circle", "skip_next"].map((n) =>
            ic(n, { size: n === "pause_circle" ? 40 : 28, color: "primary" }),
          ),
          { justify: "center", gap: 20 },
        ),
      ],
      { gap: 10, pad: 14, fill: "surfaceContainerLow", r: 28 },
    ),
  },
  {
    key: "article",
    category: "content",
    icon: "article",
    ru: "Статья",
    en: "Article card",
    w: 360,
    h: 250,
    node: col(
      [
        { t: "image", h: 130, icon: "landscape", r: 20 },
        row([{ t: "chip", s: "Travel" }, txt("5 min read", "caption", { color: "variant" })], {
          gap: 8,
        }),
        txt("Ten quiet places to visit this autumn", "title", { bold: true }),
      ],
      { gap: 8, pad: 10, fill: "surfaceContainerLow", r: 28 },
    ),
  },
  {
    key: "contactRow",
    category: "content",
    icon: "contacts",
    ru: "Контакт",
    en: "Contact row",
    w: 360,
    h: 64,
    node: row(
      [
        { t: "avatar", s: "JD", size: 44, fill: "primaryContainer" },
        col(
          [
            txt("Jordan Diaz", "body", { bold: true }),
            txt("+1 555 0142", "caption", { color: "variant" }),
          ],
          {
            grow: 1,
            gap: 2,
          },
        ),
        ic("call", { size: 22, color: "primary" }),
        ic("chat", { size: 22, color: "primary" }),
      ],
      { pad: [8, 10], gap: 14 },
    ),
  },
  /* прогресс */
  {
    key: "uploadProgress",
    category: "progress",
    icon: "upload_file",
    ru: "Загрузка файла",
    en: "Upload progress",
    w: 360,
    h: 84,
    node: row(
      [
        ic("description", { size: 24, bg: "primaryContainer", color: "primaryContainer" }),
        col(
          [
            row([
              txt("report.pdf", "body", { bold: true, grow: 1 }),
              txt("64%", "caption", { color: "variant" }),
            ]),
            { t: "progress", v: 64 },
          ],
          { grow: 1, gap: 8 },
        ),
        ic("close", { size: 20, color: "variant" }),
      ],
      { pad: 14, fill: "surfaceContainerHigh", r: 24 },
    ),
  },
  {
    key: "goal",
    category: "progress",
    icon: "flag",
    ru: "Цель",
    en: "Goal tracker",
    w: 360,
    h: 120,
    node: col(
      [
        row([
          ic("directions_run", { size: 22, color: "primary" }),
          txt("Daily steps", "body", { bold: true, grow: 1 }),
          txt("6,420 / 10,000", "caption", { color: "variant" }),
        ]),
        { t: "progress", v: 64 },
        row(
          [
            txt("Mon", "caption", { grow: 1, color: "variant" }),
            txt("Today", "caption", { grow: 1, align: "center", bold: true }),
            txt("Sun", "caption", { grow: 1, align: "end", color: "variant" }),
          ],
          {
            gap: 0,
          },
        ),
      ],
      { gap: 10, pad: 16, fill: "surfaceContainerLow", r: 24 },
    ),
  },
  {
    key: "ratingSummary",
    category: "progress",
    icon: "star_rate",
    ru: "Сводка оценок",
    en: "Rating summary",
    w: 320,
    h: 150,
    node: row(
      [
        col(
          [
            txt("4.6", "headline", { bold: true }),
            row(
              ["star", "star", "star", "star", "star_half"].map((n) =>
                ic(n, { size: 16, color: "primary" }),
              ),
              { gap: 0 },
            ),
            txt("2,184 reviews", "caption", { color: "variant" }),
          ],
          {
            gap: 4,
          },
        ),
        col(
          [88, 62, 30, 12, 6].map((v, i) =>
            row(
              [txt(String(5 - i), "caption", { color: "variant" }), { t: "progress", v, grow: 1 }],
              { gap: 8 },
            ),
          ),
          { grow: 1, gap: 6 },
        ),
      ],
      { gap: 20, pad: 16 },
    ),
  },
];

export const presetByKey = (k: string): P | undefined => PRESETS.find((p) => p.key === k);

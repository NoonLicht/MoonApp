import type { FormSpec, Vals } from "@/pages/word/dialogs/form";
import { lenUnit, ptToUnit, unitToPt } from "@/pages/word/lib";
import type { Cx } from "@/pages/word/ribbon/types";

const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : d;
};

const UNDERLINES: [string, string][] = [
  ["none", "None"],
  ["single", "Single"],
  ["double", "Double"],
  ["thick", "Thick"],
  ["dotted", "Dotted"],
  ["dash", "Dashed"],
  ["dotDash", "Dot-dash"],
  ["wave", "Wave"],
  ["words", "Words only"],
];

const BORDER_STYLES: [string, string][] = [
  ["single", "Single"],
  ["double", "Double"],
  ["dotted", "Dotted"],
  ["dashed", "Dashed"],
  ["thick", "Thick"],
  ["triple", "Triple"],
  ["dotDash", "Dot-dash"],
  ["wave", "Wave"],
];

export const font = (cx: Cx): FormSpec => {
  const f = cx.s.format;
  const fonts = cx.ui.fonts.includes(f.font) || !f.font ? cx.ui.fonts : [f.font, ...cx.ui.fonts];
  const initial: Vals = {
    font: f.font || "",
    style: f.bold && f.italic ? "bi" : f.bold ? "b" : f.italic ? "i" : "r",
    size: f.size || 11,
    color: f.color && f.color !== "auto" ? f.color.replace("#", "") : "",
    underline: f.underline ? "single" : "none",
    strike: !!f.strike,
    sup: !!f.superscript,
    sub: !!f.subscript,
    smallCaps: !!f.smallCaps,
    allCaps: !!f.caps,
    hidden: !!f.hidden,
    scale: 100,
    spacing: num(f.spacing, 0),
    position: 0,
  };
  return {
    title: "Font",
    tabs: ["Font", "Advanced"],
    size: "wide",
    init: () => initial,
    fields: [
      { k: "select", key: "font", label: "Font:", options: fonts.map((n) => [n, n]), raw: true },
      {
        k: "radio",
        key: "style",
        label: "Font style:",
        options: [
          ["r", "Regular"],
          ["i", "Italic"],
          ["b", "Bold"],
          ["bi", "Bold Italic"],
        ],
      },
      { k: "num", key: "size", label: "Size:", min: 1, max: 1638, step: 0.5 },
      { k: "color", key: "color", label: "Font color:", allowNone: true, noneLabel: "Automatic" },
      { k: "select", key: "underline", label: "Underline style:", options: UNDERLINES },
      { k: "check", key: "strike", label: "Strikethrough" },
      { k: "check", key: "sup", label: "Superscript" },
      { k: "check", key: "sub", label: "Subscript" },
      { k: "check", key: "smallCaps", label: "Small Caps" },
      { k: "check", key: "allCaps", label: "All Caps" },
      { k: "check", key: "hidden", label: "Hidden" },
      {
        k: "pre",
        render: (v) => (
          <div
            className="wd-preview"
            style={{
              fontFamily: `"${String(v.font)}", sans-serif`,
              fontSize: Math.min(40, num(v.size, 12)),
              fontWeight: String(v.style).includes("b") ? 700 : 400,
              fontStyle: String(v.style).includes("i") ? "italic" : "normal",
              color: v.color ? `#${v.color}` : undefined,
              textDecoration: [
                v.underline !== "none" ? "underline" : "",
                v.strike ? "line-through" : "",
              ].join(" "),
              fontVariant: v.smallCaps ? "small-caps" : undefined,
              textTransform: v.allCaps ? "uppercase" : undefined,
            }}
          >
            {cx.lang === "ru" ? "АаБбВвГгДд AaBbCc" : "AaBbYyZz"}
          </div>
        ),
      },
      { k: "num", key: "scale", label: "Scale:", min: 1, max: 600, unit: "%", tab: 1 },
      { k: "num", key: "spacing", label: "Spacing:", step: 0.1, unit: "pt", tab: 1 },
      { k: "num", key: "position", label: "Position:", step: 0.5, unit: "pt", tab: 1 },
    ],
    submit: (v, c) => {
      const cur = c.s.format;
      if (v.font && v.font !== cur.font) c.run("format.font", { name: v.font });
      if (num(v.size) > 0 && num(v.size) !== cur.size) c.run("format.size", { size: num(v.size) });
      const bold = String(v.style).includes("b");
      const italic = String(v.style).includes("i");
      if (bold !== !!cur.bold) c.run("format.bold", { value: bold });
      if (italic !== !!cur.italic) c.run("format.italic", { value: italic });
      const col = v.color ? String(v.color) : "auto";
      if (col !== (cur.color || "auto").replace("#", "")) c.run("format.color", { color: col });
      if (v.underline === "none") {
        if (cur.underline) c.run("format.underline", { value: false });
      } else c.run("format.underline", { value: true, style: v.underline });
      if (!!v.strike !== !!cur.strike) c.run("format.strikethrough", { value: !!v.strike });
      if (!!v.sup !== !!cur.superscript) c.run("format.superscript");
      if (!!v.sub !== !!cur.subscript) c.run("format.subscript");
      if (!!v.smallCaps !== !!cur.smallCaps) c.run("format.smallCaps");
      if (!!v.allCaps !== !!cur.caps) c.run("format.allCaps");
      if (!!v.hidden !== !!cur.hidden) c.run("format.hidden");
      if (num(v.scale) !== 100) c.run("format.scale", { percent: num(v.scale, 100) });
      if (num(v.spacing) !== num(cur.spacing)) c.run("format.spacing", { points: num(v.spacing) });
      if (num(v.position) !== 0) c.run("format.position", { points: num(v.position) });
    },
  };
};

export const paragraph = (cx: Cx): FormSpec => {
  const p = cx.s.paraResolved;
  const u = lenUnit(cx.lang);
  const ls = (p?.lineSpacing ?? { rule: "multiple", value: 1.15 }) as {
    rule: string;
    value: number;
  };
  const first = p?.indentFirst ?? 0;
  const initial: Vals = {
    align: p?.visualAlign ?? "left",
    outline: "body",
    left: ptToUnit(p?.indentLeft ?? 0, u),
    right: ptToUnit(p?.indentRight ?? 0, u),
    special: first > 0 ? "first" : first < 0 ? "hang" : "none",
    by: ptToUnit(Math.abs(first), u),
    before: p?.spaceBefore ?? 0,
    after: p?.spaceAfter ?? 8,
    rule:
      ls.rule === "multiple"
        ? ls.value === 1
          ? "single"
          : ls.value === 1.5
            ? "oneHalf"
            : ls.value === 2
              ? "double"
              : "multiple"
        : ls.rule,
    at: Math.round(ls.value * 100) / 100,
    keepNext: !!p?.keepNext,
    keepLines: !!p?.keepLines,
    pageBreakBefore: !!p?.pageBreakBefore,
    widow: p?.widowControl !== false,
  };
  return {
    title: "Paragraph Settings",
    tabs: ["Indents and Spacing", "Line and Page Breaks"],
    size: "wide",
    init: () => initial,
    fields: [
      {
        k: "select",
        key: "align",
        label: "Alignment",
        options: [
          ["left", "Align Left"],
          ["center", "Center"],
          ["right", "Align Right"],
          ["justify", "Justify"],
        ],
      },
      { k: "num", key: "left", label: "Left:", step: 0.1, unit: u.name === "cm" ? "cm" : "in" },
      { k: "num", key: "right", label: "Right:", step: 0.1, unit: u.name === "cm" ? "cm" : "in" },
      {
        k: "select",
        key: "special",
        label: "Special:",
        options: [
          ["none", "(none)"],
          ["first", "First line"],
          ["hang", "Hanging"],
        ],
      },
      {
        k: "num",
        key: "by",
        label: "By:",
        step: 0.1,
        unit: u.name === "cm" ? "cm" : "in",
        show: (v) => v.special !== "none",
      },
      { k: "num", key: "before", label: "Before:", unit: "pt", min: 0, max: 1584 },
      { k: "num", key: "after", label: "After:", unit: "pt", min: 0, max: 1584 },
      {
        k: "select",
        key: "rule",
        label: "Line spacing:",
        options: [
          ["single", "Single"],
          ["oneHalf", "1.5 Line Spacing"],
          ["double", "Double"],
          ["atLeast", "At least"],
          ["exactly", "Exactly"],
          ["multiple", "Multiple"],
        ],
      },
      {
        k: "num",
        key: "at",
        label: "At:",
        step: 0.05,
        show: (v) => ["atLeast", "exactly", "multiple"].includes(String(v.rule)),
      },
      { k: "check", key: "widow", label: "Widow/Orphan Control", tab: 1 },
      { k: "check", key: "keepNext", label: "Keep with Next", tab: 1 },
      { k: "check", key: "keepLines", label: "Keep Lines Together", tab: 1 },
      { k: "check", key: "pageBreakBefore", label: "Page Break Before", tab: 1 },
    ],
    submit: (v, c) => {
      const cur = c.s.paraResolved;
      c.run("para.align", { value: v.align });
      const by = unitToPt(num(v.by), u);
      const firstLine = v.special === "first" ? by : v.special === "hang" ? -by : 0;
      c.run("para.indents", {
        left: unitToPt(num(v.left), u),
        right: unitToPt(num(v.right), u),
        firstLine,
      });
      c.run("para.spacing", { before: num(v.before), after: num(v.after) });
      const at = num(v.at, 1);
      if (v.rule === "single") c.run("para.lineSpacing", { value: 1 });
      else if (v.rule === "oneHalf") c.run("para.lineSpacing", { value: 1.5 });
      else if (v.rule === "double") c.run("para.lineSpacing", { value: 2 });
      else if (v.rule === "multiple") c.run("para.lineSpacing", { value: at });
      else if (v.rule === "atLeast") c.run("para.lineSpacing", { atLeast: at });
      else c.run("para.lineSpacing", { exactly: at });
      if (!!v.widow !== (cur?.widowControl !== false))
        c.run("para.widowControl", { value: !!v.widow });
      if (!!v.keepNext !== !!cur?.keepNext) c.run("para.keepNext", { value: !!v.keepNext });
      if (!!v.keepLines !== !!cur?.keepLines) c.run("para.keepLines", { value: !!v.keepLines });
      if (!!v.pageBreakBefore !== !!cur?.pageBreakBefore)
        c.run("para.pageBreakBefore", { value: !!v.pageBreakBefore });
    },
  };
};

const PAPER: [string, string][] = [
  ["Letter", "Letter"],
  ["Legal", "Legal"],
  ["A3", "A3"],
  ["A4", "A4"],
  ["A5", "A5"],
  ["Executive", "Executive"],
  ["Tabloid", "Tabloid"],
  ["custom", "Custom"],
];

const PAPER_SIZES: Record<string, [number, number]> = {
  Letter: [612, 792],
  Legal: [612, 1008],
  A3: [841.9, 1190.6],
  A4: [595.3, 841.9],
  A5: [419.5, 595.3],
  Executive: [522, 756],
  Tabloid: [792, 1224],
};

export const pageSetup = (cx: Cx): FormSpec => {
  const s = cx.s.ctx.section;
  const u = lenUnit(cx.lang);
  const unit = u.name === "cm" ? "cm" : "in";
  const w = Math.min(s.pageW, s.pageH);
  const h = Math.max(s.pageW, s.pageH);
  const name =
    Object.entries(PAPER_SIZES).find(
      ([, [pw, ph]]) => Math.abs(pw - w) < 1.5 && Math.abs(ph - h) < 1.5,
    )?.[0] ?? "custom";
  const initial: Vals = {
    top: ptToUnit(s.marginTop, u),
    bottom: ptToUnit(s.marginBottom, u),
    left: ptToUnit(s.marginLeft, u),
    right: ptToUnit(s.marginRight, u),
    gutter: ptToUnit(s.gutter, u),
    mirror: cx.s.settings.mirrorMargins,
    orient: s.landscape ? "landscape" : "portrait",
    paper: name,
    pw: ptToUnit(w, u),
    ph: ptToUnit(h, u),
    header: ptToUnit(s.header, u),
    footer: ptToUnit(s.footer, u),
    firstPage: !!s.titlePage,
    oddEven: cx.s.settings.evenOdd,
    valign: s.valign || "top",
  };
  return {
    title: "Page Setup",
    tabs: ["Margins", "Paper", "Layout"],
    size: "wide",
    init: () => initial,
    fields: [
      { k: "num", key: "top", label: "Top:", step: 0.1, unit, min: 0 },
      { k: "num", key: "bottom", label: "Bottom:", step: 0.1, unit, min: 0 },
      { k: "num", key: "left", label: "Left:", step: 0.1, unit, min: 0 },
      { k: "num", key: "right", label: "Right:", step: 0.1, unit, min: 0 },
      { k: "num", key: "gutter", label: "Gutter:", step: 0.1, unit, min: 0 },
      {
        k: "radio",
        key: "orient",
        label: "Orientation",
        options: [
          ["portrait", "Portrait"],
          ["landscape", "Landscape"],
        ],
      },
      { k: "check", key: "mirror", label: "Mirrored" },
      { k: "select", key: "paper", label: "Paper size:", options: PAPER, tab: 1 },
      {
        k: "num",
        key: "pw",
        label: "Width:",
        step: 0.1,
        unit,
        min: 0.1,
        tab: 1,
        show: (v) => v.paper === "custom",
      },
      {
        k: "num",
        key: "ph",
        label: "Height:",
        step: 0.1,
        unit,
        min: 0.1,
        tab: 1,
        show: (v) => v.paper === "custom",
      },
      { k: "num", key: "header", label: "Header:", step: 0.1, unit, min: 0, tab: 2 },
      { k: "num", key: "footer", label: "Footer:", step: 0.1, unit, min: 0, tab: 2 },
      { k: "check", key: "firstPage", label: "Different First Page", tab: 2 },
      { k: "check", key: "oddEven", label: "Different Odd & Even Pages", tab: 2 },
      {
        k: "select",
        key: "valign",
        label: "Vertical alignment:",
        tab: 2,
        options: [
          ["top", "Top"],
          ["center", "Center"],
          ["justify", "Justified"],
          ["bottom", "Bottom"],
        ],
      },
    ],
    submit: (v, c) => {
      const cur = c.s.ctx.section;
      c.run("layout.margins", {
        top: unitToPt(num(v.top), u),
        bottom: unitToPt(num(v.bottom), u),
        left: unitToPt(num(v.left), u),
        right: unitToPt(num(v.right), u),
        gutter: unitToPt(num(v.gutter), u),
        mirror: !!v.mirror,
      });
      if (v.paper === "custom")
        c.run("layout.size", { width: unitToPt(num(v.pw), u), height: unitToPt(num(v.ph), u) });
      else if (v.paper !== name) c.run("layout.size", { name: v.paper });
      if ((v.orient === "landscape") !== cur.landscape || v.paper !== name)
        c.run("layout.orientation", { value: v.orient });
      c.run("hf.position", {
        header: unitToPt(num(v.header), u),
        footer: unitToPt(num(v.footer), u),
      });
      if (!!v.firstPage !== !!cur.titlePage) c.run("layout.differentFirstPage");
      if (!!v.oddEven !== c.s.settings.evenOdd) c.run("layout.differentOddEven");
      c.run("layout.verticalAlign", { value: v.valign });
    },
  };
};

export const columns = (cx: Cx): FormSpec => {
  const s = cx.s.ctx.section.columns;
  const u = lenUnit(cx.lang);
  return {
    title: "Columns",
    init: () => ({
      count: s.count,
      space: ptToUnit(s.space, u),
      sep: !!s.separator,
      apply: "section",
    }),
    fields: [
      { k: "num", key: "count", label: "Number of columns:", min: 1, max: 12 },
      {
        k: "num",
        key: "space",
        label: "Spacing:",
        step: 0.1,
        unit: u.name === "cm" ? "cm" : "in",
        min: 0,
      },
      { k: "check", key: "sep", label: "Line between" },
      {
        k: "select",
        key: "apply",
        label: "Apply to:",
        options: [
          ["section", "This section"],
          ["document", "Whole document"],
          ["forward", "This point forward"],
        ],
      },
    ],
    submit: (v, c) =>
      c.run("layout.columns", {
        count: num(v.count, 1),
        space: unitToPt(num(v.space), u),
        separator: !!v.sep,
        apply: v.apply,
      }),
  };
};

export const lineNumbers = (): FormSpec => ({
  title: "Line Numbering Options…",
  init: () => ({ mode: "continuous", start: 1, countBy: 1, distance: 0 }),
  fields: [
    {
      k: "select",
      key: "mode",
      label: "Numbering:",
      options: [
        ["none", "None"],
        ["continuous", "Continuous"],
        ["restartPage", "Restart Each Page"],
        ["restartSection", "Restart Each Section"],
      ],
    },
    {
      k: "num",
      key: "start",
      label: "Start at:",
      min: 1,
      max: 32767,
      show: (v) => v.mode !== "none",
    },
    {
      k: "num",
      key: "countBy",
      label: "Count by:",
      min: 1,
      max: 100,
      show: (v) => v.mode !== "none",
    },
    {
      k: "num",
      key: "distance",
      label: "From text:",
      unit: "pt",
      min: 0,
      show: (v) => v.mode !== "none",
    },
    { k: "note", text: "Distance 0 = automatic.", show: (v) => v.mode !== "none" },
  ],
  submit: (v, c) =>
    c.run("layout.lineNumbers", {
      value: v.mode,
      start: num(v.start, 1),
      countBy: num(v.countBy, 1),
      distance: num(v.distance),
    }),
});

export const hyphenation = (cx: Cx): FormSpec => ({
  title: "Hyphenation Options…",
  init: () => ({ auto: cx.s.settings.autoHyphenation, caps: true, zone: 18, limit: 0 }),
  fields: [
    { k: "check", key: "auto", label: "Automatic" },
    { k: "check", key: "caps", label: "Hyphenate words in CAPS" },
    { k: "num", key: "zone", label: "Hyphenation zone:", unit: "pt", min: 0 },
    { k: "num", key: "limit", label: "Limit consecutive hyphens to:", min: 0 },
  ],
  submit: (v, c) =>
    c.run("layout.hyphenation", {
      value: !!v.auto,
      caps: !!v.caps,
      zone: num(v.zone, 18),
      limit: num(v.limit),
    }),
});

export const paragraphBorders = (): FormSpec => ({
  title: "Borders and Shading…",
  init: () => ({
    kind: "outside",
    style: "single",
    width: 0.75,
    color: "000000",
    shade: "",
    shadeOn: false,
  }),
  fields: [
    {
      k: "select",
      key: "kind",
      label: "Setting:",
      options: [
        ["none", "No Border"],
        ["outside", "Outside Borders"],
        ["all", "All Borders"],
        ["bottom", "Bottom Border"],
        ["top", "Top Border"],
        ["left", "Left Border"],
        ["right", "Right Border"],
        ["horizontalLine", "Horizontal Line"],
      ],
    },
    { k: "select", key: "style", label: "Style:", options: BORDER_STYLES },
    { k: "num", key: "width", label: "Width:", unit: "pt", step: 0.25, min: 0.25, max: 6 },
    { k: "color", key: "color", label: "Color:" },
    { k: "check", key: "shadeOn", label: "Shading" },
    { k: "color", key: "shade", label: "Fill:", show: (v) => !!v.shadeOn },
  ],
  submit: (v, c) => {
    c.run("para.borders", {
      kind: v.kind,
      style: v.style,
      width: num(v.width, 0.75),
      color: v.color,
    });
    if (v.shadeOn) c.run("para.shading", { color: v.shade || "FFFF00" });
  },
});

export const defineBullet = (): FormSpec => ({
  title: "Define New Bullet…",
  init: () => ({ char: "•" }),
  fields: [{ k: "text", key: "char", label: "Bullet character:" }],
  submit: (v, c) => c.run("para.defineBullet", { char: String(v.char || "•").slice(0, 2) }),
});

export const defineNumber = (): FormSpec => ({
  title: "Define New Number Format…",
  init: () => ({ format: "decimal", text: "%1.", start: 1 }),
  fields: [
    {
      k: "select",
      key: "format",
      label: "Number style:",
      options: [
        ["decimal", "1, 2, 3, …"],
        ["upperRoman", "I, II, III, …"],
        ["lowerRoman", "i, ii, iii, …"],
        ["upperLetter", "A, B, C, …"],
        ["lowerLetter", "a, b, c, …"],
        ["decimalZero", "01, 02, 03, …"],
        ["ordinal", "1st, 2nd, 3rd, …"],
      ],
      raw: false,
    },
    { k: "text", key: "text", label: "Number format:" },
    { k: "num", key: "start", label: "Start at:", min: 0 },
    { k: "note", text: "Use %1 for the number, e.g. %1. or (%1)", raw: false },
  ],
  submit: (v, c) =>
    c.run("para.defineNumber", { format: v.format, text: v.text, start: num(v.start, 1) }),
});

export const defineMultilevel = (): FormSpec => ({
  title: "Define New Multilevel List…",
  size: "wide",
  init: () => ({
    kind: "legal",
    f1: "decimal",
    t1: "%1.",
    f2: "decimal",
    t2: "%1.%2.",
    f3: "decimal",
    t3: "%1.%2.%3.",
  }),
  fields: [
    ...[1, 2, 3].flatMap((n): FormSpec["fields"] => [
      {
        k: "select",
        key: `f${n}`,
        label: `Change to Level ${n}`,
        options: [
          ["decimal", "1, 2, 3, …"],
          ["upperRoman", "I, II, III, …"],
          ["lowerRoman", "i, ii, iii, …"],
          ["upperLetter", "A, B, C, …"],
          ["lowerLetter", "a, b, c, …"],
        ],
      },
      { k: "text", key: `t${n}`, label: "Number format:" },
    ]),
  ],
  submit: (v, c) =>
    c.run("list.define", {
      levels: [1, 2, 3].map((n) => ({ format: v[`f${n}`], text: v[`t${n}`] })),
      apply: true,
    }),
});

export const setNumberingValue = (): FormSpec => ({
  title: "Set Numbering Value…",
  init: () => ({ value: 1 }),
  fields: [{ k: "num", key: "value", label: "Set value to:", min: 0 }],
  submit: (v, c) => c.run("para.setNumberingValue", { value: num(v.value, 1) }),
});

export const phonetic = (): FormSpec => ({
  title: "Phonetic Guide",
  init: () => ({ ruby: "", align: "center", size: 6, offset: 0 }),
  fields: [
    { k: "text", key: "ruby", label: "Ruby text:" },
    {
      k: "select",
      key: "align",
      label: "Alignment:",
      options: [
        ["center", "Center"],
        ["left", "Align Left"],
        ["right", "Align Right"],
        ["distributeLetter", "Distributed"],
      ],
    },
    { k: "num", key: "size", label: "Size:", unit: "pt", min: 1 },
    { k: "num", key: "offset", label: "Offset:", unit: "pt" },
  ],
  submit: (v, c) =>
    c.run("format.phonetic", {
      ruby: v.ruby || null,
      align: v.align,
      size: num(v.size, 6),
      offset: num(v.offset),
    }),
});

export const enclose = (): FormSpec => ({
  title: "Enclose Characters",
  init: () => ({ shape: "circle", style: "shrink", text: "" }),
  fields: [
    {
      k: "select",
      key: "shape",
      label: "Enclosure:",
      options: [
        ["circle", "Circle"],
        ["square", "Square"],
        ["triangle", "Triangle"],
        ["diamond", "Diamond"],
        ["none", "None"],
      ],
    },
    {
      k: "radio",
      key: "style",
      label: "Style:",
      options: [
        ["shrink", "Shrink text"],
        ["enlarge", "Enlarge symbol"],
      ],
    },
    { k: "text", key: "text", label: "Text:" },
  ],
  submit: (v, c) =>
    c.run("format.enclose", {
      shape: v.shape === "none" ? null : v.shape,
      style: v.style,
      text: v.text || undefined,
    }),
});

export const dropCap = (): FormSpec => ({
  title: "Drop Cap",
  init: () => ({ lines: 3 }),
  fields: [{ k: "num", key: "lines", label: "Lines to drop:", min: 0, max: 10 }],
  submit: (v, c) => c.run("insert.dropCap", { lines: num(v.lines, 3) }),
});

export const pageNumberFormat = (cx: Cx): FormSpec => ({
  title: "Format Page Numbers…",
  init: () => ({ format: cx.s.ctx.section.pageNumFormat || "decimal", start: 1 }),
  fields: [
    {
      k: "select",
      key: "format",
      label: "Number format:",
      options: [
        ["decimal", "1, 2, 3, …"],
        ["lowerRoman", "i, ii, iii, …"],
        ["upperRoman", "I, II, III, …"],
        ["lowerLetter", "a, b, c, …"],
        ["upperLetter", "A, B, C, …"],
      ],
    },
    { k: "num", key: "start", label: "Start at:", min: 0 },
  ],
  submit: (v, c) => c.run("layout.pageNumberFormat", { format: v.format, start: num(v.start, 1) }),
});

export const watermark = (): FormSpec => ({
  title: "Custom Watermark…",
  init: () => ({ text: "DRAFT", diagonal: true, color: "C0C0C0" }),
  fields: [
    { k: "text", key: "text", label: "Text:" },
    { k: "color", key: "color", label: "Color:" },
    { k: "check", key: "diagonal", label: "Diagonal" },
  ],
  submit: (v, c) =>
    c.run("design.watermark", { text: v.text, diagonal: !!v.diagonal, color: v.color }),
});

export const pageBorders = (): FormSpec => ({
  title: "Page Borders",
  init: () => ({ kind: "box", style: "single", width: 1, color: "000000", applyTo: "document" }),
  fields: [
    {
      k: "radio",
      key: "kind",
      label: "Setting:",
      options: [
        ["none", "None"],
        ["box", "Box"],
      ],
    },
    {
      k: "select",
      key: "style",
      label: "Style:",
      options: BORDER_STYLES,
      show: (v) => v.kind === "box",
    },
    {
      k: "num",
      key: "width",
      label: "Width:",
      unit: "pt",
      step: 0.25,
      min: 0.25,
      max: 6,
      show: (v) => v.kind === "box",
    },
    { k: "color", key: "color", label: "Color:", show: (v) => v.kind === "box" },
    {
      k: "select",
      key: "applyTo",
      label: "Apply to:",
      options: [
        ["document", "Whole document"],
        ["section", "This section"],
      ],
    },
  ],
  submit: (v, c) =>
    c.run("design.pageBorders", {
      kind: v.kind,
      style: v.style,
      width: num(v.width, 1),
      color: v.color,
      applyTo: v.applyTo,
    }),
});

export const coverPage = (cx: Cx): FormSpec => ({
  title: "Cover Page",
  init: () => ({ title: "", subtitle: "", author: cx.s.settings.author }),
  fields: [
    { k: "text", key: "title", label: "Title" },
    { k: "text", key: "subtitle", label: "Subtitle" },
    { k: "text", key: "author", label: "Author" },
  ],
  submit: (v, c) =>
    c.run("insert.coverPage", { title: v.title, subtitle: v.subtitle, author: v.author }),
});

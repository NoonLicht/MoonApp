import { useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  GitCompare,
  Regex,
  Hash,
  Fingerprint,
  Binary,
  Calculator,
  Copy,
  AlertTriangle,
  GripVertical,
} from "lucide-react";
import { Glass, Btn, SectionHead, Field, Select, Badge } from "@/components/ui";
import { copyToClipboard } from "@/components/ContextMenu";
import { useI18n } from "@/app/i18n";

type ToolId = "json" | "diff" | "regex" | "encode" | "uuid" | "base" | "units";

/* ───────────────────────── JSON ───────────────────────── */

function JsonTool() {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");

  const run = (mode: "format" | "minify") => {
    try {
      const parsed = JSON.parse(input);
      setOutput(mode === "format" ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed));
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setOutput("");
    }
  };

  return (
    <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
      <textarea
        className="text-input"
        style={{ flex: 1, fontFamily: "var(--font-mono)", resize: "none" }}
        placeholder={t("tools.jsonPlaceholder")}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 8, minHeight: 0 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn icon={Braces} onClick={() => run("format")}>
            {t("tools.jsonFormat")}
          </Btn>
          <Btn onClick={() => run("minify")}>{t("tools.jsonMinify")}</Btn>
          {output && (
            <Btn icon={Copy} onClick={() => copyToClipboard(output)}>
              {t("ctx.copyName")}
            </Btn>
          )}
        </div>
        {error && (
          <div style={{ color: "var(--coral)", display: "flex", gap: 6, alignItems: "center" }}>
            <AlertTriangle size={14} /> {error}
          </div>
        )}
        <textarea
          className="text-input"
          readOnly
          style={{ flex: 1, fontFamily: "var(--font-mono)", resize: "none" }}
          value={output}
        />
      </div>
    </div>
  );
}

/* ───────────────────────── Diff ───────────────────────── */

interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

/** Построчный LCS-дифф (динамическое программирование) — быстрый и понятный для текстов разумного размера. */
function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  // Ограничение по размеру: O(n*m) память/время — не годится для гигантских файлов.
  if (n * m > 4_000_000) return [{ type: "same", text: "Слишком большой текст для сравнения" }];
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: "same", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: A[i] });
      i++;
    } else {
      out.push({ type: "add", text: B[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: A[i++] });
  while (j < m) out.push({ type: "add", text: B[j++] });
  return out;
}

function DiffTool() {
  const { t } = useI18n();
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [result, setResult] = useState<DiffLine[] | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
        <textarea
          className="text-input"
          style={{ flex: 1, fontFamily: "var(--font-mono)", resize: "none" }}
          placeholder={t("tools.diffA")}
          value={a}
          onChange={(e) => setA(e.target.value)}
        />
        <textarea
          className="text-input"
          style={{ flex: 1, fontFamily: "var(--font-mono)", resize: "none" }}
          placeholder={t("tools.diffB")}
          value={b}
          onChange={(e) => setB(e.target.value)}
        />
      </div>
      <Btn icon={GitCompare} onClick={() => setResult(lineDiff(a, b))} style={{ width: 160 }}>
        {t("tools.diffGo")}
      </Btn>
      {result && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            background: "var(--bg-base-2, rgba(0,0,0,0.15))",
            borderRadius: 8,
            padding: 10,
          }}
        >
          {result.map((l, i) => (
            <div
              key={i}
              style={{
                whiteSpace: "pre-wrap",
                color:
                  l.type === "add" ? "var(--success)" : l.type === "del" ? "var(--coral)" : "var(--text-secondary)",
                background:
                  l.type === "add"
                    ? "rgba(63,199,171,0.08)"
                    : l.type === "del"
                      ? "rgba(234,107,107,0.08)"
                      : "transparent",
              }}
            >
              {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
              {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Regex ───────────────────────── */

const REGEX_FLAGS: { flag: string; labelKey: string }[] = [
  { flag: "g", labelKey: "tools.flagGlobal" },
  { flag: "i", labelKey: "tools.flagIgnoreCase" },
  { flag: "m", labelKey: "tools.flagMultiline" },
  { flag: "s", labelKey: "tools.flagDotAll" },
  { flag: "u", labelKey: "tools.flagUnicode" },
  { flag: "y", labelKey: "tools.flagSticky" },
];

/** Экранирует HTML, оставляя только <mark> вокруг совпадений — без dangerouslySetInnerHTML
 * поверх чужого regex-ввода в остальном тексте. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function RegexTool() {
  const { t } = useI18n();
  const [pattern, setPattern] = useState("");
  const [flagSet, setFlagSet] = useState<Set<string>>(new Set(["g"]));
  const [text, setText] = useState("");

  const flags = [...flagSet].join("");
  const toggleFlag = (f: string) =>
    setFlagSet((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  const { matches, error } = useMemo(() => {
    if (!pattern) return { matches: [] as RegExpMatchArray[], error: "" };
    try {
      const re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
      return { matches: [...text.matchAll(re)], error: "" };
    } catch (e) {
      return { matches: [] as RegExpMatchArray[], error: (e as Error).message };
    }
  }, [pattern, flags, text]);

  const highlightedHtml = useMemo(() => {
    if (!matches.length) return escapeHtml(text);
    let out = "";
    let last = 0;
    for (const m of matches) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (end <= last) continue; // защита от нулевой длины/наложений
      out += escapeHtml(text.slice(last, start));
      out += `<mark>${escapeHtml(text.slice(start, end))}</mark>`;
      last = end;
    }
    out += escapeHtml(text.slice(last));
    return out;
  }, [matches, text]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
      <input
        className="text-input"
        placeholder={t("tools.regexPattern")}
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
      />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {REGEX_FLAGS.map(({ flag, labelKey }) => (
          <label
            key={flag}
            className="muted-sm"
            title={t(labelKey)}
            style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
          >
            <input type="checkbox" checked={flagSet.has(flag)} onChange={() => toggleFlag(flag)} />
            <code>{flag}</code>
          </label>
        ))}
      </div>
      {error && (
        <div style={{ color: "var(--coral)", display: "flex", gap: 6, alignItems: "center" }}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}
      <textarea
        className="text-input"
        style={{ flex: 1, fontFamily: "var(--font-mono)", resize: "none", minHeight: 60 }}
        placeholder={t("tools.regexText")}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="muted-sm">{t("tools.regexMatches", { n: matches.length })}</div>
      {text && (
        <div
          className="regex-highlight-preview"
          style={{
            flex: 1,
            minHeight: 60,
            maxHeight: 160,
            overflow: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            padding: 8,
          }}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      )}
      <div style={{ maxHeight: 120, overflow: "auto", fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
        {matches.map((m, i) => (
          <div key={i}>
            [{i}] "{m[0]}" {m.length > 1 ? `→ groups: ${JSON.stringify(m.slice(1))}` : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Base64/URL/Hash ───────────────────────── */

async function sha(algo: string, text: string): Promise<string> {
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function EncodeTool() {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [b64, setB64] = useState({ enc: "", dec: "" });
  const [urlEnc, setUrlEnc] = useState("");
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const run = async () => {
    setError("");
    try {
      setB64({ enc: btoa(unescape(encodeURIComponent(input))), dec: "" });
    } catch {
      setB64({ enc: "", dec: "" });
    }
    setUrlEnc(encodeURIComponent(input));
    try {
      const [sha1, sha256, sha384, sha512] = await Promise.all([
        sha("SHA-1", input),
        sha("SHA-256", input),
        sha("SHA-384", input),
        sha("SHA-512", input),
      ]);
      setHashes({ "SHA-1": sha1, "SHA-256": sha256, "SHA-384": sha384, "SHA-512": sha512 });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const decodeB64 = () => {
    try {
      const cleaned = input.trim().replace(/\s+/g, "");
      if (!cleaned || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
        throw new Error(t("tools.encodeB64Invalid"));
      }
      setB64((s) => ({ ...s, dec: decodeURIComponent(escape(atob(cleaned))) }));
      setError("");
    } catch (e) {
      setB64((s) => ({ ...s, dec: "" }));
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const row = (label: string, value: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="muted-sm" style={{ width: 90, flexShrink: 0 }}>
        {label}
      </span>
      <code style={{ wordBreak: "break-all", flex: 1, fontSize: 12 }}>{value}</code>
      {value && (
        <button type="button" className="icon-btn" onClick={() => copyToClipboard(value)}>
          <Copy size={13} />
        </button>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <textarea
        className="text-input"
        style={{ minHeight: 90, fontFamily: "var(--font-mono)" }}
        placeholder={t("tools.encodePlaceholder")}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <Btn icon={Hash} onClick={() => void run()}>
          {t("tools.encodeRun")}
        </Btn>
        <Btn onClick={decodeB64}>{t("tools.encodeB64Decode")}</Btn>
      </div>
      {error && <div style={{ color: "var(--coral)" }}>{error}</div>}
      <Glass style={{ flexDirection: "column", alignItems: "stretch", gap: 6, padding: 12 }}>
        {row("Base64", b64.enc)}
        {b64.dec && row(t("tools.encodeB64Decode"), b64.dec)}
        {row("URL", urlEnc)}
        {Object.entries(hashes).map(([k, v]) => row(k, v))}
      </Glass>
    </div>
  );
}

/* ───────────────────────── UUID ───────────────────────── */

function UuidTool() {
  const { t } = useI18n();
  const [count, setCount] = useState(5);
  const [ids, setIds] = useState<string[]>([]);

  const gen = () => setIds(Array.from({ length: count }, () => crypto.randomUUID()));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          className="text-input"
          type="number"
          style={{ width: 64 }}
          min={1}
          max={100}
          value={count}
          onChange={(e) => setCount(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
        />
        <Btn icon={Fingerprint} onClick={gen} style={{ flex: 1 }}>
          {t("tools.uuidGenerate")}
        </Btn>
        {ids.length > 0 && (
          <button
            type="button"
            className="icon-btn"
            title={t("ctx.copyName")}
            onClick={() => copyToClipboard(ids.join("\n"))}
          >
            <Copy size={14} />
          </button>
        )}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          maxHeight: 140,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {ids.map((id) => (
          <div
            key={id}
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{id}</span>
            <button
              type="button"
              className="icon-btn"
              style={{ width: 20, height: 20, flexShrink: 0 }}
              onClick={() => copyToClipboard(id)}
            >
              <Copy size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Number base converter ───────────────────────── */

function BaseTool() {
  const { t } = useI18n();
  const [dec, setDec] = useState("");
  const [hex, setHex] = useState("");
  const [oct, setOct] = useState("");
  const [bin, setBin] = useState("");
  const [error, setError] = useState("");

  const update = (value: string, radix: number) => {
    setError("");
    const clean = value.trim();
    if (!clean) {
      setDec("");
      setHex("");
      setOct("");
      setBin("");
      return;
    }
    const n = parseInt(clean, radix);
    if (!Number.isFinite(n) || Number.isNaN(n)) {
      setError(t("tools.baseInvalid"));
      return;
    }
    setDec(n.toString(10));
    setHex(n.toString(16).toUpperCase());
    setOct(n.toString(8));
    setBin(n.toString(2));
  };

  const field = (label: string, value: string, radix: number, onChange: (v: string) => void) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="muted-sm" style={{ width: 34, flexShrink: 0, fontFamily: "var(--font-mono)" }}>
        {label}
      </span>
      <input
        className="text-input"
        style={{ flex: 1, fontFamily: "var(--font-mono)" }}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          update(e.target.value, radix);
        }}
      />
      {value && (
        <button
          type="button"
          className="icon-btn"
          style={{ width: 22, height: 22, flexShrink: 0 }}
          onClick={() => copyToClipboard(value)}
        >
          <Copy size={12} />
        </button>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {field("DEC", dec, 10, setDec)}
      {field("HEX", hex, 16, setHex)}
      {field("OCT", oct, 8, setOct)}
      {field("BIN", bin, 2, setBin)}
      {error && <div style={{ color: "var(--coral)", fontSize: 12 }}>{error}</div>}
    </div>
  );
}

/* ───────────────────────── Units + calculator ───────────────────────── */

const LENGTH_UNITS: Record<string, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  yd: 0.9144,
  mi: 1609.344,
};
const WEIGHT_UNITS: Record<string, number> = {
  mg: 0.001,
  g: 1,
  kg: 1000,
  t: 1_000_000,
  oz: 28.3495,
  lb: 453.592,
};

// Безопасный вычислитель арифметики: + - * / и скобки, без eval/Function.
function evalExpr(src: string): number {
  let i = 0;
  const s = src.replace(/\s+/g, "");
  const peek = () => s[i];
  const parseNum = (): number => {
    const start = i;
    if (s[i] === "-" || s[i] === "+") i++;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    const n = parseFloat(s.slice(start, i));
    if (Number.isNaN(n)) throw new Error("bad number");
    return n;
  };
  const parseFactor = (): number => {
    if (peek() === "(") {
      i++;
      const v = parseExpr();
      if (peek() !== ")") throw new Error("expected )");
      i++;
      return v;
    }
    return parseNum();
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = s[i++];
      const rhs = parseFactor();
      v = op === "*" ? v * rhs : v / rhs;
    }
    return v;
  };
  const parseExpr = (): number => {
    let v = parseTerm();
    while (peek() === "+" || (peek() === "-" && i > 0)) {
      const op = s[i++];
      const rhs = parseTerm();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  };
  const result = parseExpr();
  if (i !== s.length) throw new Error("unexpected trailing input");
  return result;
}

function UnitsTool() {
  const { t } = useI18n();
  const [category, setCategory] = useState<"length" | "weight" | "temp">("length");
  const [value, setValue] = useState("1");
  const [from, setFrom] = useState("m");
  const [to, setTo] = useState("km");

  const units = category === "length" ? LENGTH_UNITS : category === "weight" ? WEIGHT_UNITS : null;

  const result = useMemo(() => {
    const n = parseFloat(value);
    if (Number.isNaN(n)) return "";
    if (category === "temp") {
      // from/to: C, F, K
      const toC = from === "C" ? n : from === "F" ? ((n - 32) * 5) / 9 : n - 273.15;
      const out = to === "C" ? toC : to === "F" ? (toC * 9) / 5 + 32 : toC + 273.15;
      return out.toFixed(4);
    }
    if (!units) return "";
    const base = n * (units[from] ?? 1);
    return (base / (units[to] ?? 1)).toFixed(6);
  }, [value, from, to, category, units]);

  const [expr, setExpr] = useState("");
  const [calcResult, setCalcResult] = useState<string>("");
  const [calcError, setCalcError] = useState("");

  const runCalc = () => {
    try {
      setCalcResult(String(evalExpr(expr)));
      setCalcError("");
    } catch (e) {
      setCalcError((e as Error).message);
      setCalcResult("");
    }
  };

  const unitOptions =
    category === "temp"
      ? ["C", "F", "K"]
      : Object.keys(units || {});

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          {(["length", "weight", "temp"] as const).map((c) => (
            <Badge key={c} tone={category === c ? "amber" : "neutral"} onClick={() => setCategory(c)}>
              {t(`tools.unitCat_${c}`)}
            </Badge>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label={t("tools.unitValue")}>
            <input
              className="text-input"
              style={{ width: 100 }}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <Field label={t("tools.unitFrom")}>
            <Select
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              options={unitOptions.map((u) => ({ value: u, label: u }))}
            />
          </Field>
          <Field label={t("tools.unitTo")}>
            <Select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              options={unitOptions.map((u) => ({ value: u, label: u }))}
            />
          </Field>
          <div style={{ padding: "8px 0", fontFamily: "var(--font-mono)", fontSize: 15 }}>= {result}</div>
        </div>
      </div>

      <div>
        <div className="set-label" style={{ marginBottom: 6 }}>
          {t("tools.calculator")}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            className="text-input"
            style={{ flex: 1, fontFamily: "var(--font-mono)" }}
            placeholder="2*(3+4)/7"
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runCalc()}
          />
          <Btn icon={Calculator} onClick={runCalc}>
            =
          </Btn>
        </div>
        {calcError && <div style={{ color: "var(--coral)" }}>{calcError}</div>}
        {calcResult && (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, marginTop: 6 }}>{calcResult}</div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Page: адаптивная сетка виджетов ───────────────────────── */

const TOOLS: { id: ToolId; icon: React.ElementType; Component: React.ComponentType }[] = [
  { id: "json", icon: Braces, Component: JsonTool },
  { id: "diff", icon: GitCompare, Component: DiffTool },
  { id: "regex", icon: Regex, Component: RegexTool },
  { id: "encode", icon: Hash, Component: EncodeTool },
  { id: "uuid", icon: Fingerprint, Component: UuidTool },
  { id: "base", icon: Binary, Component: BaseTool },
  { id: "units", icon: Calculator, Component: UnitsTool },
];
const TOOL_IDS = TOOLS.map((x) => x.id);

const ORDER_KEY = "moonapp.tools.widgetOrder";
const SIZE_KEY = "moonapp.tools.widgetSizes";

function loadOrder(): ToolId[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]") as string[];
    const valid = raw.filter((id): id is ToolId => TOOL_IDS.includes(id as ToolId));
    const missing = TOOL_IDS.filter((id) => !valid.includes(id));
    return [...valid, ...missing];
  } catch {
    return TOOL_IDS;
  }
}

function loadSizes(): Partial<Record<ToolId, { w: number; h: number }>> {
  try {
    return JSON.parse(localStorage.getItem(SIZE_KEY) || "{}");
  } catch {
    return {};
  }
}

/** Виджет-карточка: заголовок с ручкой перетаскивания (реордер сеткой,
 * HTML5 drag&drop — без новой библиотеки) + нативный resize:both для
 * изменения размера (браузер сам рисует уголок-хват, размер сохраняется
 * в localStorage через ResizeObserver). */
function ToolWidget({
  id,
  icon: Icon,
  Component,
  size,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onResize,
}: {
  id: ToolId;
  icon: React.ElementType;
  Component: React.ComponentType;
  size?: { w: number; h: number };
  dragging: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onResize: (size: { w: number; h: number }) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      onResize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      className={`tools-widget${dragging ? " is-dragging" : ""}`}
      style={{
        width: size?.w,
        height: size?.h,
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="tools-widget-head" draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <GripVertical size={13} className="tools-widget-grip" />
        <Icon size={14} />
        <span>{t(`tools.tab_${id}`)}</span>
      </div>
      <div className="tools-widget-body">
        <Component />
      </div>
    </div>
  );
}

export default function ToolsPage() {
  const { t } = useI18n();
  const [order, setOrder] = useState<ToolId[]>(() => loadOrder());
  const [sizes, setSizes] = useState<Partial<Record<ToolId, { w: number; h: number }>>>(() => loadSizes());
  const [draggedId, setDraggedId] = useState<ToolId | null>(null);
  const sizeSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  }, [order]);

  const reorder = (targetId: ToolId) => {
    if (!draggedId || draggedId === targetId) return;
    setOrder((prev) => {
      const next = prev.filter((id) => id !== draggedId);
      const idx = next.indexOf(targetId);
      next.splice(idx, 0, draggedId);
      return next;
    });
  };

  const persistSize = (id: ToolId, size: { w: number; h: number }) => {
    setSizes((prev) => {
      const next = { ...prev, [id]: size };
      if (sizeSaveTimer.current) clearTimeout(sizeSaveTimer.current);
      sizeSaveTimer.current = setTimeout(() => {
        localStorage.setItem(SIZE_KEY, JSON.stringify(next));
      }, 300);
      return next;
    });
  };

  const byId = useMemo(() => Object.fromEntries(TOOLS.map((x) => [x.id, x])), []);

  return (
    <div className="page">
      <SectionHead eyebrow={t("tools.eyebrow")} title={t("tools.title")} />
      <div className="muted-sm" style={{ margin: "4px 0 10px" }}>
        {t("tools.gridHint")}
      </div>
      <div className="tools-grid-scroll">
        <div className="tools-grid">
          {order.map((id) => {
            const tool = byId[id];
            return (
              <ToolWidget
                key={id}
                id={id}
                icon={tool.icon}
                Component={tool.Component}
                size={sizes[id]}
                dragging={draggedId === id}
                onDragStart={() => setDraggedId(id)}
                onDragOver={(e) => {
                  e.preventDefault();
                  reorder(id);
                }}
                onDrop={() => setDraggedId(null)}
                onDragEnd={() => setDraggedId(null)}
                onResize={(size) => persistSize(id, size)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

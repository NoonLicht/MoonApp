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
  Shuffle,
  RotateCcw,
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
            style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          >
            <input type="checkbox" checked={flagSet.has(flag)} onChange={() => toggleFlag(flag)} />
            <code>{flag}</code>
            <span>— {t(labelKey)}</span>
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

/* ───────────────────────── Page: плиточная сетка (BSP-тайлинг) ─────────────────────────
 *
 * Раньше сетка была CSS Grid'ом с dense-packing: карточки "плавали" — их
 * реальные границы не совпадали с занимаемыми клетками, соседи наезжали друг
 * на друга, а resize:both за уголок мог утащить карточку за пределы
 * контейнера без возможности вернуть обратно (у самого uголка не было
 * верхней/левой границы, которую можно было бы потянуть назад).
 *
 * Теперь это честный тайлинг как в оконных менеджерах (i3/BSP): дерево
 * бинарных разбиений прямоугольника — каждый узел либо инструмент (лист),
 * либо разбиение родительского прямоугольника на две части по горизонтали
 * ("x") или вертикали ("y") с заданным соотношением. Такое разбиение
 * математически не может оставить пустот или наложений — сумма долей двух
 * половин всегда равна родительскому прямоугольнику. Тянуть можно только
 * саму границу между двумя соседними блоками (боковую/верхнюю/нижнюю) —
 * она двигает ровно эту пару, все остальные блоки остаются на месте.
 * Порядок инструментов меняется перетаскиванием заголовка одного блока на
 * заголовок другого — блоки меняются местами, а не "плавают" поверх сетки.
 */

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

const TREE_KEY = "moonapp.tools.tileTree";
const MIN_TILE_PX = 200;
const GAP = 8;
const DIVIDER_PX = 8;

type Dir = "x" | "y"; // x — бок о бок (делим ширину), y — друг под другом (делим высоту)
type TilePath = ("a" | "b")[];
interface LeafNode {
  type: "leaf";
  toolId: ToolId;
}
interface SplitNode {
  type: "split";
  dir: Dir;
  ratio: number; // доля блока "a" от родителя, 0..1
  a: TileTree;
  b: TileTree;
}
type TileTree = LeafNode | SplitNode;
type Rect = { x: number; y: number; w: number; h: number };

function leaf(toolId: ToolId): LeafNode {
  return { type: "leaf", toolId };
}
function makeSplit(dir: Dir, ratio: number, a: TileTree, b: TileTree): SplitNode {
  return { type: "split", dir, ratio, a, b };
}

/** Дефолтное дерево: сбалансированное рекурсивное разбиение пополам,
 * чередуя направление — визуально получается что-то вроде равномерной
 * сетки, но остаётся честным тайлингом при любом числе инструментов
 * (в том числе если список TOOLS в будущем изменится). */
function buildDefaultTree(ids: ToolId[]): TileTree {
  function rec(list: ToolId[], dir: Dir): TileTree {
    if (list.length === 1) return leaf(list[0]);
    const mid = Math.ceil(list.length / 2);
    const a = list.slice(0, mid);
    const b = list.slice(mid);
    const nextDir: Dir = dir === "x" ? "y" : "x";
    return makeSplit(dir, a.length / list.length, rec(a, nextDir), rec(b, nextDir));
  }
  return rec(ids, "y");
}

/** Случайное дерево — перетасованный порядок инструментов и случайные
 * направления/соотношения разбиений (в разумных пределах 0.3–0.7). */
function buildRandomTree(ids: ToolId[]): TileTree {
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  function rec(list: ToolId[]): TileTree {
    if (list.length === 1) return leaf(list[0]);
    const cut = 1 + Math.floor(Math.random() * (list.length - 1));
    const dir: Dir = Math.random() < 0.5 ? "x" : "y";
    const ratio = 0.3 + Math.random() * 0.4;
    return makeSplit(dir, ratio, rec(list.slice(0, cut)), rec(list.slice(cut)));
  }
  return rec(shuffled);
}

function collectToolIds(tree: TileTree): ToolId[] {
  return tree.type === "leaf" ? [tree.toolId] : [...collectToolIds(tree.a), ...collectToolIds(tree.b)];
}

function isValidTree(x: unknown): x is TileTree {
  if (!x || typeof x !== "object") return false;
  const n = x as Record<string, unknown>;
  if (n.type === "leaf") return typeof n.toolId === "string";
  if (n.type === "split") {
    return (
      (n.dir === "x" || n.dir === "y") &&
      typeof n.ratio === "number" &&
      isValidTree(n.a) &&
      isValidTree(n.b)
    );
  }
  return false;
}

function loadTree(): TileTree {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(TREE_KEY) || "null");
    if (isValidTree(raw)) {
      const got = [...collectToolIds(raw)].sort().join(",");
      const expect = [...TOOL_IDS].sort().join(",");
      if (got === expect) return raw;
    }
  } catch {
    /* используем дефолт */
  }
  return buildDefaultTree(TOOL_IDS);
}

function updateRatioAtPath(tree: TileTree, path: TilePath, ratio: number): TileTree {
  if (tree.type !== "split") return tree;
  if (path.length === 0) return { ...tree, ratio };
  const [head, ...rest] = path;
  return head === "a"
    ? { ...tree, a: updateRatioAtPath(tree.a, rest, ratio) }
    : { ...tree, b: updateRatioAtPath(tree.b, rest, ratio) };
}

function getToolAtPath(tree: TileTree, path: TilePath): ToolId | null {
  let n = tree;
  for (const step of path) {
    if (n.type !== "split") return null;
    n = step === "a" ? n.a : n.b;
  }
  return n.type === "leaf" ? n.toolId : null;
}

/** Минимально необходимый размер поддерева вдоль оси `dir` (px). Для листа —
 * MIN_TILE_PX. Для разбиения вдоль ТОЙ ЖЕ оси размеры складываются (плюс
 * разделитель), для разбиения поперёк — берём максимум (обе половины
 * растягиваются на всю доступную длину по этой оси). Используется, чтобы
 * контейнер и каждый узел дерева всегда получали ХОТЯ БЫ этот размер —
 * иначе при нехватке места (узкое окно/короткая страница) соседние блоки
 * налезали друг на друга, потому что каждый разделитель клэмпился к плоскому
 * MIN_TILE_PX независимо от того, сколько блоков реально лежит в поддереве. */
function minRequiredSize(tree: TileTree, dir: Dir): number {
  if (tree.type === "leaf") return MIN_TILE_PX;
  const a = minRequiredSize(tree.a, dir);
  const b = minRequiredSize(tree.b, dir);
  return tree.dir === dir ? a + b + DIVIDER_PX : Math.max(a, b);
}

function setToolAtPath(tree: TileTree, path: TilePath, toolId: ToolId): TileTree {
  if (path.length === 0) return tree.type === "leaf" ? { type: "leaf", toolId } : tree;
  if (tree.type !== "split") return tree;
  const [head, ...rest] = path;
  return head === "a"
    ? { ...tree, a: setToolAtPath(tree.a, rest, toolId) }
    : { ...tree, b: setToolAtPath(tree.b, rest, toolId) };
}

interface DragRatioInfo {
  path: TilePath;
  dir: Dir;
  rect: Rect;
  minA: number;
  minB: number;
}

function TileNode({
  node,
  path,
  rect,
  toolsById,
  draggedKey,
  onLeafDragStart,
  onLeafDrop,
  onLeafDragEnd,
  onDividerDown,
  onDividerMove,
  onDividerUp,
}: {
  node: TileTree;
  path: TilePath;
  rect: Rect;
  toolsById: Record<ToolId, { icon: React.ElementType; Component: React.ComponentType }>;
  draggedKey: string | null;
  onLeafDragStart: (path: TilePath) => void;
  onLeafDrop: (path: TilePath) => void;
  onLeafDragEnd: () => void;
  onDividerDown: (path: TilePath, dir: Dir, rect: Rect, minA: number, minB: number) => void;
  onDividerMove: (e: React.PointerEvent) => void;
  onDividerUp: (e: React.PointerEvent) => void;
}) {
  const { t } = useI18n();
  const pathKey = path.join("") || "root";

  if (node.type === "leaf") {
    const tool = toolsById[node.toolId];
    const Icon = tool.icon;
    const inset = GAP / 2;
    return (
      <div
        className={`tools-tile${draggedKey === pathKey ? " is-dragging" : ""}`}
        style={{
          left: rect.x + inset,
          top: rect.y + inset,
          width: Math.max(0, rect.w - GAP),
          height: Math.max(0, rect.h - GAP),
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onLeafDrop(path);
        }}
      >
        <div
          className="tools-widget-head"
          draggable
          onDragStart={() => onLeafDragStart(path)}
          onDragEnd={onLeafDragEnd}
        >
          <GripVertical size={13} className="tools-widget-grip" />
          <Icon size={14} />
          <span>{t(`tools.tab_${node.toolId}`)}</span>
        </div>
        <div className="tools-widget-body">
          <tool.Component />
        </div>
      </div>
    );
  }

  const isX = node.dir === "x";
  const dim = isX ? rect.w : rect.h;
  const minA = minRequiredSize(node.a, node.dir);
  const minB = minRequiredSize(node.b, node.dir);
  // Клэмпим по СТРУКТУРНОМУ минимуму каждой половины (а не плоскому
  // MIN_TILE_PX) — иначе сторона, в которой лежит несколько вложенных
  // блоков, могла бы получить места меньше, чем нужно её собственному
  // поддереву, и блоки внутри неё наехали бы друг на друга.
  let aSize = Math.round(dim * node.ratio);
  aSize = Math.max(minA, Math.min(dim - minB - DIVIDER_PX, aSize));
  const bSize = Math.max(minB, dim - aSize - DIVIDER_PX);
  const rectA: Rect = isX
    ? { x: rect.x, y: rect.y, w: aSize, h: rect.h }
    : { x: rect.x, y: rect.y, w: rect.w, h: aSize };
  const rectB: Rect = isX
    ? { x: rect.x + aSize + DIVIDER_PX, y: rect.y, w: bSize, h: rect.h }
    : { x: rect.x, y: rect.y + aSize + DIVIDER_PX, w: rect.w, h: bSize };
  const dividerStyle: React.CSSProperties = isX
    ? { left: rect.x + aSize, top: rect.y, width: DIVIDER_PX, height: rect.h, cursor: "col-resize" }
    : { left: rect.x, top: rect.y + aSize, width: rect.w, height: DIVIDER_PX, cursor: "row-resize" };

  return (
    <>
      <TileNode
        node={node.a}
        path={[...path, "a"]}
        rect={rectA}
        toolsById={toolsById}
        draggedKey={draggedKey}
        onLeafDragStart={onLeafDragStart}
        onLeafDrop={onLeafDrop}
        onLeafDragEnd={onLeafDragEnd}
        onDividerDown={onDividerDown}
        onDividerMove={onDividerMove}
        onDividerUp={onDividerUp}
      />
      <div
        className={`tools-divider ${isX ? "is-x" : "is-y"}`}
        style={dividerStyle}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onDividerDown(path, node.dir, rect, minA, minB);
        }}
        onPointerMove={onDividerMove}
        onPointerUp={onDividerUp}
      />
      <TileNode
        node={node.b}
        path={[...path, "b"]}
        rect={rectB}
        toolsById={toolsById}
        draggedKey={draggedKey}
        onLeafDragStart={onLeafDragStart}
        onLeafDrop={onLeafDrop}
        onLeafDragEnd={onLeafDragEnd}
        onDividerDown={onDividerDown}
        onDividerMove={onDividerMove}
        onDividerUp={onDividerUp}
      />
    </>
  );
}

export default function ToolsPage() {
  const { t } = useI18n();
  const [tree, setTree] = useState<TileTree>(() => loadTree());
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draggedPathRef = useRef<TilePath | null>(null);
  const dragRatioRef = useRef<DragRatioInfo | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Наблюдаем за ВИДИМОЙ областью прокрутки, а не за самим контентом сетки —
  // высота/ширина контента вычисляется от дерева (minRequiredSize) и может
  // быть больше видимой области, тогда прокрутка внутри .tools-tile-scroll
  // (а не сжатие блоков ниже их минимального размера) берёт на себя остаток.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setViewport({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Размер контента сетки: не меньше видимой области (чтобы дерево
  // растягивалось на всё доступное место), но и не меньше структурного
  // минимума дерева (чтобы при нехватке места появлялась прокрутка, а не
  // наложение блоков друг на друга).
  const content = useMemo(
    () => ({
      w: Math.max(viewport.w, minRequiredSize(tree, "x")),
      h: Math.max(viewport.h, minRequiredSize(tree, "y")),
    }),
    [viewport, tree],
  );

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      localStorage.setItem(TREE_KEY, JSON.stringify(tree));
    }, 300);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [tree]);

  const onLeafDragStart = (path: TilePath) => {
    draggedPathRef.current = path;
    setDraggedKey(path.join("") || "root");
  };
  const onLeafDragEnd = () => {
    draggedPathRef.current = null;
    setDraggedKey(null);
  };
  const onLeafDrop = (path: TilePath) => {
    const from = draggedPathRef.current;
    draggedPathRef.current = null;
    setDraggedKey(null);
    if (!from) return;
    const fromKey = from.join("") || "root";
    const toKey = path.join("") || "root";
    if (fromKey === toKey) return;
    setTree((prev) => {
      const toolA = getToolAtPath(prev, from);
      const toolB = getToolAtPath(prev, path);
      if (toolA == null || toolB == null) return prev;
      return setToolAtPath(setToolAtPath(prev, from, toolB), path, toolA);
    });
  };

  const onDividerDown = (path: TilePath, dir: Dir, rect: Rect, minA: number, minB: number) => {
    dragRatioRef.current = { path, dir, rect, minA, minB };
  };
  const onDividerMove = (e: React.PointerEvent) => {
    const d = dragRatioRef.current;
    if (!d) return;
    const pos = d.dir === "x" ? e.clientX - d.rect.x : e.clientY - d.rect.y;
    const dim = d.dir === "x" ? d.rect.w : d.rect.h;
    if (dim <= 0) return;
    // Клэмп по структурному минимуму каждой стороны — тот же расчёт, что и
    // при рендере (minRequiredSize), иначе можно было бы утащить границу
    // так, что вложенные блоки внутри одной из половин налезли бы друг на
    // друга.
    const aSize = Math.min(dim - d.minB - DIVIDER_PX, Math.max(d.minA, pos));
    const ratio = aSize / dim;
    setTree((prev) => updateRatioAtPath(prev, d.path, ratio));
  };
  const onDividerUp = (e: React.PointerEvent) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* уже отпущено/недоступно */
    }
    dragRatioRef.current = null;
  };

  const byId = useMemo(
    () => Object.fromEntries(TOOLS.map((x) => [x.id, x])) as unknown as Record<
      ToolId,
      { icon: React.ElementType; Component: React.ComponentType }
    >,
    [],
  );

  return (
    <div className="page">
      <SectionHead
        eyebrow={t("tools.eyebrow")}
        title={t("tools.title")}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Btn icon={Shuffle} onClick={() => setTree(buildRandomTree(TOOL_IDS))}>
              {t("tools.randomize")}
            </Btn>
            <Btn icon={RotateCcw} onClick={() => setTree(buildDefaultTree(TOOL_IDS))}>
              {t("tools.resetLayout")}
            </Btn>
          </div>
        }
      />
      <div className="muted-sm" style={{ margin: "4px 0 10px" }}>
        {t("tools.gridHint")}
      </div>
      <div ref={scrollRef} className="tools-tile-scroll">
        {content.w > 0 && content.h > 0 && (
          <div className="tools-tile-container" style={{ width: content.w, height: content.h }}>
            <TileNode
              node={tree}
              path={[]}
              rect={{ x: 0, y: 0, w: content.w, h: content.h }}
              toolsById={byId}
              draggedKey={draggedKey}
              onLeafDragStart={onLeafDragStart}
              onLeafDrop={onLeafDrop}
              onLeafDragEnd={onLeafDragEnd}
              onDividerDown={onDividerDown}
              onDividerMove={onDividerMove}
              onDividerUp={onDividerUp}
            />
          </div>
        )}
      </div>
    </div>
  );
}

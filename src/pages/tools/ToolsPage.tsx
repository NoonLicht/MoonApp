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


/* ───────────────────────── Page: свободная сетка (ряды × ячейки) ─────────────────────────
 *
 * Раньше сетка была деревом бинарных разбиений (BSP) на ФИКСИРОВАННОЙ
 * площади: контейнер имел явную высоту, и перетягивание любой границы
 * перераспределяло место между двумя соседями внутри этой же высоты — то
 * есть "растянуть один блок" неизбежно означало "сжать другой", а общая
 * высота сетки никогда не могла вырасти больше окна. Это именно то, на что
 * пожаловался пользователь: блоки всегда выглядели тесно, а тайлинг был
 * прижат к высоте окна.
 *
 * Новая модель — стопка РЯДОВ, каждый со своей независимой высотой (в px,
 * никак не связанной с высотой соседних рядов), и внутри каждого ряда —
 * ЯЧЕЙКИ, поделившие его ширину в заданных пропорциях. Общая высота сетки —
 * это просто сумма высот рядов, поэтому:
 *   - тайлинг ничем не ограничен по высоте — сумма рядов растёт как угодно,
 *     а .tools-tile-scroll просто прокручивает то, что не влезло;
 *   - перетягивание нижней границы ряда меняет ТОЛЬКО высоту этого ряда —
 *     соседние ряды не сжимаются, они просто опускаются ниже (сумма высот
 *     выросла, а не была перераспределена);
 *   - перетягивание границы МЕЖДУ ячейками внутри ряда по-прежнему меняет
 *     пропорцию их ширины (ширина реально ограничена шириной страницы —
 *     тут "растянуть один — сжать другой" ожидаемо и уместно).
 * Порядок инструментов меняется перетаскиванием заголовка одной ячейки на
 * другую — они меняются местами в любых двух рядах.
 */

interface Cell {
  toolId: ToolId;
  width: number; // доля ширины ряда, ячейки одного ряда суммарно дают 1
}
interface Row {
  height: number; // px, независимо от других рядов
  cells: Cell[];
}
type Layout = Row[];

const LAYOUT_KEY = "moonapp.tools.layout";
const MIN_CELL_W = 220;
const MIN_ROW_H = 160;
const DIVIDER_PX = 8;
const GAP = 8;

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

/** Дефолтная раскладка: инструментам с многострочными текстовыми полями
 * (JSON/diff/regex) — отдельный высокий верхний ряд, остальным — более
 * низкий нижний ряд из четырёх ячеек поменьше. */
function buildDefaultLayout(ids: ToolId[]): Layout {
  const big = ids.slice(0, 3);
  const small = ids.slice(3);
  const rows: Layout = [];
  if (big.length > 0) {
    rows.push({ height: 460, cells: big.map((id) => ({ toolId: id, width: 1 / big.length })) });
  }
  if (small.length > 0) {
    rows.push({ height: 320, cells: small.map((id) => ({ toolId: id, width: 1 / small.length })) });
  }
  return rows.length > 0 ? rows : [{ height: 400, cells: ids.map((id) => ({ toolId: id, width: 1 / ids.length })) }];
}

/** Случайная раскладка: перетасованный порядок, случайное число рядов и
 * случайное распределение ячеек/ширин/высот в разумных пределах. */
function buildRandomLayout(ids: ToolId[]): Layout {
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const rows: Layout = [];
  let i = 0;
  while (i < shuffled.length) {
    const remaining = shuffled.length - i;
    const take = Math.min(remaining, 1 + Math.floor(Math.random() * Math.min(3, remaining)));
    const chunk = shuffled.slice(i, i + take);
    i += take;
    const weights = chunk.map(() => 0.6 + Math.random() * 0.8);
    const sum = weights.reduce((a, b) => a + b, 0);
    rows.push({
      height: Math.round(280 + Math.random() * 260),
      cells: chunk.map((id, idx) => ({ toolId: id, width: weights[idx] / sum })),
    });
  }
  return rows;
}

function collectToolIds(layout: Layout): ToolId[] {
  return layout.flatMap((r) => r.cells.map((c) => c.toolId));
}

function isValidLayout(x: unknown): x is Layout {
  if (!Array.isArray(x) || x.length === 0) return false;
  return x.every((row) => {
    if (!row || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    if (typeof r.height !== "number" || !Array.isArray(r.cells) || r.cells.length === 0) return false;
    return (r.cells as unknown[]).every((c) => {
      if (!c || typeof c !== "object") return false;
      const cell = c as Record<string, unknown>;
      return typeof cell.toolId === "string" && typeof cell.width === "number";
    });
  });
}

function loadLayout(): Layout {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    if (isValidLayout(raw)) {
      const got = [...collectToolIds(raw)].sort().join(",");
      const expect = [...TOOL_IDS].sort().join(",");
      if (got === expect) return raw;
    }
  } catch {
    /* используем дефолт */
  }
  return buildDefaultLayout(TOOL_IDS);
}

interface RowDragInfo {
  rowIndex: number;
  startY: number;
  startHeight: number;
}
interface CellDragInfo {
  rowIndex: number;
  cellIndex: number;
  startX: number;
  rowWidthPx: number;
  widthA: number;
  widthB: number;
}
interface SwapSource {
  rowIndex: number;
  cellIndex: number;
}

function TilesRow({
  row,
  rowIndex,
  widthPx,
  toolsById,
  draggedKey,
  onCellDragStart,
  onCellDrop,
  onCellDragEnd,
  onColDividerDown,
  onColDividerMove,
  onColDividerUp,
}: {
  row: Row;
  rowIndex: number;
  widthPx: number;
  toolsById: Record<ToolId, { icon: React.ElementType; Component: React.ComponentType }>;
  draggedKey: string | null;
  onCellDragStart: (rowIndex: number, cellIndex: number) => void;
  onCellDrop: (rowIndex: number, cellIndex: number) => void;
  onCellDragEnd: () => void;
  onColDividerDown: (rowIndex: number, cellIndex: number, rowWidthPx: number, clientX: number) => void;
  onColDividerMove: (e: React.PointerEvent) => void;
  onColDividerUp: (e: React.PointerEvent) => void;
}) {
  const { t } = useI18n();
  let x = 0;
  const parts: React.ReactNode[] = [];
  row.cells.forEach((cell, cellIndex) => {
    const cellW = Math.round(widthPx * cell.width) - (cellIndex < row.cells.length - 1 ? DIVIDER_PX / 2 : 0);
    const tool = toolsById[cell.toolId];
    const Icon = tool.icon;
    const key = `${rowIndex}-${cellIndex}`;
    const inset = GAP / 2;
    parts.push(
      <div
        key={`cell-${key}`}
        className={`tools-tile${draggedKey === key ? " is-dragging" : ""}`}
        style={{ left: x + inset, top: inset, width: Math.max(0, cellW - GAP), height: Math.max(0, row.height - GAP) }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onCellDrop(rowIndex, cellIndex);
        }}
      >
        <div
          className="tools-widget-head"
          draggable
          onDragStart={() => onCellDragStart(rowIndex, cellIndex)}
          onDragEnd={onCellDragEnd}
        >
          <GripVertical size={13} className="tools-widget-grip" />
          <Icon size={14} />
          <span>{t(`tools.tab_${cell.toolId}`)}</span>
        </div>
        <div className="tools-widget-body">
          <tool.Component />
        </div>
      </div>,
    );
    x += cellW;
    if (cellIndex < row.cells.length - 1) {
      const dividerX = x;
      parts.push(
        <div
          key={`div-${key}`}
          className="tools-divider is-x"
          style={{ left: dividerX, top: 0, width: DIVIDER_PX, height: row.height, cursor: "col-resize" }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            onColDividerDown(rowIndex, cellIndex, widthPx, e.clientX);
          }}
          onPointerMove={onColDividerMove}
          onPointerUp={onColDividerUp}
        />,
      );
      x += DIVIDER_PX;
    }
  });
  return (
    <div className="tools-tile-row" style={{ height: row.height }}>
      {parts}
    </div>
  );
}

export default function ToolsPage() {
  const { t } = useI18n();
  const [layout, setLayout] = useState<Layout>(() => loadLayout());
  const [viewportW, setViewportW] = useState(0);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const swapSourceRef = useRef<SwapSource | null>(null);
  const rowDragRef = useRef<RowDragInfo | null>(null);
  const colDragRef = useRef<CellDragInfo | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Наблюдаем только за ШИРИНОЙ видимой области — она реально ограничена
  // страницей, поэтому ячейки внутри ряда честно делят её. Высота НИЧЕМ не
  // ограничивается: сумма высот рядов может быть сколь угодно больше
  // видимой области, .tools-tile-scroll её просто прокручивает.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setViewportW(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    }, 300);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [layout]);

  const onCellDragStart = (rowIndex: number, cellIndex: number) => {
    swapSourceRef.current = { rowIndex, cellIndex };
    setDraggedKey(`${rowIndex}-${cellIndex}`);
  };
  const onCellDragEnd = () => {
    swapSourceRef.current = null;
    setDraggedKey(null);
  };
  const onCellDrop = (rowIndex: number, cellIndex: number) => {
    const from = swapSourceRef.current;
    swapSourceRef.current = null;
    setDraggedKey(null);
    if (!from) return;
    if (from.rowIndex === rowIndex && from.cellIndex === cellIndex) return;
    setLayout((prev) => {
      const next = prev.map((r) => ({ ...r, cells: [...r.cells] }));
      const a = next[from.rowIndex].cells[from.cellIndex];
      const b = next[rowIndex].cells[cellIndex];
      if (!a || !b) return prev;
      next[from.rowIndex].cells[from.cellIndex] = { ...a, toolId: b.toolId };
      next[rowIndex].cells[cellIndex] = { ...b, toolId: a.toolId };
      return next;
    });
  };

  // --- Граница между рядами: тянем — меняется ВЫСОТА ТОЛЬКО ЭТОГО ряда,
  // остальные ряды просто опускаются/поднимаются вместе с общей суммой. ---
  const onRowDividerDown = (rowIndex: number, e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    rowDragRef.current = { rowIndex, startY: e.clientY, startHeight: layout[rowIndex].height };
  };
  const onRowDividerMove = (e: React.PointerEvent) => {
    const d = rowDragRef.current;
    if (!d) return;
    const next = Math.max(MIN_ROW_H, d.startHeight + (e.clientY - d.startY));
    setLayout((prev) => prev.map((r, i) => (i === d.rowIndex ? { ...r, height: next } : r)));
  };
  const onRowDividerUp = (e: React.PointerEvent) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* уже отпущено */
    }
    rowDragRef.current = null;
  };

  // --- Граница между ячейками внутри ряда: тянем — доля ширины
  // перераспределяется между двумя соседними ячейками (ширина ряда сама по
  // себе ограничена шириной страницы — тут это ожидаемо). ---
  const onColDividerDown = (rowIndex: number, cellIndex: number, rowWidthPx: number, clientX: number) => {
    const row = layout[rowIndex];
    colDragRef.current = {
      rowIndex,
      cellIndex,
      startX: clientX,
      rowWidthPx,
      widthA: row.cells[cellIndex].width,
      widthB: row.cells[cellIndex + 1].width,
    };
  };
  const onColDividerMove = (e: React.PointerEvent) => {
    const d = colDragRef.current;
    if (!d) return;
    const deltaRatio = (e.clientX - d.startX) / d.rowWidthPx;
    const minRatio = MIN_CELL_W / d.rowWidthPx;
    const sum = d.widthA + d.widthB;
    let a = d.widthA + deltaRatio;
    a = Math.min(sum - minRatio, Math.max(minRatio, a));
    const b = sum - a;
    setLayout((prev) =>
      prev.map((r, ri) =>
        ri !== d.rowIndex
          ? r
          : {
              ...r,
              cells: r.cells.map((c, ci) =>
                ci === d.cellIndex ? { ...c, width: a } : ci === d.cellIndex + 1 ? { ...c, width: b } : c,
              ),
            },
      ),
    );
  };
  const onColDividerUp = (e: React.PointerEvent) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* уже отпущено */
    }
    colDragRef.current = null;
  };

  const byId = useMemo(
    () => Object.fromEntries(TOOLS.map((x) => [x.id, x])) as unknown as Record<
      ToolId,
      { icon: React.ElementType; Component: React.ComponentType }
    >,
    [],
  );

  const rowTops = useMemo(() => {
    const tops: number[] = [];
    let acc = 0;
    for (const r of layout) {
      tops.push(acc);
      acc += r.height + DIVIDER_PX;
    }
    return tops;
  }, [layout]);
  const totalHeight = layout.reduce((sum, r) => sum + r.height, 0) + (layout.length - 1) * DIVIDER_PX;

  return (
    <div className="page">
      <SectionHead
        eyebrow={t("tools.eyebrow")}
        title={t("tools.title")}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Btn icon={Shuffle} onClick={() => setLayout(buildRandomLayout(TOOL_IDS))}>
              {t("tools.randomize")}
            </Btn>
            <Btn icon={RotateCcw} onClick={() => setLayout(buildDefaultLayout(TOOL_IDS))}>
              {t("tools.resetLayout")}
            </Btn>
          </div>
        }
      />
      <div className="muted-sm" style={{ margin: "4px 0 10px" }}>
        {t("tools.gridHint")}
      </div>
      <div ref={scrollRef} className="tools-tile-scroll">
        {viewportW > 0 && (
          <div className="tools-tile-container" style={{ width: viewportW, height: totalHeight }}>
            {layout.map((row, rowIndex) => (
              <div
                key={rowIndex}
                style={{ position: "absolute", left: 0, top: rowTops[rowIndex], width: viewportW }}
              >
                <TilesRow
                  row={row}
                  rowIndex={rowIndex}
                  widthPx={viewportW}
                  toolsById={byId}
                  draggedKey={draggedKey}
                  onCellDragStart={onCellDragStart}
                  onCellDrop={onCellDrop}
                  onCellDragEnd={onCellDragEnd}
                  onColDividerDown={onColDividerDown}
                  onColDividerMove={onColDividerMove}
                  onColDividerUp={onColDividerUp}
                />
                {rowIndex < layout.length - 1 && (
                  <div
                    className="tools-divider is-y"
                    style={{ left: 0, top: row.height, width: viewportW, height: DIVIDER_PX, cursor: "row-resize" }}
                    onPointerDown={(e) => onRowDividerDown(rowIndex, e)}
                    onPointerMove={onRowDividerMove}
                    onPointerUp={onRowDividerUp}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

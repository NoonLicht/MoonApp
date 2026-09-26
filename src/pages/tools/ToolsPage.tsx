import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
  RotateCcw,
  Terminal,
} from "lucide-react";
import { Glass, Btn, SectionHead, Field, Select, Badge } from "@/components/ui";
import { copyToClipboard } from "@/components/ContextMenu";
import { useI18n } from "@/app/i18n";
import { CURL_TARGETS } from "@/lib/curlTargets";

/* ───────────────────────── curl → код (curlconverter) ───────────────────────── */

const DEFAULT_CURL = `curl -X POST https://api.example.com/users \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer TOKEN" \\
  -d '{"name": "Ada", "role": "engineer"}'`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CurlConverterModule = Record<string, (cmd: string) => [string, (string | string[])[]]>;
let curlconverterPromise: Promise<CurlConverterModule> | null = null;
/** Библиотека грузится и парсится один раз на всё приложение (WASM-инициализация
 * не бесплатна), а не при каждом открытии страницы/блока. */
function loadCurlconverter(): Promise<CurlConverterModule> {
  if (!curlconverterPromise) {
    // Динамический import — WASM-инициализация парсера асинхронна (top-level await
    // внутри пакета), рано её нельзя дёрнуть синхронно при загрузке модуля страницы.
    curlconverterPromise = import("curlconverter") as unknown as Promise<CurlConverterModule>;
  }
  return curlconverterPromise;
}

/**
 * Полноценная интеграция curlconverter (https://github.com/curlconverter/curlconverter,
 * тот же движок, что у curlconverter.com) — работает ПОЛНОСТЬЮ локально в
 * браузерном движке приложения (WASM-сборка tree-sitter-bash, без Node), без
 * единого сетевого запроса и без бэкенда: команда curl никогда не покидает
 * страницу, преобразование работает и без интернета.
 */
function CurlConverterBlock() {
  const { t } = useI18n();
  const [target, setTarget] = useState("python");
  const [command, setCommand] = useState(DEFAULT_CURL);
  const [code, setCode] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    loadCurlconverter()
      .then(() => {
        if (alive) setReady(true);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  const run = useMemo(
    () => (cmd: string, tgt: string) => {
      if (!cmd.trim() || !tgt) return;
      const targetDef = CURL_TARGETS.find((x) => x.id === tgt);
      if (!targetDef) return;
      loadCurlconverter()
        .then((mod) => {
          const fn = mod[targetDef.fn];
          if (typeof fn !== "function") throw new Error(`unsupported_target:${tgt}`);
          const [outCode, outWarnings] = fn(cmd);
          setCode(outCode);
          setWarnings((outWarnings || []).map((w) => (Array.isArray(w) ? w.join(": ") : String(w))));
          setError("");
        })
        .catch((e: Error) => {
          setError(e.message);
          setCode("");
          setWarnings([]);
        });
    },
    [],
  );

  // Живое преобразование с debounce — как только перестали печатать/менять язык.
  useEffect(() => {
    if (!ready) return undefined;
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => run(command, target), 350);
    return () => {
      if (debRef.current) clearTimeout(debRef.current);
    };
  }, [command, target, run, ready]);

  return (
    <Glass
      className="curlconv-block"
      style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10, flex: 1, minHeight: 0 }}
    >
      <div className="tools-widget-head">
        <Terminal size={16} />
        <span>{t("tools.curlTitle")}</span>
      </div>
      <div className="muted-sm">{t("tools.curlHint")}</div>
      <div className="curlconv-row">
        <textarea
          className="text-input"
          style={{ flex: 1, fontFamily: "var(--font-mono)", resize: "none", minHeight: 0 }}
          spellCheck={false}
          placeholder="curl ..."
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 8, minHeight: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Field label={t("tools.curlLanguage")} w={240}>
              <Select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                options={CURL_TARGETS.map((tg) => ({ value: tg.id, label: tg.label }))}
              />
            </Field>
            {code && (
              <Btn icon={Copy} onClick={() => copyToClipboard(code)}>
                {t("ctx.copyName")}
              </Btn>
            )}
            {!ready && !error && <Badge tone="neutral">{t("tools.curlConverting")}</Badge>}
          </div>
          {error && (
            <div style={{ color: "var(--coral)", display: "flex", gap: 6, alignItems: "center" }}>
              <AlertTriangle size={14} /> {error}
            </div>
          )}
          <textarea
            className="text-input"
            readOnly
            style={{ flex: 1, fontFamily: "var(--font-mono)", resize: "none", minHeight: 0 }}
            value={code}
          />
          {warnings.length > 0 && (
            <div className="curlconv-warnings">
              {warnings.map((w, i) => (
                <div key={i} className="muted-sm">
                  ⚠ {w}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Glass>
  );
}

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





/* ───────────────────────── Page: несколько фиксированных шаблонов по ширине ─────────────────────────
 *
 * Пять предыдущих попыток свободно редактируемой сетки (drag-reorder,
 * drag-resize ширины/высоты, авторазбиение по ширине) упирались в новые
 * баги на каждой итерации — вся эта гибкость плохо стыковалась друг с
 * другом. Вместо неё — несколько заранее собранных шаблонов раскладки,
 * которые переключаются по ширине страницы (как брейкпоинты), без
 * перетаскивания и реордера блоков. Единственное, что остаётся
 * редактируемым — высота каждой строки шаблона (тянем границу вниз/вверх),
 * это по-прежнему сохраняется в localStorage отдельно для каждого
 * шаблона/строки.
 *
 * Размер блока по условию: JSON/diff/regex — большие, base64 — средний,
 * остальные (encode/uuid/units) — маленькие. Это задаёт высоту по
 * умолчанию (SIZE_H) для строки, где инструмент — главный/единственный.
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

const SIZE_H = { large: 460, medium: 340, small: 260 };
const MIN_ROW_H = 160;
const HEIGHTS_KEY = "moonapp.tools.templateRowHeights";

interface TemplateCell {
  toolId: ToolId;
  grow: number;
}
interface TemplateRow {
  key: string;
  defaultHeight: number;
  cells: TemplateCell[];
}
type Tier = "wide" | "medium" | "narrow";

const WIDE_TEMPLATE: TemplateRow[] = [
  // json/diff — по 50% каждому (2 ячейки с одинаковым grow ровно и делят
  // ряд пополам). Regex — отдельным рядом НИЖЕ, а не в одной строке с
  // json/diff: так между ним и json/diff появляется своя граница-разделитель,
  // и высоту json/diff можно тянуть независимо от regex.
  { key: "top", defaultHeight: SIZE_H.large, cells: [{ toolId: "json", grow: 1 }, { toolId: "diff", grow: 1 }] },
  { key: "regex", defaultHeight: SIZE_H.large, cells: [{ toolId: "regex", grow: 1 }] },
  {
    key: "rest",
    defaultHeight: SIZE_H.medium,
    cells: [
      { toolId: "encode", grow: 2 },
      { toolId: "base", grow: 1 },
      { toolId: "uuid", grow: 1 },
      { toolId: "units", grow: 1 },
    ],
  },
];

const MEDIUM_TEMPLATE: TemplateRow[] = [
  { key: "r1", defaultHeight: SIZE_H.large, cells: [{ toolId: "json", grow: 1 }, { toolId: "diff", grow: 1 }] },
  { key: "r2", defaultHeight: SIZE_H.large, cells: [{ toolId: "regex", grow: 1 }, { toolId: "base", grow: 1 }] },
  { key: "r3", defaultHeight: SIZE_H.small, cells: [{ toolId: "encode", grow: 1 }, { toolId: "uuid", grow: 1 }] },
  { key: "r4", defaultHeight: SIZE_H.small, cells: [{ toolId: "units", grow: 1 }] },
];

const NARROW_TEMPLATE: TemplateRow[] = [
  { key: "json", defaultHeight: SIZE_H.large, cells: [{ toolId: "json", grow: 1 }] },
  { key: "diff", defaultHeight: SIZE_H.large, cells: [{ toolId: "diff", grow: 1 }] },
  { key: "regex", defaultHeight: SIZE_H.large, cells: [{ toolId: "regex", grow: 1 }] },
  { key: "encode", defaultHeight: SIZE_H.medium, cells: [{ toolId: "encode", grow: 1 }] },
  { key: "base", defaultHeight: SIZE_H.small, cells: [{ toolId: "base", grow: 1 }] },
  { key: "uuid", defaultHeight: SIZE_H.small, cells: [{ toolId: "uuid", grow: 1 }] },
  { key: "units", defaultHeight: SIZE_H.small, cells: [{ toolId: "units", grow: 1 }] },
];

function tierFor(width: number): Tier {
  if (width >= 1400) return "wide";
  if (width >= 900) return "medium";
  return "narrow";
}
function templateFor(tier: Tier): TemplateRow[] {
  if (tier === "wide") return WIDE_TEMPLATE;
  if (tier === "medium") return MEDIUM_TEMPLATE;
  return NARROW_TEMPLATE;
}

const WIDTHS_KEY = "moonapp.tools.templateColGrow";
const CURL_HEIGHT_KEY = "moonapp.tools.curlHeight";
const DEFAULT_CURL_HEIGHT = 420;
const MIN_CURL_HEIGHT = 220;
const MIN_GROW = 0.2;

function loadRecord(key: string): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function loadNumber(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

interface RowDragInfo {
  heightKey: string;
  startY: number;
  startHeight: number;
}

interface ColDragInfo {
  leftKey: string;
  rightKey: string;
  startX: number;
  startLeft: number;
  startRight: number;
  totalGrow: number;
  rowWidthPx: number;
}

interface CurlDragInfo {
  startY: number;
  startHeight: number;
}

export default function ToolsPage() {
  const { t } = useI18n();
  const [viewportW, setViewportW] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>(() => loadRecord(HEIGHTS_KEY));
  const [widths, setWidths] = useState<Record<string, number>>(() => loadRecord(WIDTHS_KEY));
  const [curlHeight, setCurlHeight] = useState(() => loadNumber(CURL_HEIGHT_KEY, DEFAULT_CURL_HEIGHT));
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowDragRef = useRef<RowDragInfo | null>(null);
  const colDragRef = useRef<ColDragInfo | null>(null);
  const curlDragRef = useRef<CurlDragInfo | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      localStorage.setItem(HEIGHTS_KEY, JSON.stringify(heights));
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
      localStorage.setItem(CURL_HEIGHT_KEY, String(curlHeight));
    }, 300);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [heights, widths, curlHeight]);

  const tier = tierFor(viewportW);
  const template = templateFor(tier);

  const onRowDividerDown = (heightKey: string, defaultHeight: number, e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    rowDragRef.current = { heightKey, startY: e.clientY, startHeight: heights[heightKey] ?? defaultHeight };
  };
  const onRowDividerMove = (e: React.PointerEvent) => {
    const d = rowDragRef.current;
    if (!d) return;
    const next = Math.max(MIN_ROW_H, d.startHeight + (e.clientY - d.startY));
    setHeights((prev) => ({ ...prev, [d.heightKey]: next }));
  };
  const onRowDividerUp = (e: React.PointerEvent) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* уже отпущено */
    }
    rowDragRef.current = null;
  };

  /** Граница между двумя соседними виджетами в ряду: тянем — их flex-grow
   * меняется на противоход (один растёт ровно настолько, насколько уменьшается
   * другой), остальные виджеты ряда остаются как были. */
  const onColDividerDown = (
    leftKey: string,
    rightKey: string,
    leftGrow: number,
    rightGrow: number,
    totalGrow: number,
    e: React.PointerEvent,
  ) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rowEl = e.currentTarget.parentElement as HTMLElement | null;
    colDragRef.current = {
      leftKey,
      rightKey,
      startX: e.clientX,
      startLeft: leftGrow,
      startRight: rightGrow,
      totalGrow,
      rowWidthPx: rowEl?.clientWidth || 800,
    };
  };
  const onColDividerMove = (e: React.PointerEvent) => {
    const d = colDragRef.current;
    if (!d) return;
    const deltaGrow = ((e.clientX - d.startX) / d.rowWidthPx) * d.totalGrow;
    let nextLeft = d.startLeft + deltaGrow;
    let nextRight = d.startRight - deltaGrow;
    if (nextLeft < MIN_GROW) {
      nextRight -= MIN_GROW - nextLeft;
      nextLeft = MIN_GROW;
    }
    if (nextRight < MIN_GROW) {
      nextLeft -= MIN_GROW - nextRight;
      nextRight = MIN_GROW;
    }
    setWidths((prev) => ({ ...prev, [d.leftKey]: nextLeft, [d.rightKey]: nextRight }));
  };
  const onColDividerUp = (e: React.PointerEvent) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* уже отпущено */
    }
    colDragRef.current = null;
  };

  const onCurlDividerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    curlDragRef.current = { startY: e.clientY, startHeight: curlHeight };
  };
  const onCurlDividerMove = (e: React.PointerEvent) => {
    const d = curlDragRef.current;
    if (!d) return;
    setCurlHeight(Math.max(MIN_CURL_HEIGHT, d.startHeight + (e.clientY - d.startY)));
  };
  const onCurlDividerUp = (e: React.PointerEvent) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* уже отпущено */
    }
    curlDragRef.current = null;
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
          <Btn
            icon={RotateCcw}
            onClick={() => {
              setHeights({});
              setWidths({});
              setCurlHeight(DEFAULT_CURL_HEIGHT);
            }}
          >
            {t("tools.resetLayout")}
          </Btn>
        }
      />
      <div ref={scrollRef} className="tools-flow-scroll">
        <div className="tools-flow-col">
          <div style={{ height: curlHeight, display: "flex", flexDirection: "column", minHeight: 0, flexShrink: 0 }}>
            <CurlConverterBlock />
          </div>
          <div
            className="tools-divider is-y"
            onPointerDown={onCurlDividerDown}
            onPointerMove={onCurlDividerMove}
            onPointerUp={onCurlDividerUp}
          />
          {template.map((row, ri) => {
            const heightKey = `${tier}:${row.key}`;
            const height = heights[heightKey] ?? row.defaultHeight;
            const prevRow = template[ri - 1];
            const rowGrows = row.cells.map((c) => widths[`${tier}:${row.key}:${c.toolId}`] ?? c.grow);
            const totalGrow = rowGrows.reduce((a, b) => a + b, 0);
            return (
              <div key={row.key}>
                {ri > 0 && prevRow && (
                  <div
                    className="tools-divider is-y"
                    // Граница принадлежит ряду НАД ней (prevRow) — тянуть её вниз должно
                    // растить именно верхний ряд, а не текущий (row — это ряд ПОД границей).
                    onPointerDown={(e) =>
                      onRowDividerDown(`${tier}:${prevRow.key}`, prevRow.defaultHeight, e)
                    }
                    onPointerMove={onRowDividerMove}
                    onPointerUp={onRowDividerUp}
                  />
                )}
                <div className="tools-flow-row" style={{ height }}>
                  {row.cells.map((c, ci) => {
                    const tool = byId[c.toolId];
                    const Icon = tool.icon;
                    const cellKey = `${tier}:${row.key}:${c.toolId}`;
                    const grow = rowGrows[ci];
                    const prevCell = row.cells[ci - 1];
                    return (
                      <Fragment key={c.toolId}>
                        {ci > 0 && prevCell && (
                          <div
                            className="tools-divider is-x"
                            onPointerDown={(e) =>
                              onColDividerDown(
                                `${tier}:${row.key}:${prevCell.toolId}`,
                                cellKey,
                                rowGrows[ci - 1],
                                grow,
                                totalGrow,
                                e,
                              )
                            }
                            onPointerMove={onColDividerMove}
                            onPointerUp={onColDividerUp}
                          />
                        )}
                        <div className="tools-block" style={{ flexGrow: grow, flexBasis: 0 }}>
                          <div className="tools-widget-head">
                            <Icon size={14} />
                            <span>{t(`tools.tab_${c.toolId}`)}</span>
                          </div>
                          <div className="tools-widget-body">
                            <tool.Component />
                          </div>
                        </div>
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * curl → код на любом языке: полноценная интеграция библиотеки curlconverter
 * (https://github.com/curlconverter/curlconverter, тот же движок, что у
 * curlconverter.com), а не переписанный с нуля клон. Разбор curl-команды
 * (tree-sitter-bash) — вещь с кучей граничных случаев (кавычки, $'...',
 * многострочные `\`, конвейеры), поэтому переиспользуем готовую библиотеку
 * целиком, без урезания. Выполняется на сервере (Node): у curlconverter
 * нативная зависимость tree-sitter, которую нельзя собрать в браузерный бандл
 * без отдельной WASM-сборки — серверный вызов проще и даёт тот же результат.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const curlconverter = require("curlconverter") as Record<string, (s: string) => [string, string[]]>;

/** id → имя функции toXWarn(command) => [code, warnings] в библиотеке. Список
 * соответствует набору целевых языков на самом curlconverter.com. */
export const TARGETS: { id: string; label: string; fn: string }[] = [
  { id: "ansible", label: "Ansible", fn: "toAnsibleWarn" },
  { id: "browser", label: "Browser (fetch)", fn: "toBrowserWarn" },
  { id: "c", label: "C (libcurl)", fn: "toCWarn" },
  { id: "cfml", label: "CFML", fn: "toCFMLWarn" },
  { id: "clojure", label: "Clojure", fn: "toClojureWarn" },
  { id: "csharp", label: "C#", fn: "toCSharpWarn" },
  { id: "dart", label: "Dart", fn: "toDartWarn" },
  { id: "elixir", label: "Elixir", fn: "toElixirWarn" },
  { id: "go", label: "Go", fn: "toGoWarn" },
  { id: "har", label: "HAR", fn: "toHarStringWarn" },
  { id: "http", label: "HTTP", fn: "toHTTPWarn" },
  { id: "httpie", label: "HTTPie", fn: "toHttpieWarn" },
  { id: "java", label: "Java (OkHttp)", fn: "toJavaOkHttpWarn" },
  { id: "java-httpurlconnection", label: "Java (HttpURLConnection)", fn: "toJavaHttpUrlConnectionWarn" },
  { id: "java-jsoup", label: "Java (jsoup)", fn: "toJavaJsoupWarn" },
  { id: "javascript", label: "JavaScript (fetch)", fn: "toJavaScriptWarn" },
  { id: "javascript-jquery", label: "JavaScript (jQuery)", fn: "toJavaScriptJqueryWarn" },
  { id: "javascript-xhr", label: "JavaScript (XHR)", fn: "toJavaScriptXHRWarn" },
  { id: "json", label: "JSON", fn: "toJsonStringWarn" },
  { id: "julia", label: "Julia", fn: "toJuliaWarn" },
  { id: "kotlin", label: "Kotlin", fn: "toKotlinWarn" },
  { id: "lua", label: "Lua", fn: "toLuaWarn" },
  { id: "matlab", label: "MATLAB", fn: "toMATLABWarn" },
  { id: "node", label: "Node.js (fetch)", fn: "toNodeWarn" },
  { id: "node-axios", label: "Node.js (axios)", fn: "toNodeAxiosWarn" },
  { id: "node-got", label: "Node.js (got)", fn: "toNodeGotWarn" },
  { id: "node-http", label: "Node.js (http)", fn: "toNodeHttpWarn" },
  { id: "node-ky", label: "Node.js (ky)", fn: "toNodeKyWarn" },
  { id: "node-request", label: "Node.js (request)", fn: "toNodeRequestWarn" },
  { id: "node-superagent", label: "Node.js (superagent)", fn: "toNodeSuperAgentWarn" },
  { id: "objectivec", label: "Objective-C", fn: "toObjectiveCWarn" },
  { id: "ocaml", label: "OCaml", fn: "toOCamlWarn" },
  { id: "perl", label: "Perl", fn: "toPerlWarn" },
  { id: "php", label: "PHP", fn: "toPhpWarn" },
  { id: "php-guzzle", label: "PHP (Guzzle)", fn: "toPhpGuzzleWarn" },
  { id: "php-requests", label: "PHP (Requests)", fn: "toPhpRequestsWarn" },
  { id: "powershell", label: "PowerShell (WebRequest)", fn: "toPowershellWebRequestWarn" },
  { id: "powershell-restmethod", label: "PowerShell (RestMethod)", fn: "toPowershellRestMethodWarn" },
  { id: "python", label: "Python (requests)", fn: "toPythonWarn" },
  { id: "python-http", label: "Python (http.client)", fn: "toPythonHttpWarn" },
  { id: "r", label: "R (httr)", fn: "toRWarn" },
  { id: "r-httr2", label: "R (httr2)", fn: "toRHttr2Warn" },
  { id: "ruby", label: "Ruby (net::http)", fn: "toRubyWarn" },
  { id: "ruby-httparty", label: "Ruby (HTTParty)", fn: "toRubyHttpartyWarn" },
  { id: "rust", label: "Rust (reqwest)", fn: "toRustWarn" },
  { id: "swift", label: "Swift", fn: "toSwiftWarn" },
  { id: "wget", label: "Wget", fn: "toWgetWarn" },
];

const TARGET_MAP = new Map(TARGETS.map((t) => [t.id, t.fn]));

export interface ConvertResult {
  code: string;
  warnings: string[];
}

export function convert(command: string, target: string): ConvertResult {
  const fnName = TARGET_MAP.get(target);
  if (!fnName) throw new Error(`unknown_target:${target}`);
  const fn = curlconverter[fnName];
  if (typeof fn !== "function") throw new Error(`unsupported_target:${target}`);
  const [code, warnings] = fn(command);
  return { code, warnings: (warnings || []).map((w) => (Array.isArray(w) ? w.join(": ") : String(w))) };
}

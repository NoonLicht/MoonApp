/** id → имя функции toXWarn(command) => [code, warnings] в библиотеке
 * curlconverter (см. src/pages/tools/ToolsPage.tsx). Список соответствует
 * набору целевых языков на самом curlconverter.com. */
export interface CurlTarget {
  id: string;
  label: string;
  fn: string;
}

export const CURL_TARGETS: CurlTarget[] = [
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

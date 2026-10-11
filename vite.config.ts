import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import type { ProxyOptions } from "vite";

/**
 * Dev-прокси на Express (:4000). Standalone-сервер (`node server/index.js`)
 * генерирует токен на каждый запуск и пишет его в storage/.dev-token (см.
 * server/ts/index.ts → devToken). Читаем файл на КАЖДЫЙ запрос: сервер мог
 * перезапуститься с новым токеном, а Vite — нет. Заголовок ставится прокси,
 * поэтому его получают и <img>/<video>, которые сами заголовков не шлют.
 */
const DEV_TOKEN_FILE = path.join(
  process.env.MOONAPP_STORAGE || path.join(__dirname, "storage"),
  ".dev-token",
);
function apiProxy(): ProxyOptions {
  return {
    target: "http://127.0.0.1:4000",
    configure(proxy) {
      proxy.on("proxyReq", (req) => {
        try {
          req.setHeader("x-moonapp-token", fs.readFileSync(DEV_TOKEN_FILE, "utf8").trim());
        } catch {
          /* сервер в открытом режиме (MOONAPP_INSECURE_DEV=1) или ещё не стартовал */
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    // Alias "@/..." -> src/ — единый способ импорта внутри фронтенда
    // (те же paths в tsconfig.json). Доменные папки можно переносить
    // без пересчёта количества "../".
    alias: { "@": path.resolve(__dirname, "src") }, // @contracts/* — только типы, при сборке стираются
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Приложение всегда работает в собственном Electron/Chromium — старые
    // браузеры не нужны. esnext нужен конкретно из-за curlconverter
    // (web-tree-sitter грузит WASM через top-level await), иначе esbuild
    // отказывается собирать бандл под дефолтный список legacy-таргетов.
    target: "esnext",
    rollupOptions: {
      output: {
        /**
         * Крупные библиотеки — в отдельные чанки. Они нужны лишь части страниц
         * (графики — бюджету/монитору, редактор — заметкам, формулы — markdown),
         * а отдельный файл ещё и кэшируется независимо от кода приложения.
         * Чанк грузится только тогда, когда его импортирует открытая страница.
         */
        manualChunks(rawId) {
          const id = rawId.replaceAll("\\", "/");
          // Служебные модули Vite/Rollup (preload-хелпер динамических import(),
          // commonjs-обёртки) нужны оболочке сразу. Без явной привязки Rollup
          // кладёт их в произвольный общий чанк — и стартовый файл начинал
          // тянуть за собой весь codemirror ради одной функции.
          if (id.includes("vite/preload-helper") || id.includes("commonjsHelpers"))
            return "vendor-react";
          const m = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id);
          if (!m) return undefined;
          const pkg = m[1];
          if (pkg === "recharts" || pkg === "victory-vendor" || pkg.startsWith("d3-"))
            return "vendor-charts";
          // Только ядро редактора: языковые пакеты (@codemirror/lang-*, их
          // @lezer/* грамматики) @codemirror/language-data грузит динамически —
          // свалив их в общий чанк, мы бы тянули сразу все языки (~1,5 МБ).
          if (
            /^@codemirror\/(state|view|commands|language|search|autocomplete|lint)$/.test(pkg) ||
            /^@lezer\/(common|highlight|lr)$/.test(pkg) ||
            ["codemirror", "crelt", "style-mod", "w3c-keyname"].includes(pkg)
          )
            return "vendor-codemirror";
          if (pkg === "katex") return "vendor-katex";
          if (pkg === "@xyflow/react" || pkg === "@xyflow/system" || pkg === "dagre" || pkg === "graphlib")
            return "vendor-flow";
          if (pkg === "highlight.js") return "vendor-highlight";
          if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") return "vendor-react";
          return undefined;
        },
      },
    },
  },
  // Та же причина (top-level await в web-tree-sitter), что и у build.target —
  // но dev-сервер прогоняет зависимости через ОТДЕЛЬНЫЙ esbuild-пайплайн
  // (предбандлинг), у которого свой дефолтный таргет, поэтому его нужно
  // поднять здесь тоже, иначе `npm run dev` падает с той же ошибкой ещё до
  // сборки продакшена.
  optimizeDeps: {
    esbuildOptions: { target: "esnext" },
    // Без этого Vite по умолчанию сканирует ЛЮБЫЕ *.html в дереве проекта
    // в поисках точек входа — а storage/ (рабочие данные приложения, не
    // исходники) содержит venv с Gradio (страница TTS), чей бандл ссылается
    // на собственный virtual-модуль сборки и падает как "неразрешимая
    // зависимость". Ограничиваем скан нашим единственным реальным входом.
    entries: ["index.html"],
  },
  server: {
    port: 5173,
    strictPort: true,
    // Только loopback: прокси ниже подставляет API-токен, поэтому dev-сервер
    // не должен быть виден из локальной сети.
    host: "127.0.0.1",
    proxy: {
      "/api": apiProxy(),
      "/events": apiProxy(),
    },
    watch: {
      // НЕ следим за storage/: это рабочий каталог приложения, куда пишут внешние
      // процессы. Проверка конфигов zapret запускает vendor-скрипт
      // (storage/zapret/utils/test zapret.ps1), который создаёт и держит открытым
      // файл storage/zapret/utils/test results/test_results_*.txt. Chokidar видит
      // новый файл и пытается повесить на него fs.watch — Windows отдаёт EBUSY,
      // а Vite не перехватывает ошибку вотчера и падает целиком.
      // Глобы + регулярки — на случай разного поведения chokidar на Windows.
      // release/ — вывод electron-builder (win-unpacked, инсталлятор): это не
      // исходники, а сотни мегабайт; следить за ними незачем.
      ignored: [
        "**/storage/**",
        "**/dist/**",
        "**/release/**",
        "**/.git/**",
        /[\\/]storage[\\/]/,
        /[\\/]dist[\\/]/,
        /[\\/]release[\\/]/,
      ],
    },
  },
  test: {
    // Словари языков в приложении ленивые — тестам нужны все сразу.
    setupFiles: ["tests/setup.ts"],
    // Не собираем чужие тесты из вендоренных проектов (ConvertX и т.п.)
    // и то, что уже собрано (dist — Vite, release — electron-builder).
    exclude: ["**/node_modules/**", "**/dist/**", "**/release/**", "server/vendor/**"],
  },
});

// Flat-конфиг ESLint (ESLint 9+/10).
// Разделяем три независимых окружения: браузерный React (src/), Node
// (server/, electron/, scripts/) и тесты vitest (tests/).
// Стилистику (отступы, кавычки, переносы) здесь НЕ проверяем — это работа Prettier.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

// Осознанные заглушки типов встречаются (например, marked.setOptions),
// поэтому any не запрещаем жёстко — только подсвечиваем.
const unusedVars = [
  "error",
  {
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrors: "none",
    ignoreRestSiblings: true,
  },
];

// react-hooks v7 вместе с классическими правилами (rules-of-hooks,
// exhaustive-deps) включает правила нового React Compiler. Они находят
// реальные проблемы, но требуют переписывания эффектов целыми пачками,
// поэтому временно включены как warning: шум в отчёте есть, сборка не падает.
const recommendedHooksRules = Object.fromEntries(
  Object.entries(reactHooks.configs.recommended.rules).map(([rule, level]) => [
    rule,
    ["react-hooks/rules-of-hooks", "react-hooks/exhaustive-deps"].includes(rule) ? level : "warn",
  ]),
);

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      // Вывод electron-builder (build.directories.output). Внутри — распакованное
      // приложение (win-unpacked): линтить там нечего, а сканирование тормозит.
      "release/**",
      "node_modules/**",
      "coverage/**",
      "storage/**",
      "server/vendor/**",
      "server/engines/**",
      // Генерируются из server/ts/*.ts при `npm run compile:server`.
      "server/config.js",
      "server/logger.js",
      "server/settings.js",
      "server/monitor.js",
      "server/jobStore.js",
      "server/fsUtil.js",
      "server/frontmatter.js",
      "server/download.js",
      "server/setupTask.js",
      "server/security.js",
      "server/elevate.js",
      "server/backup.js",
      "server/downloads.js",
      "server/comss.js",
      "server/proxySubscriptions.js",
      "server/proxyPing.js",
      "server/winget.js",
      "server/notes-fs.js",
      "server/torrent.js",
      "server/ruNlp.js",
      "server/db.js",
      "server/logBundle.js",
      "server/myspace-vault.js",
      "server/convertEngine.js",
      "server/index.js",
      "server/bookParser.js",
      "server/tmdb.js",
      "server/encoders.js",
      "server/vad.js",
      "server/diarize.js",
      "server/proxy.js",
      "server/ytdlp.js",
      "server/compressor.js",
      "server/upscale.js",
      "server/upscalePipeline.js",
      "server/whisperEngine.js",
      "server/sitebak.js",
      "server/tts.js",
      // ИИ-оформление заметок: server/ts/notesAi.ts (комментарий-запрет require
      // из TS-исходника переезжает в артефакт, где правило не определено).
      "server/notesAi.js",
      // Установка Python-окружения озвучки: серверный TS-исходник server/ts/pyEnv.ts
      // (тот же случай, что у notesAi.js: правило require-импорта не определено).
      "server/pyEnv.js",
      // Форум-трекер (поиск раздач) и дорожки плеера: TS-исходники
      // server/ts/{charset,trackerParse,trackerScraper,mediaProbe}.ts — в
      // trackerScraper.js тоже переезжает комментарий про require-импорт.
      "server/charset.js",
      "server/trackerParse.js",
      "server/trackerScraper.js",
      "server/mediaProbe.js",
      // browserCookies.ts — та же причина: собранный .js несёт комментарий про
      // require-импорт, которого в JS-конфиге ESLint нет.
      "server/browserCookies.js",
    ],
  },

  // ── Frontend: src/** ─────────────────────────────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...recommendedHooksRules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": unusedVars,
      eqeqeq: ["error", "smart"],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // ── Backend: server/**, electron/**, scripts/** ──────────────────────────
  {
    files: ["server/**/*.js", "electron/**/*.js", "scripts/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": unusedVars,
      eqeqeq: ["error", "smart"],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-console": "off",
      // Управляющие символы в регэкспах здесь осознанны: парсеры ANSI (\x1b),
      // NUL (\x00) и разделителей закладок (\x01/\x02) ищут именно их.
      "no-control-regex": "off",
    },
  },

  // ── Тесты ────────────────────────────────────────────────────────────────
  {
    files: ["tests/**/*.{ts,tsx,js}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": unusedVars,
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Тесты импортируют серверные CommonJS-модули через createRequire.
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // ── Серверные TS-исходники: server/ts/** (компилируются в server/*.js) ────
  {
    files: ["server/ts/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": unusedVars,
      eqeqeq: ["error", "smart"],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-console": "off",
      "no-control-regex": "off",
    },
  },

  // ── Декларации для ещё не переведённых .js-модулей: any здесь осознан ────
  {
    files: ["server/ts/**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ── Конфиги сборки на верхнем уровне (ESM, окружение Node) ───────────────
  {
    files: ["*.config.js", "*.config.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { "no-unused-vars": unusedVars },
  },
);

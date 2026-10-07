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
      // Артефакты tsc: server/ts → server, electron/ts → electron, scripts/ts → scripts
      // (npm run compile). Исходники — только в */ts/.
      "server/**/*.js",
      "electron/**/*.js",
      "scripts/**/*.{js,mjs}",
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

  // ── Node TS-исходники: server/ts, electron/ts, scripts/ts, vite.config.ts ──
  // (компилируются в server/, electron/, scripts/ командой npm run compile)
  {
    files: [
      "server/ts/**/*.ts",
      "electron/ts/**/*.ts",
      "scripts/ts/**/*.{ts,mts}",
      "vite.config.ts",
    ],
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
      // Отложенные require() — осознанный приём: разрыв циклических зависимостей,
      // платформенные ветки (win/linux) и тяжёлые модули, подгружаемые по требованию.
      // Типы им задаёт приведение `as typeof import(...)`.
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // ── Декларации типов: any здесь осознан ──────────────────────────────────
  {
    files: ["server/ts/**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ── Конфиги сборки на верхнем уровне (ESM, окружение Node) ───────────────
  {
    files: ["*.config.js", "*.config.mjs", "*.config.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { "no-unused-vars": unusedVars },
  },
);

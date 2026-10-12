import { defineConfig } from "@playwright/test";

// E2E-тесты запускают собранное приложение Electron (npm run build:web && npm run compile).
// Файлы называются *.e2e.ts, чтобы Vitest их не подхватывал.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  retries: 0,
  workers: 1, // одно приложение за раз: у Electron единственный экземпляр
  reporter: [["list"]],
});

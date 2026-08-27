import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Опционально: Vite dev-сервер проксирует запросы на Express-бэкенд.
    proxy: {
      "/api": "http://localhost:4000",
      "/events": "http://localhost:4000",
    },
  },
  test: {
    // Не собираем чужие тесты из вендоренных проектов (ConvertX и т.п.)
    exclude: ["**/node_modules/**", "**/dist/**", "server/vendor/**"],
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    // Alias "@/..." -> src/ — единый способ импорта внутри фронтенда
    // (те же paths в tsconfig.json). Доменные папки можно переносить
    // без пересчёта количества "../".
    alias: { "@": path.resolve(__dirname, "src") },
  },
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
    watch: {
      // НЕ следим за storage/: это рабочий каталог приложения, куда пишут внешние
      // процессы. Проверка конфигов zapret запускает vendor-скрипт
      // (storage/zapret/utils/test zapret.ps1), который создаёт и держит открытым
      // файл storage/zapret/utils/test results/test_results_*.txt. Chokidar видит
      // новый файл и пытается повесить на него fs.watch — Windows отдаёт EBUSY,
      // а Vite не перехватывает ошибку вотчера и падает целиком.
      // Глобы + регулярки — на случай разного поведения chokidar на Windows.
      ignored: ["**/storage/**", "**/dist/**", "**/.git/**", /[\\/]storage[\\/]/, /[\\/]dist[\\/]/],
    },
  },
  test: {
    // Не собираем чужие тесты из вендоренных проектов (ConvertX и т.п.)
    exclude: ["**/node_modules/**", "**/dist/**", "server/vendor/**"],
  },
});

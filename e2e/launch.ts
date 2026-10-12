import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

export interface Launched {
  app: ElectronApplication;
  page: Page;
  storage: string;
  close: () => Promise<void>;
}

/**
 * Запускает приложение с чистым storage и отдельным userData (иначе сработает
 * блокировка единственного экземпляра, если у разработчика уже открыто MoonApp).
 */
export async function launchApp(): Promise<Launched> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-e2e-"));
  const storage = path.join(root, "storage");
  const userData = path.join(root, "userData");
  fs.mkdirSync(storage, { recursive: true });
  const app = await electron.launch({
    args: [path.resolve(__dirname, ".."), `--user-data-dir=${userData}`],
    env: { ...process.env, MOONAPP_STORAGE: storage },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return {
    app,
    page,
    storage,
    close: async () => {
      await app.close();
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* временный каталог уберёт ОС */
      }
    },
  };
}

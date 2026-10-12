import { openTarget } from "@/lib/deepLink";

const OPEN_KEY = "moonapp.settings.open";

/** Открывает «Настройки → ИИ и модели» с уже раскрытой секцией (единый хаб моделей). */
export function openAiHub(sectionTitle: string): void {
  try {
    const cur = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}") as Record<string, boolean>;
    localStorage.setItem(OPEN_KEY, JSON.stringify({ ...cur, [sectionTitle]: true }));
  } catch {
    /* localStorage недоступен — секция просто останется в прежнем состоянии */
  }
  openTarget({ page: "settings" });
}

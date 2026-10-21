import { lazy, Suspense, useEffect, useState } from "react";
import { useTw } from "@/pages/sheet/i18n/useTw";

/**
 * «Презентации»: готовый DeckCraft (веб-сборка, wasm) с вкладками и файлами (DeckWeb). Запасного редактора нет:
 * если сборки рядом с приложением нет (`public/office/deck`, см. scripts/buildOfficeWeb.mjs), страница говорит об этом.
 */
const DECK_URL = "/office/deck/index.html";
const Web = lazy(() => import("@/pages/deck/parts/DeckWeb"));

type Mode = "check" | "web" | "missing";

export default function DeckPage() {
  const tw = useTw();
  const [mode, setMode] = useState<Mode>("check");
  useEffect(() => {
    let live = true;
    // Сервер отдаёт index.html приложения на любой неизвестный адрес, поэтому смотрим на содержимое.
    fetch(DECK_URL)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => live && setMode(t.includes("deckcraft_canvas") ? "web" : "missing"))
      .catch(() => live && setMode("missing"));
    return () => {
      live = false;
    };
  }, []);

  if (mode === "check") return <div className="wd-web" />;
  if (mode === "missing") {
    return <div className="wd-web">{tw("The presentation editor is not built: run npm run office:deck")}</div>;
  }
  return (
    <Suspense fallback={<div className="wd-web" />}>
      <Web />
    </Suspense>
  );
}

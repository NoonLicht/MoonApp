import { lazy, Suspense, useEffect, useState } from "react";
import { useTw } from "@/pages/sheet/i18n/useTw";

/**
 * «Фоторедактор»: готовый PhotoCraft (веб-сборка, wasm) с вкладками и файлами (PhotoWeb). Запасного просмотрщика нет:
 * если сборки рядом с приложением нет (`public/office/photo`, см. scripts/buildOfficeWeb.mjs), страница говорит об этом.
 */
const PHOTO_URL = "/office/photo/index.html";
const Web = lazy(() => import("@/pages/photoedit/parts/PhotoWeb"));

type Mode = "check" | "web" | "missing";

export default function PhotoEditPage() {
  const tw = useTw();
  const [mode, setMode] = useState<Mode>("check");
  useEffect(() => {
    let live = true;
    // Сервер отдаёт index.html приложения на любой неизвестный адрес, поэтому смотрим на содержимое.
    fetch(PHOTO_URL)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => live && setMode(t.includes('id="photocraft_canvas"') ? "web" : "missing"))
      .catch(() => live && setMode("missing"));
    return () => {
      live = false;
    };
  }, []);

  if (mode === "check") return <div className="wd-web" />;
  if (mode === "missing") {
    return <div className="wd-web">{tw("The photo editor is not built: run npm run office:photo")}</div>;
  }
  return (
    <Suspense fallback={<div className="wd-web" />}>
      <Web />
    </Suspense>
  );
}

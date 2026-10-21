import { lazy, Suspense, useEffect, useState } from "react";

/**
 * «Таблицы»: готовый GridCraft (веб-сборка, wasm) с вкладками, файлами и помощником (SheetWeb). Если сборки
 * нет рядом с приложением (`public/office/sheet`, см. scripts/buildOfficeWeb.mjs) — прежний редактор.
 */
const SHEET_URL = "/office/sheet/index.html";
const Classic = lazy(() => import("@/pages/sheet/SheetPage"));
const Web = lazy(() => import("@/pages/sheet/parts/SheetWeb"));

type Mode = "check" | "web" | "classic";

export default function SheetRoot() {
  const [mode, setMode] = useState<Mode>("check");
  useEffect(() => {
    let live = true;
    // Сервер отдаёт index.html приложения на любой неизвестный адрес, поэтому смотрим на содержимое.
    fetch(SHEET_URL)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => live && setMode(t.includes("gridcraft_canvas") ? "web" : "classic"))
      .catch(() => live && setMode("classic"));
    return () => {
      live = false;
    };
  }, []);

  if (mode === "check") return <div className="wd-web" />;
  return (
    <Suspense fallback={<div className="wd-web" />}>{mode === "classic" ? <Classic /> : <Web />}</Suspense>
  );
}

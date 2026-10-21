import { lazy, Suspense, useEffect, useState } from "react";

/**
 * «Документы»: готовый WordCraft (веб-сборка, wasm) во весь экран страницы. Если сборки нет рядом
 * с приложением (`public/office/word`, см. scripts/buildOfficeWeb.mjs) — прежний редактор.
 */
const WORD_URL = "/office/word/index.html";
const Classic = lazy(() => import("@/pages/word/WordPage"));

type Mode = "check" | "web" | "classic";

export default function WordRoot() {
  const [mode, setMode] = useState<Mode>("check");
  useEffect(() => {
    let live = true;
    // Сервер отдаёт index.html приложения на любой неизвестный адрес, поэтому смотрим на содержимое.
    fetch(WORD_URL)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => live && setMode(t.includes("wordcraft_canvas") ? "web" : "classic"))
      .catch(() => live && setMode("classic"));
    return () => {
      live = false;
    };
  }, []);

  if (mode === "check") return <div className="wd-web" />;
  if (mode === "classic")
    return (
      <Suspense fallback={<div className="wd-web" />}>
        <Classic />
      </Suspense>
    );
  return <iframe className="wd-web" title="WordCraft" src={WORD_URL} allow="clipboard-read; clipboard-write; fullscreen" />;
}

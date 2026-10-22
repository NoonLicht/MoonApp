import { lazy, Suspense, useEffect, useState } from "react";
import { useTw } from "@/pages/sheet/i18n/useTw";

/**
 * «PDF»: готовый PdfCraft (веб-сборка, wasm) с вкладками и файлами (PdfWeb). Запасного просмотрщика нет:
 * если сборки рядом с приложением нет (`public/office/pdf`, см. scripts/buildOfficeWeb.mjs), страница говорит об этом.
 */
const PDF_URL = "/office/pdf/index.html";
const Web = lazy(() => import("@/pages/pdf/parts/PdfWeb"));

type Mode = "check" | "web" | "missing";

export default function PdfPage() {
  const tw = useTw();
  const [mode, setMode] = useState<Mode>("check");
  useEffect(() => {
    let live = true;
    // Сервер отдаёт index.html приложения на любой неизвестный адрес, поэтому смотрим на содержимое.
    fetch(PDF_URL)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => live && setMode(t.includes('id="pdfcraft"') ? "web" : "missing"))
      .catch(() => live && setMode("missing"));
    return () => {
      live = false;
    };
  }, []);

  if (mode === "check") return <div className="wd-web" />;
  if (mode === "missing") {
    return <div className="wd-web">{tw("The PDF editor is not built: run npm run office:pdf")}</div>;
  }
  return (
    <Suspense fallback={<div className="wd-web" />}>
      <Web />
    </Suspense>
  );
}

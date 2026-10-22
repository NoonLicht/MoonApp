import { useEffect, useState } from "react";
import { useI18n } from "@/app/i18n";
import { useTw } from "@/pages/sheet/i18n/useTw";

/**
 * Страница на готовой веб-сборке сторонней программы (wasm, см. native/office-web) без моста: рамка во всю страницу,
 * файлы редактор открывает и сохраняет сам (окно выбора файла и скачивание). Язык приложения идёт в адресе рамки (`?lang=`).
 * Сборки нет рядом с приложением (`public/office/<имя>`, scripts/buildOfficeWeb.mjs) — страница говорит, как её собрать.
 */
interface Props {
  /** Адрес страницы редактора (без параметров). */
  src: string;
  /** Что есть в странице настоящей сборки (сервер отдаёт index.html приложения на любой неизвестный адрес). */
  marker: string;
  title: string;
  /** Что сказать, если сборки нет (английский ключ каталога). */
  missing: string;
  /** Языки, на которых редактор может показать интерфейс; остальные — английский. */
  langs?: readonly string[];
  /** Дополнительные параметры адреса рамки (`nosw` и т. п.). */
  flags?: readonly string[];
}

type Mode = "check" | "web" | "missing";

export default function AppFrame({ src, marker, title, missing, langs = ["ru", "en"], flags = [] }: Props) {
  const { lang } = useI18n();
  const tw = useTw();
  const [mode, setMode] = useState<Mode>("check");
  useEffect(() => {
    let live = true;
    fetch(src)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => live && setMode(t.includes(marker) ? "web" : "missing"))
      .catch(() => live && setMode("missing"));
    return () => {
      live = false;
    };
  }, [src, marker]);

  if (mode === "check") return <div className="wd-web" />;
  if (mode === "missing") return <div className="wd-web">{tw(missing)}</div>;
  const code = langs.includes(lang) ? lang : "en";
  return (
    <div className="wd-web-body" style={{ height: "100%" }}>
      <div className="wd-web-frames">
        <iframe
          className="on"
          title={title}
          src={`${src}?lang=${code}${flags.map((f) => `&${f}`).join("")}`}
          allow="clipboard-read; clipboard-write; fullscreen; autoplay; microphone"
        />
      </div>
    </div>
  );
}

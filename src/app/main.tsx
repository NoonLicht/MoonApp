import { createRoot } from "react-dom/client";
import App from "@/app/App";
import { loadLang, storedLang } from "@/app/i18n";
import "@/styles/theme.css";

// Язык из прошлого запуска грузим ДО первого кадра: настройки приходят от
// сервера асинхронно, и без этого интерфейс мигал бы английским.
void loadLang(storedLang())
  .catch(() => undefined)
  .then(() => {
    const root = createRoot(document.getElementById("root") as HTMLElement);
    root.render(<App />);
  });

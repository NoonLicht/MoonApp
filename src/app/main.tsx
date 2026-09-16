import { createRoot } from "react-dom/client";
import App from "@/app/App";
import "@/styles/theme.css";

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(<App />);

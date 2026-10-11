import "@/styles/canvas.css";
import { useCanvasPage } from "@/pages/myspace/canvas/useCanvasPage";
import CanvasPageView from "@/pages/myspace/canvas/CanvasPageView";

export default function CanvasPage() {
  const c = useCanvasPage();
  return <CanvasPageView c={c} />;
}

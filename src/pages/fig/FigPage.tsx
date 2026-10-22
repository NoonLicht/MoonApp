import AppFrame from "@/components/office/AppFrame";

/** «Дизайн»: FigCraft (векторный редактор, веб-сборка на wasm); язык интерфейса задаёт `?lang=`. */
export default function FigPage() {
  return (
    <AppFrame
      src="/office/fig/index.html"
      marker="figcraft_canvas"
      title="FigCraft"
      missing="The design editor is not built: run npm run office:fig"
    />
  );
}

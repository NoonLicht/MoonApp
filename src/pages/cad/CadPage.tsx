import AppFrame from "@/components/office/AppFrame";

/** «Черчение»: CadCraft (САПР, веб-сборка на wasm); язык интерфейса задаёт `?lang=`. */
export default function CadPage() {
  return (
    <AppFrame
      src="/office/cad/index.html"
      marker="cadcraft"
      title="CadCraft"
      missing="The CAD editor is not built: run npm run office:cad"
    />
  );
}

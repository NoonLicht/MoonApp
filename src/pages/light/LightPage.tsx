import AppFrame from "@/components/office/AppFrame";

/** LightCraft (photo developer, веб-сборка на wasm); язык интерфейса задаёт `?lang=`. */
export default function LightPage() {
  return (
    <AppFrame
      src="/office/light/index.html"
      marker="lightcraft"
      title="LightCraft"
      missing="The photo developer is not built: run npm run office:light"
    />
  );
}

import AppFrame from "@/components/office/AppFrame";

/** «Звук»: SoundCraft (веб-сборка, wasm; интерфейс только на английском). */
export default function SoundPage() {
  return (
    <AppFrame
      src="/office/sound/index.html"
      marker="soundcraft"
      title="SoundCraft"
      missing="The sound editor is not built: run npm run office:sound"
      langs={["en"]}
    />
  );
}

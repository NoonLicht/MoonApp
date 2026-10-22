import AppFrame from "@/components/office/AppFrame";

/** EffectCraft (motion-graphics editor, веб-сборка на wasm); язык интерфейса задаёт `?lang=`. */
export default function EffectPage() {
  return (
    <AppFrame
      src="/office/effect/index.html"
      marker="effectcraft"
      title="EffectCraft"
      missing="The effects editor is not built: run npm run office:effect"
      flags={["nosw"]}
    />
  );
}

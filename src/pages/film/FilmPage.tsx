import AppFrame from "@/components/office/AppFrame";

/** FilmCraft (video editor, веб-сборка на wasm); язык интерфейса задаёт `?lang=`. */
export default function FilmPage() {
  return (
    <AppFrame
      src="/office/film/index.html"
      marker="filmcraft"
      title="FilmCraft"
      missing="The video editor is not built: run npm run office:film"
    />
  );
}

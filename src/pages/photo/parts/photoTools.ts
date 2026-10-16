import { api } from "@/api/client";
import type { ToolActions } from "@/components/ToolInstall";

/** Маршруты установки инструментов страницы «Фото и видео». */
export const photoToolActions: ToolActions = {
  install: (id, device) => api.photoToolInstall(id, device),
  cancel: () => api.photoToolCancel(),
  remove: (id) => api.photoToolRemove(id),
};

export const fetchPhotoTools = (): ReturnType<typeof api.photoTools> => api.photoTools();

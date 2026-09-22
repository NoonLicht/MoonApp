/**
 * Отдельный процесс для сборки движка TensorRT (кнопка «Собрать движок» в панели
 * моделей апскейла).
 *
 * Зачем отдельный процесс: сборка — это нативный код TensorRT/CUDA (перебор
 * тактик под builder_optimization_level, длинные ядра автотюнинга). На части
 * связок драйвер/карта/модель это либо роняет сам биндинг onnxruntime-node
 * (segfault — try/catch в JS такое не ловит), либо настолько надолго занимает
 * GPU, что Windows сбрасывает драйвер (TDR) — и то и другое раньше убивало
 * основной процесс Electron целиком (server/routes/upscale.js вызывал
 * buildTrtEngine прямо в нём). Здесь падает только этот воркер: основной
 * процесс и окно остаются живы, а route отвечает понятной ошибкой.
 */
import { buildTrtEngine } from "./trt";

type Req = { id: string; tile?: number };
type Res = { ok: true; result: Awaited<ReturnType<typeof buildTrtEngine>> } | { ok: false; error: string };

process.on("message", (msg: Req | undefined) => {
  if (!msg || typeof msg.id !== "string") return;
  buildTrtEngine(msg.id, { tile: msg.tile })
    .then((result) => {
      const res: Res = { ok: true, result };
      process.send?.(res, () => process.exit(0));
    })
    .catch((e: unknown) => {
      const res: Res = { ok: false, error: (e as Error)?.message || String(e) };
      process.send?.(res, () => process.exit(1));
    });
});

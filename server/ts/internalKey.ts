import crypto from "node:crypto";

/**
 * Ключ процесса для внутренних запросов сервера к самому себе (ffprobe/ffmpeg
 * читают собственный Range-стрим торрента по http://127.0.0.1). Внешний токен
 * x-moonapp-token они подставить не могут, поэтому authMiddleware пускает
 * путь /api/movies/torrent/stream/ с этим ключом. Ключ случайный на каждый
 * запуск и в ответы API не попадает.
 */
export const INTERNAL_KEY = crypto.randomBytes(16).toString("hex");
export const INTERNAL_STREAM_PREFIX = "/api/movies/torrent/stream/";

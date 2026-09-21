import type { ChildProcess } from "child_process";

export interface UpParams {
  model: string;
  model2: string;
  blendAmount: number;
  scale: number;
  targetW: number;
  targetH: number;
  tile: number;
  overlap: number;
  threads: number;
  provider: string;
  format: string;
  quality: number;
  sharpen: number;
  denoise: number;
  vcodec: string;
  vcrf: number;
  audioAction: string;
  presetId: string;
  /** off | ffmpeg (minterpolate) | model (ONNX RIFE/CAIN — фаза 2). */
  interpMode: string;
  /** id ONNX-интерполятора из манифеста (kind="interp"); пусто — первый доступный. */
  interpModel: string;
  /** 2 | 3 | 4: во сколько раз больше кадров на выходе. */
  interpMult: number;
  /** mci (оценка движения) | blend (смешивание) | dup (дубли). */
  minterpolateMode: string;
  /**
   * Где считать вставки: decode (до апскейла) | encode (после апскейла).
   *
   * У ffmpeg-режима это сторона фильтра minterpolate, у ONNX-модели — где движок
   * считает промежуточные кадры: «до апскейла» интерполирует исходные кадры (и
   * апскейлер обрабатывает в mult раз больше кадров), «после» — увеличенные.
   */
  minterpolateSide: string;
  /** Порог смены сцены 0–100: выше — дубли вместо интерполяции (без «двойников»). */
  sceneCutThreshold: number;
  /**
   * Кадров за один session.run (0 — «Авто» | 1 | 2 | … | 128): пачка экономит
   * накладные расходы ONNX. Граф с жёстким batch=1 (большинство Real-ESRGAN)
   * пачку не принимает — движок тогда вообще не копит очередь (см. runVideo).
   */
  batchFrames: number;
  /**
   * Сколько ТАЙЛОВ интерполятора считать одним session.run (0 — «Авто», 1 — по
   * тайлу за раз). Вторая «пачка» — для интерполятора: он работает по паре кадров
   * и своим тайлингом, поэтому настраивается отдельно от апскейла. Как и у
   * апскейлера, значение имеет смысл только если граф принимает batch>1.
   */
  interpBatch: number;
  /** Обработать только первые N кадров видео (0 — весь файл): быстрая проба. */
  frameLimit: number;
  /** Замедление результата: 1 — как есть, 0.5 — вдвое медленнее, 0.25 — вчетверо. */
  slowMotion: number;
  /**
   * Считать кодирование и декодирование на видеокарте, если она есть (NVENC/QSV/
   * AMF + аппаратный декодер). Выключено — всё делает CPU (lib*-кодировщики).
   */
  hwAccel: boolean;
}

/** Сырые поля из тела запроса (до normalizeParams). */
export interface RawUpParams extends Partial<Record<keyof UpParams, unknown>> {
  inputPath?: unknown;
  name?: unknown;
  size?: unknown;
}

/** Задание апскейла: UI опрашивает его состояние. */
export interface UpJob extends UpParams {
  id: string;
  kind: "photo" | "video";
  createdAt: number;
  startedAt: number;
  inputPath: string;
  outFile: string | null;
  /** Расширение результата (png/jpg/webp/avif | mp4/mkv) — для имени при скачивании. */
  outExt: string;
  name: string;
  size: number;
  stage: string;
  progress: number;
  etaSec: number | null;
  done: boolean;
  error: string;
  outSize: number;
  outWidth: number;
  outHeight: number;
  engineUsed: string;
  providerUsed: string;
  /** Кодировщик результата: «NVENC» / «SVT-AV1» / «x264» (что реально сработало). */
  encoderUsed: string;
  /** Пачка кадров, с которой реально считали (для «Авто» — подобранная). */
  batchUsed: number;
  /**
   * Пачка ТАЙЛОВ интерполятора, с которой реально считали (0 — не считается:
   * интерполяция выключена или модель принимает только один тайл за run).
   */
  interpBatchUsed: number;
  /**
   * Почему пачка не используется, если она выключена: "" — используется или не
   * запрашивалась, "unsupported" — граф принимает один кадр, "mixed" — смешивание
   * двух моделей, "nomodel" — без апскейла. UI показывает это вместо «Авто (64)»,
   * когда фактически кадры идут по одному.
   */
  batchReason: string;
  /** Задание на паузе: кадры и процессы живут, но обработка стоит. */
  paused: boolean;
  framesDone: number;
  framesTotal: number;
  fps: number;
  /** Частота кадров результата (нужна для бейджа «25 → 50 fps»). */
  fpsOut: number;
  info: {
    width?: number;
    height?: number;
    codec?: string;
    fps?: number;
    duration?: number;
  };
  command: string;
}

/** Пресет апскейла: системные из SYSTEM_PRESETS + пользовательские из settings. */
export interface UpPreset {
  id: string;
  kind: "photo" | "video";
  model: string;
  scale: number;
  format?: string;
  quality?: number;
  tile?: number;
  overlap?: number;
  sharpen?: number;
  denoise?: number;
  provider?: string;
  targetW?: number;
  targetH?: number;
  vcodec?: string;
  vcrf?: number;
  audioAction?: string;
  /** Пресеты плавности: те же поля, что у UpParams (см. интерполяцию). */
  interpMode?: string;
  /** Какая модель-интерполятор (когда interpMode = "model"). */
  interpModel?: string;
  interpMult?: number;
  minterpolateMode?: string;
  minterpolateSide?: string;
  sceneCutThreshold?: number;
  batchFrames?: number;
  interpBatch?: number;
  frameLimit?: number;
  slowMotion?: number;
}

/** Модель для UI: каталог из манифеста + статус наличия файла. */
export interface UpModelInfo {
  id: string;
  label: string;
  /** upscale — апскейлер, interp — интерполятор кадров (разные списки в UI). */
  kind: "upscale" | "interp";
  /** Множитель апскейла либо во сколько раз интерполятор увеличивает число кадров. */
  scale: number;
  mult: number;
  /** Максимум множителя плавности: у CAIN 2, у RIFE/IFRNet — до MAX_INTERP_MULT. */
  multMax: number;
  arch: string;
  /** Схема входов интерполятора (пусто у апскейлеров). */
  inputSig: string;
  /**
   * Сколько кадров модель принимает за один run: 1 — жёстко один (пачка
   * невозможна), 0 — неизвестно (движок пробует и запоминает отказ), N>1 — предел.
   */
  batch: number;
  /** Кратность сторон входа (1 — требование не задано): панель и UI показывают как «×2». */
  align: number;
  /** Рекомендованный провайдер модели ("" — как в настройках). */
  provider: string;
  /**
   * Собранный движок TensorRT этой модели («512/…engine», пусто — не собран).
   * Имена файлов движков — хеши графа, поэтому связь «модель → движок» ведём
   * реестром (`.trt\registry.json`), а не по именам файлов.
   */
  trtEngine: string;
  file: string;
  sizeMb: number;
  license: string;
  url: string;
  path: string;
  available: boolean;
  /** Файл ONNX лежит на диске (false у «тензорных» моделей: ONNX убран, движок есть). */
  onnxOnDisk: boolean;
  /** Категории модели (photo/video/anime/fast/detail/restore/heavy/interp). */
  tags: string[];
  /** Рекомендуемые настройки этой модели: тайл, перекрытие, резкость, шум. */
  rec: {
    scale?: number;
    tile?: number;
    overlap?: number;
    sharpen?: number;
    denoise?: number;
    interpMult?: number;
    sceneCut?: number;
  };
  /** Измерено на реальном инференсе (мс и множитель) — для подсказки в панели. */
  measured: string;
  /** sha256 из манифеста: если задан, загрузка проверяется по хешу. */
  sha256: string;
  /** Что это за модель и для чего (короткое описание). */
  hint: string;
  /** Прогресс скачивания этой модели (0…100) или null, если не качается. */
  downloading: { gotMb: number; totalMb: number; percent: number } | null;
}

/** Запись манифеста server/models.manifest.json. */
export interface ManifestModel {
  id: string;
  label: string;
  /** По умолчанию "upscale" (старые записи поле не содержат). */
  kind?: string;
  scale: number;
  /** У интерполяторов — сколько кадров даёт одна пара (обычно 2). */
  mult?: number;
  arch: string;
  inputSig?: string;
  file: string;
  sizeMb: number;
  license: string;
  bgr?: boolean;
  tile?: number;
  /** Перекрытие тайлов по умолчанию (у интерполяторов больше — швы в движении). */
  overlap?: number;
  /**
   * Кратность сторон входа (Real-CUGAN и родственные: внутри есть down/up-семплинг).
   * Движок добирает тайл повтором края и обрезает результат при вклейке.
   */
  align?: number;
  /**
   * Рекомендованный провайдер модели (`cpu` — если граф не работает на GPU,
   * например Anime4K на DirectML). Движок ставит его первым в списке попыток.
   */
  provider?: string;
  url: string;
  sha256: string;
  /** Категории для фильтра в панели моделей: photo/video/anime/fast/… */
  tags?: string[];
  /** Оптимальные настройки именно этой модели (кнопка «Применить» в панели). */
  rec?: {
    scale?: number;
    tile?: number;
    overlap?: number;
    sharpen?: number;
    denoise?: number;
    interpMult?: number;
    sceneCut?: number;
  };
  /** Как модель показала себя на реальном инференсе (для панели моделей). */
  _measured?: string;
  _hint?: string;
  /**
   * Сколько кадров модель принимает за ОДИН session.run.
   *
   *   1  — граф жёстко ждёт batch=1 (так у большинства Real-ESRGAN): пачка
   *        кадров не просто бесполезна, а вредна — очередь копила бы десятки
   *        полных кадров в RAM, а GPU простаивал между «залпами»;
   *   N>1 — динамическая ось, граф принимает до N кадров за раз;
   *   нет поля — неизвестно: движок пробует пачку и запоминает отказ
   *        (см. batchUnsupported), а точный факт пишет scripts/verify-model.js.
   *
   * У интерполяторов то же поле означает «сколько тайлов пары за один run».
   */
  batch?: number;
}

// ================== КАТАЛОГ МОДЕЛЕЙ (живой манифест) ==================
// Каталог НЕ должен приезжать только вместе с обновлением приложения: список
// моделей правится в репозитории на GitHub, а приложение забирает его кнопкой
// «Обновить каталог» (POST /api/upscale/models/sync). Источники по приоритету:
//
//   1) storage/models/models.manifest.json — скачанный каталог. Он ПЕРЕКРЫВАЕТ
//      встроенный целиком: добавили модель на GitHub — она появляется у
//      пользователя, убрали — исчезает (файл при этом с диска не удаляется);
//   2) server/models.manifest.json — вшитый в сборку (первый запуск, офлайн).
//
// Адресов по умолчанию два — сам GitHub (raw) и зеркало jsDelivr: если один
// недоступен, sync пробует следующий. Свой адрес (например, отдельный
// репозиторий только с каталогом) задаётся переменной MOONAPP_MANIFEST_URL.
export interface ManifestCache {
  /**
   * Ключ «путь + время правки»: правку файла видно сразу, а смена источника
   * (после sync) сама инвалидирует кэш — путь в ключе другой.
   */
  key: string;
  /** Из какого файла прочитан каталог (для manifestInfo). */
  file: string;
  mtime: number;
  models: ManifestModel[];
}

/** Читает каталог: сначала скачанный (storage), затем вшитый в сборку. */
export interface ManifestInfo {
  /** remote — каталог скачан кнопкой; bundled — вшитый в сборку. */
  source: "remote" | "bundled";
  /** Файл, из которого реально прочитан каталог. */
  path: string;
  /** Основной адрес обновления (кнопка «Обновить каталог»). */
  url: string;
  count: number;
  /** Когда каталог скачивали в последний раз (ISO) или "". */
  updatedAt: string;
}

export interface ManifestSyncResult {
  ok: boolean;
  /** Работавший адрес (основной или зеркало). */
  url: string;
  source: "remote";
  path: string;
  count: number;
  /** Ид моделей, которых раньше не было / которые исчезли / изменились. */
  added: string[];
  removed: string[];
  changed: string[];
  updatedAt: string;
}

/**
 * «Обновить каталог»: тянем манифест из GitHub (или своего адреса), проверяем
 * каждую запись и кладём в storage. Каталог в приложении меняется сразу —
 * обновлять сборку приложения для новой модели не нужно.
 *
 * Ошибки переводимы и не разрушают текущий каталог: файл пишется только после
 * успешной проверки (через .tmp + rename), поэтому прерванная загрузка не
 * оставит «половину» манифеста.
 */
export interface OrtTensor {
  data: Float32Array;
  dims: readonly number[];
}
export interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  /** Освобождение ресурсов: без него память (в т.ч. видеопамять) не отдаётся. */
  release?: () => Promise<void>;
  /**
   * Типы тензоров графа. Нужны, чтобы поддержать модели половинной точности
   * (fp16-экспорты Anime4K и подобные): у них вход/выход не float32, и без
   * конверсии ORT падает на «unexpected data type». У onnxruntime-node это
   * массив `{name, type, shape}`, у старых сборок — словарь по имени входа.
   */
  inputMetadata?: unknown;
  outputMetadata?: unknown;
}
export interface OrtModule {
  InferenceSession: {
    create(p: string, o?: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
  env?: { versions?: { common?: string } };
  /** Какие провайдеры собраны в этот рантайм (cpu/dml/cuda/tensorrt/…). */
  listSupportedBackends?: () => { name?: string }[];
}

/** Повторять неудачную попытку не чаще, чем раз в 5 секунд. */
export interface TrtStatus {
  available: boolean;
  /** Что вообще есть в рантайме (для подсказки в UI). */
  backends: string[];
  dir: string;
  engines: { file: string; sizeMb: number; mtime: number }[];
}

/** Готовность TensorRT: есть ли провайдер в сборке и что уже собрано. */
export interface TrtBuildResult {
  ok: boolean;
  ms: number;
  /** Размер входа, под который собран движок (он же — размер тайла). */
  profile: number;
  /** Новые файлы движка: пусто — движок уже лежал в кэше и был просто загружен. */
  engines: { file: string; sizeMb: number }[];
  /** Движок не собирался заново, а взят из кэша (первый заход был мгновенным). */
  reused: boolean;
  /** Файл движка этой модели («512/модель/…engine») — для сообщения в панели. */
  engine: string;
  engineMb: number;
  /** Сколько движков собрано всего (по всем моделям и профилям). */
  total: number;
  /** Сколько МБ освободило удаление ONNX (0 — файл оставлен или уже удалён). */
  onnxFreedMb: number;
}

/**
 * Потолок размера ONNX, который убираем после сборки движка. Крупные модели
 * (CAIN, 164 МБ) оставляем: их докачка при следующем запуске была бы заметной.
 */
export interface ReadySession {
  session: OrtSession;
  provider: string;
  bgr: boolean;
  scale: number;
  /** Граф объявлен во float16: вход и выход конвертируются на границе ORT. */
  fp16?: boolean;
  /** Ключ в кэше: по нему убираем запись, когда сессию выгружаем. */
  key: string;
  /** Сколько session.run выполняется прямо сейчас (0 — сессия свободна). */
  runs?: number;
  /** Помечена на выгрузку: release() ждём до конца текущего run. */
  dead?: boolean;
}

// Кэш сессий: создание ONNX-сессии — дорогая операция (чтение файла, графы).
export type HalfArrayCtor = new (src: ArrayLike<number>) => ArrayLike<number>;
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Прямоугольники тайлов с перекрытием. tile <= 0 или тайл больше картинки →
 * один тайл на всё изображение. Последний столбец/строка прижимаются к краю,
 * а дубликаты (когда шаг не делит размер) отбрасываются по ключу.
 */
export type InterpSig = "rife-pair-timestep" | "cain-concat" | "ifrnet-pair";

/** Известные схемы: набор характерных имён входов → сигнатура. */
export interface BenchEntry {
  model: string;
  /** Провайдер, на котором реально считалось (cuda/tensorrt/dml/cpu). */
  provider: string;
  /** Тайл замера: один тайл — один вход графа. */
  tile: number;
  /** Пачка кадров замера (замер времени всегда одиночный = 1). */
  batch: number;
  /**
   * Сколько кадров модель принимает за один проход — проверено на этой машине:
   * 1 — граф ждёт ровно один кадр, 0 — проверить не удалось, больше 1 — предел
   * пачки. В каталоге этот факт есть не у всех моделей (там как раз «пачка ?»),
   * поэтому замер выясняет его сам.
   */
  batchMax: number;
  /** Лучшее время одного тайла, мс. */
  ms: number;
  /** Оценка полного эталонного кадра (все тайлы), мс. */
  frameMs: number;
  /** Кадров эталонного размера в секунду — по числу тайлов. */
  fps: number;
  /** Тайлов в эталонном кадре. */
  tiles: number;
  /** Сколько прогонов измерили (без прогрева). */
  runs: number;
  /** Движок TensorRT, если считалось на нём. */
  engine: string;
  /** Когда замер сделан (мс). */
  when: number;
}

/** Замеры этой машины: модель → список (свой на каждый провайдер и тайл). */
export type BenchResults = Record<string, BenchEntry[]>;

export interface UpEstimate {
  kind: "photo" | "video";
  /** Размеры результата (после приведения к выбранному множителю). */
  outWidth: number;
  outHeight: number;
  /** Кадров исходника, которое реально обработаем (с учётом лимита). */
  inFrames: number;
  /** Кадров на выходе: с интерполяцией их больше. */
  outFrames: number;
  /** Частота кадров результата (для плавности). */
  fpsOut: number;
  /** Длительность результата, секунды (замедление растягивает её). */
  durationSec: number;
  /** Итоговый множитель замедления (1 — без замедления). */
  slowMotion: number;
  /** Мегапиксели суммарной работы — по ним считается время. */
  totalMegapixels: number;
  /** Ожидаемое время обработки, секунды; null — ещё нет измерений на машине. */
  etaSec: number | null;
  /** Что помешает запуску или о чём стоит предупредить (ключи i18n up.est_*). */
  warnings: string[];
}

/**
 * Оценка будущего задания по параметрам и пробе файла: размеры, число кадров,
 * частота результата и время. Ничего не запускает и не трогает файлы —
 * поэтому безопасна для вызова на каждое изменение настроек в UI.
 */
export interface TrackedProc {
  proc: ChildProcess;
  kind: string;
  pid: number;
  /** Процесс уже получал сигнал: повторный заход сторожа добивает принудительно. */
  killed: boolean;
}

/**
 * Регистрация процесса за заданием. Экспортируется, чтобы это можно было
 * проверить тестом (на реальном долгоживущем процессе): сам движок зовёт её из
 * пайплайна (`onProc`) и из фото-пути (`runCapture`).
 */

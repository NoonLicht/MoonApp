#!/usr/bin/env node
"use strict";

/**
 * Матричный замер моделей: мс на кадр и fps по провайдерам, профилям и пачкам.
 *
 * Мерим полный кадр (все тайлы), а не один тайл: именно это видит пользователь.
 * Первый заход — прогрев (у TensorRT он же сборка движка), в таблицу идёт второй,
 * поэтому цифры соответствуют установившемуся режиму.
 *
 * Запуск:
 *   node scripts/bench-models.js                              # все модели, tensorrt, пачки 1..16
 *   node scripts/bench-models.js --providers cuda,tensorrt    # два провайдера подряд
 *   node scripts/bench-models.js --providers cuda --batches 1,2,4,8,16
 *   MOONAPP_ORT_STOCK=1 node scripts/bench-models.js --providers dml,cpu
 *   node scripts/bench-models.js --only remacri,span2 --limit 5 --tiles 0,512
 *
 * Провайдеры: `cpu/cuda/tensorrt` — из GPU-пака, `dml/webgpu` — из стокового рантайма
 * npm-модуля. Нативный биндинг в процессе один, поэтому DML идёт отдельным запуском
 * с `MOONAPP_ORT_STOCK=1` (это же значение уважает и приложение).
 *
 * Пачка 16 для TensorRT требует профиля 1..16: движок под него собирается при
 * `MOONAPP_TRT_BATCH_MAX=16` (иначе профиль 1..8 и пачка упирается в 8).
 *
 * Таблицы: `storage/tmp/bench-<провайдер>.md` (для чтения) и `.csv` (для сводки).
 * Строки дописываются на ходу, а измеренные заходы при повторном запуске
 * пропускаются — прогон можно делить на части и продолжать с места остановки.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const engine = require(path.join(ROOT, "server", "upscale.js"));
const FFMPEG = path.join(ROOT, "storage", "ffmpeg", "ffmpeg.exe");
const OUT_DIR = path.join(ROOT, "storage", "tmp");
/** Таблицы по провайдеру: bench-<провайдер>.md и .csv — их сводит bench-merge.js. */
const mdFile = (p) => path.join(OUT_DIR, `bench-${p}.md`);
const csvFile = (p) => path.join(OUT_DIR, `bench-${p}.csv`);
/** Таблицы прошлых прогонов (до разбивки по провайдерам) — учитываем при дозаписи. */
const LEGACY_CSV = [path.join(OUT_DIR, "bench-matrix.csv")];

const argv = process.argv.slice(2);
const val = (name, def = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const nums = (s) =>
  String(s || "")
    .split(",")
    .map((x) => Math.round(Number(x)))
    .filter((x) => Number.isFinite(x));

const PROVIDERS = val("providers", val("provider", "tensorrt"))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TILES = nums(val("tiles", "0"));
const BATCHES = nums(val("batches", "1,2,4,8,16"));
const W = Number(val("w", "848"));
const H = Number(val("h", "480"));
// Кадров должно хватать на самую большую пачку: пачка держит в памяти полные кадры
// результата, поэтому размер захода дополнительно проверяем бюджетом (--ram).
const FRAMES = Number(val("frames", "16"));
// Потолок прогрева: дольше — модель тяжёлая, по ней дальше не идём (это защита от
// «часового» прогона, а не оценка времени).
const MAX_MS = Number(val("maxms", "30000"));
/** Бюджет памяти одного захода, МБ: вход, выход пачки и float32-окно тайла на кадр. */
const RAM_MB = Number(val("ram", "1500")) || 1500;
/** Повторов измерения: 1 — второй заход (после прогрева) идёт в таблицу. */
const REPEAT = Math.max(1, Number(val("repeat", "1")) || 1);
const ONLY = val("only")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SKIP = val("skip")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LIMIT = Number(val("limit", "0")) || 0;

/** Кадры клипа как rawvideo rgb24 (тот же путь, каким их видит конвейер). */
function decodeFrames(clip) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      FFMPEG,
      ["-hide_banner", "-i", clip, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks = [];
    let err = "";
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.slice(-200))),
    );
    p.on("error", reject);
  });
}

/** Тестовый клип: цветной тест-паттерн, 12 кадров, 24 fps. */
function mkClip(clip) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      FFMPEG,
      [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${W}x${H}:rate=24`,
        "-frames:v",
        "12",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        clip,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-200)))));
    p.on("error", reject);
  });
}

/**
 * Уже измеренные заходы: ключ «провайдер|модель|профиль|пачка».
 *
 * Именно это делает прогон прерываемым: после остановки повторный запуск
 * продолжает с места обрыва, а не считает всё заново.
 */
function doneSet() {
  const done = new Set();
  const files = [...LEGACY_CSV, ...PROVIDERS.map(csvFile)];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").trim().split(/\r?\n/).slice(1)) {
      const c = line.split(",");
      if (c.length < 6) continue;
      done.add(`${c[3]}|${c[0]}|${c[4]}|${c[5]}`);
    }
  }
  return done;
}

/**
 * Оценка памяти захода, МБ: кадры очереди (RGB), результат пачки (RGB) и окно
 * float32 на вход/выход тайла на каждый кадр (24 байта на пиксель тайла).
 *
 * Нужна, чтобы пачки 8/16 на больших кадрах не превращались в своп: такой заход
 * честнее пометить пропуском, чем мерить минутами и грузить машину.
 */
function memEstimate(o) {
  const inMb = (W * H * 3 * o.n) / 1048576;
  const outMb = (W * o.scale * H * o.scale * 3 * o.n) / 1048576;
  const winPx = o.prof > 0 ? o.prof * o.prof : W * H;
  const winMb = (winPx * 24 * o.n) / 1048576;
  return inMb + outMb + winMb;
}

/** Строка таблицы (markdown и csv): числа для замера, заметка — для пропуска/ошибки. */
function record(md, csv, o) {
  fs.appendFileSync(
    md,
    `| ${o.label} | ×${o.scale} | ${o.provider} | ${o.prof} | ${o.n} | ${o.ms} | ${o.fps} | ${o.note} |\n`,
    "utf8",
  );
  if (csv && o.ms !== "—") {
    fs.appendFileSync(
      csv,
      `${o.id},"${o.label}",${o.scale},${o.provider},${o.prof},${o.n},${o.ms},${o.fps},${o.tiles}\n`,
      "utf8",
    );
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const clip = path.join(OUT_DIR, "bench", `clip-${W}x${H}-24.mp4`);
  fs.mkdirSync(path.dirname(clip), { recursive: true });
  if (!fs.existsSync(clip)) await mkClip(clip);

  const raw = await decodeFrames(clip);
  const fb = W * H * 3;
  const have = Math.floor(raw.length / fb);
  const frames = [];
  for (let i = 0; i < Math.min(FRAMES, have); i++) frames.push(raw.subarray(i * fb, (i + 1) * fb));

  let list = engine.listModels().filter((m) => m.kind === "upscale" && m.available);
  if (ONLY.length) list = list.filter((m) => ONLY.includes(m.id));
  if (SKIP.length) list = list.filter((m) => !SKIP.includes(m.id));
  if (LIMIT > 0) list = list.slice(0, LIMIT);

  const avail = new Set(engine.supportedBackends());
  const stock = !!engine.ortStockForced?.();
  console.log(
    `Клип ${W}×${H}, кадров ${frames.length}; пачки ${BATCHES.join("/")}; ` +
      `тайлы ${TILES.map((t) => (t === 0 ? "каталожный" : t)).join("/")}`,
  );
  console.log(
    `Рантайм: ${stock ? "стоковый npm-модуль" : "пак/по умолчанию"}; провайдеры: ${
      [...avail].join(", ") || "—"
    }`,
  );

  const done = doneSet();
  for (const provider of PROVIDERS) {
    if (!avail.has(provider)) {
      const hint =
        provider === "dml" || provider === "webgpu"
          ? " — нужен стоковый рантайм: MOONAPP_ORT_STOCK=1"
          : "";
      console.log(`\n${provider}: провайдера нет в этом рантайме${hint}`);
      continue;
    }
    const md = mdFile(provider);
    const csv = csvFile(provider);
    if (!fs.existsSync(md)) {
      fs.writeFileSync(
        md,
        `# Замер моделей (${provider}, ${W}×${H})\n\n` +
          "| модель | × | провайдер | тайл | пачка | мс/кадр | fps | заметка |\n" +
          "| --- | --- | --- | --- | --- | --- | --- | --- |\n",
        "utf8",
      );
    }
    if (!fs.existsSync(csv)) {
      fs.writeFileSync(csv, "model,label,scale,provider,tile,batch,msPerFrame,fps,tiles\n", "utf8");
    }

    // Очередь заходов: модель × профиль × пачка, без уже измеренных.
    const todo = [];
    for (const m of list) {
      let warned = false;
      for (const tile of TILES) {
        const prof = engine.trtProfileSize({ id: m.id, tile: m.rec?.tile || 0 }, tile);
        for (const batch of BATCHES) {
          // Граф модели не умеет пачку — мерим её только пачкой 1.
          if (m.batch === 1 && batch > 1) {
            if (!warned) {
              console.log(`  ${m.id}: граф не принимает пачку — замер только пачкой 1`);
              warned = true;
            }
            continue;
          }
          const n = Math.max(1, Math.min(batch, frames.length, m.batch === 1 ? 1 : 64));
          if (done.has(`${provider}|${m.id}|${prof}|${n}`)) continue;
          // Пачка шире профиля TensorRT: движок надо пересобрать (см. relaunchEnv).
          const off =
            provider === "tensorrt" && n > engine.TRT_BATCH_MAX
              ? `профиль 1..${engine.TRT_BATCH_MAX} (нужен MOONAPP_TRT_BATCH_MAX=${n})`
              : "";
          todo.push({ m, tile, prof, n, off });
        }
      }
    }
    console.log(`\n=== ${provider}: моделей ${list.length}, заходов к замеру ${todo.length} ===`);

    const heavy = new Map();
    let i = 0;
    const t0 = Date.now();
    for (const job of todo) {
      const { m, tile, prof, n } = job;
      i++;
      const scale = m.scale || 4;
      const row = {
        id: m.id,
        label: m.label,
        scale,
        provider,
        prof: prof,
        n,
        ms: "—",
        fps: "—",
        tiles: 0,
        note: "",
      };
      if (job.off) {
        console.log(`[${i}/${todo.length}] ${m.id} · пачка ${n}: пропуск — ${job.off}`);
        record(md, csv, { ...row, note: `пропуск: ${job.off}` });
        continue;
      }
      if (heavy.has(m.id)) {
        record(md, csv, { ...row, note: `пропуск: прогрев ${heavy.get(m.id)} мс` });
        continue;
      }
      const mb = memEstimate({ n, scale, prof });
      if (mb > RAM_MB) {
        console.log(
          `[${i}/${todo.length}] ${m.id} ×${scale} · пачка ${n}: пропуск, ~${mb.toFixed(0)} МБ > ${RAM_MB} МБ`,
        );
        record(md, csv, { ...row, note: `пропуск: ~${mb.toFixed(0)} МБ > ${RAM_MB} МБ` });
        continue;
      }
      const left = i > 1 ? ((Date.now() - t0) / (i - 1)) * (todo.length - i + 1) : 0;
      const eta = left > 60_000 ? `, осталось ~${Math.round(left / 60_000)} мин` : "";
      const p = { model: m.id, tile, overlap: 16, threads: 0, provider };
      try {
        const run = async () =>
          n >= 2
            ? engine.upscaleRgbBatch({ frames: frames.slice(0, n), w: W, h: H, p })
            : engine.upscaleRgb({ src: frames[0], w: W, h: H, p });
        const w0 = Date.now();
        await run(); // прогрев: движок собирается/грузится, кэши греются
        const warmMs = Date.now() - w0;
        const times = [];
        for (let r = 0; r < REPEAT; r++) {
          const t1 = Date.now();
          await run();
          times.push(Date.now() - t1);
        }
        const ms = times.reduce((a, b) => a + b, 0) / times.length;
        const per = ms / n;
        const fps = 1000 / per;
        const tiles = engine.tileRects(W, H, prof, 16).length;
        console.log(
          `[${i}/${todo.length}] ${m.id} ×${scale} · тайл ${prof} · пачка ${n}: ` +
            `${per.toFixed(1)} мс/кадр = ${fps.toFixed(1)} fps ` +
            `(прогрев ${warmMs} мс, тайлов ${tiles}${eta})`,
        );
        record(md, csv, {
          ...row,
          ms: per.toFixed(1),
          fps: fps.toFixed(1),
          tiles,
          note: "",
        });
        if (warmMs > MAX_MS) {
          console.log(`   прогрев ${warmMs} мс — модель тяжёлая, остальные пачки пропускаю`);
          heavy.set(m.id, warmMs);
        }
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 140);
        console.log(`[${i}/${todo.length}] ${m.id} · пачка ${n}: ОШИБКА ${msg}`);
        record(md, csv, { ...row, note: `ошибка: ${msg}` });
      }
    }
  }

  engine.clearSessions();
  console.log(
    "\nТаблицы: storage/tmp/bench-<провайдер>.md и .csv (заходы дописываются, повторный\n" +
      "запуск пропускает измеренное). Сводка: node storage/tmp/bench-merge.js",
  );
  process.exit(0);
}

/**
 * Особые рантаймы для замера.
 *
 * DML/WebGPU есть только в стоковом npm-модуле, а биндинг пака занимает процесс
 * целиком, поэтому себя перезапускаем с `MOONAPP_ORT_STOCK=1`. Пачка больше
 * профиля TensorRT (по умолчанию 1..8) требует пересборки движка — для этого
 * выставляем `MOONAPP_TRT_BATCH_MAX`.
 */
function relaunchEnv() {
  const env = {};
  const needsStock = PROVIDERS.some((p) => p === "dml" || p === "webgpu");
  if (needsStock && !process.env.MOONAPP_ORT_STOCK && !process.env.MOONAPP_BENCH_RELAUNCH) {
    env.MOONAPP_ORT_STOCK = "1";
    console.log("DML/WebGPU: перезапуск со стоковым рантаймом (MOONAPP_ORT_STOCK=1)");
  }
  const maxBatch = Math.max(...BATCHES, 1);
  const trtMax = Math.round(Number(process.env.MOONAPP_TRT_BATCH_MAX) || 0) || 8;
  if (PROVIDERS.includes("tensorrt") && maxBatch > trtMax) {
    env.MOONAPP_TRT_BATCH_MAX = String(maxBatch);
    console.log(`TensorRT: профиль расширяется до 1..${maxBatch} (движок соберётся заново)`);
  }
  return env;
}

const RELAUNCH = relaunchEnv();
if (Object.keys(RELAUNCH).length) {
  const child = spawn(process.execPath, [__filename, ...argv], {
    stdio: "inherit",
    env: { ...process.env, ...RELAUNCH, MOONAPP_BENCH_RELAUNCH: "1" },
  });
  child.on("close", (code) => process.exit(code || 0));
} else {
  main().catch((e) => {
    console.error(`ОШИБКА: ${e.message}`);
    process.exit(1);
  });
}

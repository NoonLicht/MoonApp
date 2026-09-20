"use strict";

/**
 * Проверка ONNX-модели настоящим рантаймом: скачивание, sha256, форма входов,
 * реальный инференс через движок (server/ts/upscale.ts) и запись измеренных фактов
 * в манифест.
 *
 * Зачем: описание модели («×4», «RGB», «25 МБ») легко ошибочно, а ошибка вскроется
 * посреди длинного задания. Этот скрипт говорит, что модель делает НА САМОМ ДЕЛЕ:
 *   - настоящий множитель (у экспортов бывает padding и «×4», который на деле ×2);
 *   - раскладку каналов (если модель ждёт BGR, каналы «съезжают» — видно по средним);
 *   - работает ли произвольный размер входа (у части экспортов вход фиксированный);
 *   - время инференса и сколько занимает файл.
 *
 * Использование:
 *   node scripts/verify-model.js rife-v49                  # по иду из манифеста
 *   node scripts/verify-model.js --url https://…/x.onnx --id new-model
 *   node scripts/verify-model.js --all                    # все модели с ссылкой
 *   node scripts/verify-model.js rife-v49 --update-manifest
 *
 * Ключ --update-manifest перезаписывает в server/models.manifest.json измеренные
 * поля (sizeMb, sha256, scale, bgr, _measured): манифест остаётся честным.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
// Каталог берём тем же резолвером, что сервер: если пользователь обновил
// каталог кнопкой в приложении (манифест лёг в storage), скрипт видит его же.
const { manifestFile, storageDir } = require("./manifest");
const MANIFEST = manifestFile();
const storage = storageDir();
const outDir = path.join(storage, "models", "upscale");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : "";
};
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1].startsWith("--")),
);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const byId = new Map(manifest.models.map((m) => [m.id, m]));

/** Синтетическая картинка: каналы разной яркости — по ним видно подмену RGB/BGR. */
function makeImage(w, h) {
  const img = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      img[i] = 200 + Math.round((x / Math.max(1, w - 1)) * 40); // R ≈ 200…240
      img[i + 1] = 110 + Math.round((y / Math.max(1, h - 1)) * 30); // G ≈ 110…140
      img[i + 2] = ((x + y) % 2) * 40; // B ≈ 20 (шахматка)
    }
  }
  return img;
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const chan = (data, c) => {
  const out = [];
  for (let i = c; i < data.length; i += 3) out.push(data[i]);
  return Math.round(mean(out));
};
const human = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

async function download(url, file) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download_http_${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);
  const body = res.body;
  if (!body) throw new Error("no_body");
  const part = `${file}.part`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(part);
  let got = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (total && got % (8 * 1048576) < value.length)
      process.stdout.write(`  … ${Math.round((got / total) * 100)}%\r`);
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once("drain", () => r()));
  }
  await new Promise((r) => out.end(() => r()));
  // Ссылка может вести на zip (так раздаёт Qualcomm): распаковываем весь архив
  // рядом с моделью — граф кладём под именем из каталога, веса рядом с ним.
  // sha256 для таких моделей — хеш самого архива (его и сверяет приложение).
  if (/\.zip($|[?#])/i.test(url)) {
    const engine = require(path.join(ROOT, "server", "upscale.js"));
    const raw = fs.readFileSync(part);
    const sha = crypto.createHash("sha256").update(raw).digest("hex");
    const entries = engine.extractZipEntries(raw);
    fs.rmSync(part, { force: true });
    let bytes = 0;
    for (const e of entries) {
      const name = /\.onnx$/i.test(e.name) ? path.basename(file) : e.name;
      fs.writeFileSync(path.join(path.dirname(file), name), e.data);
      bytes += e.data.length;
    }
    return { bytes, sha };
  }
  fs.renameSync(part, file);
  return {
    bytes: got,
    sha: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  };
}

/** Проверка одной модели: возвращает измеренные факты (или ошибку). */
async function verify(m) {
  const ort = require("onnxruntime-node");
  const engine = require(path.join(ROOT, "server", "upscale.js"));
  const file = path.join(outDir, m.file);
  let bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let sha = "";
  if (!bytes) {
    if (!m.url) return { id: m.id, error: "нет url и файла на диске" };
    const d = await download(m.url, file);
    bytes = d.bytes;
    sha = d.sha;
  } else if (!/\.zip($|[?#])/i.test(m.url || "")) {
    sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  // У архивной модели в манифесте хеш архива, а на диске граф: сверить нельзя.
  const shaOk = !m.sha256 || !sha ? null : sha === m.sha256;

  const t0 = Date.now();
  const sess = await ort.InferenceSession.create(file);
  const loadMs = Date.now() - t0;
  const names = sess.inputNames.join(",");

  if (m.kind === "interp" || /img0|frame0/i.test(names)) {
    const W = 64;
    const H = 64;
    const t1 = Date.now();
    const ready = { session: sess, provider: "cpu", bgr: false, scale: 1 };
    const mid = await engine.interpolatePair({
      prev: makeImage(W, H),
      cur: makeImage(W, H),
      w: W,
      h: H,
      p: { interpModel: m.id, tile: 0, overlap: 8, threads: 0, provider: "cpu" },
      model: m,
      sig: m.inputSig || "rife-pair-timestep",
      ts: [0.5],
      deps: { ort, ready },
    });
    // Проба пачки тайлов: у наших экспортов ось batch фиксирована (dynamic_axes
    // только по h/w), поэтому пачка невозможна — это факт каталога (`batch: 1`).
    let batch = 0;
    try {
      await engine.interpolatePair({
        prev: makeImage(W, H),
        cur: makeImage(W, H),
        w: W,
        h: H,
        p: { interpModel: m.id, tile: 0, overlap: 8, threads: 0, provider: "cpu" },
        model: m,
        sig: m.inputSig || "rife-pair-timestep",
        ts: [0.5],
        tileBatch: 2,
        deps: { ort, ready },
      });
      batch = 2;
    } catch (e) {
      if (/Expected: ?1|index: 0/i.test(String(e.message || ""))) batch = 1;
    }
    return {
      id: m.id,
      kind: "interp",
      bytes,
      sha,
      shaOk,
      t0,
      inputs: names,
      out: `${mid[0].length} байт/кадр (${W}x${H})`,
      ms: Date.now() - t1,
      loadMs,
      batch,
    };
  }

  // Проба размерами: у части экспортов вход фиксированный (например 128×128).
  const sizes = [];
  let dims = [];
  let size = 0;
  let scale = 0;
  for (const S of [64, 128, 256, 512]) {
    try {
      const probe = new ort.Tensor("float32", new Float32Array(3 * S * S), [1, 3, S, S]);
      const po = (await sess.run({ [sess.inputNames[0]]: probe }))[sess.outputNames[0]];
      dims = (po.dims || []).map(Number);
      scale = dims.length === 4 ? dims[3] / S : 0;
      size = S;
      sizes.push(String(S));
      break;
    } catch (e) {
      sizes.push(`!${S}`);
      if (/Expected:/i.test(String(e.message || ""))) break;
    }
  }
  if (!size) {
    return { id: m.id, kind: "upscale", bytes, sha, shaOk, inputs: names, fixed: sizes.join(",") };
  }
  const intScale = Number.isInteger(scale) && scale > 0 ? scale : 0;
  const img = makeImage(size, size);
  const p = { model: m.id, tile: 0, overlap: 8, threads: 0, provider: "cpu" };
  const chans = {};
  const t1 = Date.now();
  for (const bgr of [false, true]) {
    const r = await engine.upscaleRgb({
      src: img,
      w: size,
      h: size,
      p,
      deps: { ort, ready: { session: sess, provider: "cpu", bgr, scale: intScale || 4 }, model: m },
    });
    chans[bgr ? "bgr" : "rgb"] = [0, 1, 2].map((c) => chan(r.data, c));
  }
  const src = [0, 1, 2].map((c) => chan(img, c));
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const bgr = dist(chans.bgr, [...src].reverse()) < dist(chans.rgb, src);
  // Проба пачки: принимает ли граф два кадра за один run. Real-ESRGAN-экспорты
  // отвечают «index: 0 Got: 2 Expected: 1» — тогда пачка невозможна, и движок по
  // этому факту не копит очередь (иначе GPU простаивал бы между «залпами»).
  let batch = 0;
  try {
    await engine.upscaleRgbBatch({
      frames: [img, img],
      w: size,
      h: size,
      p,
      deps: { ort, ready: { session: sess, provider: "cpu", bgr, scale: intScale || 4 }, model: m },
    });
    batch = 2;
  } catch (e) {
    if (/Expected: ?1|index: 0/i.test(String(e.message || ""))) batch = 1;
  }
  // Проба выравнивания: некоторые графы (Real-CUGAN: внутри UNet1 есть
  // down/up-семплинг) принимают только кратные стороны. Проверяем размер, не
  // кратный двум и четырём: движок затем добирает тайл и обрезает результат.
  let align = 0;
  if (!(size % 4)) {
    for (const odd of [size + 2, size + 1]) {
      try {
        const probe = new ort.Tensor("float32", new Float32Array(3 * odd * odd), [1, 3, odd, odd]);
        await sess.run({ [sess.inputNames[0]]: probe });
      } catch {
        align = odd === size + 2 ? 4 : 2;
        break;
      }
    }
  }
  return {
    id: m.id,
    kind: "upscale",
    bytes,
    sha,
    shaOk,
    inputs: names,
    sizes: sizes.join("/"),
    size,
    dims: dims.join("x"),
    scale: intScale,
    rawScale: scale,
    bgr,
    align,
    channels: `вход ${src.join("/")} → rgb ${chans.rgb.join("/")} | bgr ${chans.bgr.join("/")}`,
    ms: Date.now() - t1,
    loadMs,
    batch,
  };
}

/** Отчёт по одной модели: то, что нужно человеку, и то, что пишем в манифест. */
function report(r) {
  if (r.error) return `✗ ${r.id}: ${r.error}`;
  const lines = [
    `${r.id}: ${human(r.bytes)}, ${r.sha ? `sha256=${r.sha.slice(0, 16)}…` : "модель из архива"} (${r.kind})`,
  ];
  if (r.shaOk === false) lines.push("  ✗ sha256 не совпал с манифестом!");
  if (r.shaOk === true) lines.push("  ✓ sha256 совпал с манифестом");
  lines.push(`  входы: ${r.inputs}`);
  if (r.kind === "interp") {
    lines.push(`  выход: ${r.out}, инференс ${r.ms} мс (загрузка ${r.loadMs} мс)`);
  } else if (r.fixed) {
    lines.push(`  ✗ фиксированный вход (${r.fixed}) — с тайлингом не использовать`);
  } else {
    lines.push(
      `  проба ${r.sizes}: выход ${r.dims} ⇒ ×${r.rawScale.toFixed(3)}` +
        (r.scale ? "" : " (неровно — внутри графа padding)"),
    );
    lines.push(`  ${r.channels} ⇒ ${r.bgr ? "нужен BGR" : "RGB"}, инференс ${r.ms} мс`);
  }
  if (r.batch === 1) {
    lines.push("  пачка: НЕ поддерживается (граф ждёт ровно один вход) → в каталог пишем batch: 1");
  } else if (r.batch > 1) {
    lines.push("  пачка: поддерживается (динамическая ось)");
  }
  if (r.align > 1) {
    lines.push(
      `  выравнивание: нужны кратные ${r.align} стороны → в каталог пишем align: ${r.align}`,
    );
  }
  return lines.join("\n");
}

/** Что записать в манифест после проверки (только измеренные факты). */
function measuredPatch(r) {
  if (r.error || r.fixed) return null;
  const patch = { sizeMb: Math.max(1, Math.round(r.bytes / 1048576)) };
  // Хеш архивной модели посчитать из файла на диске нельзя — не трогаем его.
  if (r.sha) patch.sha256 = r.sha;
  // Факт о пачке пишем только когда она НЕВОЗМОЖНА (`batch: 1`): по нему движок
  // не копит очередь. Успешную пробу не записываем — иначе пачка навсегда
  // осталась бы равной двум, хотя ось динамическая.
  if (r.batch === 1) patch.batch = 1;
  // Кратность сторон: пишем только когда граф её требует (align ≥ 2) — по этому
  // факту движок добирает тайл и обрезает результат при вклейке.
  if (r.align > 1) patch.align = r.align;
  if (r.kind === "interp") {
    patch._measured = `${r.ms} мс на пару 64×64, входы ${r.inputs}, выход ${r.out}`;
  } else {
    if (r.scale) patch.scale = r.scale;
    patch.bgr = r.bgr;
    patch._measured = `${r.ms} мс на ${r.size}px, входы ${r.inputs}, выход ${r.dims} ⇒ ×${r.rawScale.toFixed(3)}, ${r.channels}`;
  }
  return patch;
}

(async () => {
  const url = opt("url");
  const id = opt("id");
  const targets = [];
  if (flag("all")) targets.push(...manifest.models.filter((m) => m.url));
  else if (positional.length) targets.push(...positional.map((p) => byId.get(p)).filter(Boolean));
  else if (url) {
    const guessed = id || path.basename(url).replace(/\.onnx$/i, "");
    targets.push(
      byId.get(guessed) || {
        id: guessed,
        label: guessed,
        kind: "upscale",
        scale: 4,
        file: path.basename(url),
        sizeMb: 0,
        license: "",
        tile: 256,
        overlap: 16,
        url,
        sha256: "",
      },
    );
  }
  if (!targets.length) {
    console.log(
      "Кого проверять: node scripts/verify-model.js <ид…> | --url <URL> [--id <ид>] | --all",
    );
    console.log(
      `В каталоге: ${manifest.models.length} моделей, с ссылкой: ${manifest.models.filter((m) => m.url).length}`,
    );
    return;
  }

  const results = [];
  for (const m of targets) {
    if (url && m.url !== url) m.url = url;
    process.stdout.write(`— ${m.id}: ${m.url ? "качаю" : "файл на диске"}\n`);
    try {
      const r = await verify(m);
      results.push(r);
      console.log(report(r));
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      results.push({ id: m.id, error: msg });
      console.log(`✗ ${m.id}: ${msg}`);
    }
  }

  if (flag("update-manifest")) {
    let changed = 0;
    for (const r of results) {
      const patch = measuredPatch(r);
      if (!patch) continue;
      let entry = byId.get(r.id);
      if (entry && typeof entry.align === "number" && patch.align && entry.align > patch.align) {
        // Проба идёт на CPU, а требование может быть жёстче на GPU (DirectML
        // у Real-CUGAN 3x требует кратности четырём): не понижаем факт каталога.
        delete patch.align;
      }
      if (!entry) {
        // Модели ещё нет в каталоге (проверяли ссылку «с нуля») — заводим
        // запись: каталог наполняется тем же прогоном, что и проверяет файл.
        const t = targets.find((x) => x.id === r.id) || {};
        entry = {
          id: r.id,
          label: String(t.label || r.id),
          kind: r.kind === "interp" ? "interp" : "upscale",
          scale: Number(t.scale) || 4,
          arch: String(t.arch || ""),
          file: String(t.file || `${r.id}.onnx`),
          sizeMb: patch.sizeMb,
          license: String(t.license || ""),
          url: String(t.url || ""),
          sha256: patch.sha256 || "",
          tags: Array.isArray(t.tags) ? t.tags : [],
        };
        if (r.kind === "interp") entry.mult = Number(t.mult) || 2;
        manifest.models.push(entry);
        byId.set(entry.id, entry);
      }
      Object.assign(entry, patch);
      changed++;
    }
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(`\nманифест обновлён: ${changed} записей (${MANIFEST})`);
  }
})();

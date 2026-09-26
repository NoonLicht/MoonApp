import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { readUpscaleSrc } from "./helpers/readUpscaleSrc";

/**
 * Контракт страницы «Апскейл» в стиле страницы сжатия видео + зависимости
 * настроек от типа медиа.
 *
 * Проверяем то, что ломалось по-настоящему:
 * 1) раскладка — левая колонка (исходник/результат) и ОДНА карточка настроек,
 *    которая прокручивается сама (развёрнутые Pro-настройки не уезжают за экран);
 * 2) предпросмотр видео — <video> в плеере, а не <img>: тип медиа определяется по
 *    расширению файла, не дожидаясь ответа /probe;
 * 3) все настройки зависят от типа медиа: у фото нет кодека/звука/кадров;
 * 4) кнопка запуска одна;
 * 5) у новых ключей i18n есть перевод во всех локалях.
 */
const req = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..");
const read = (p: string) =>
  p === "server/ts/upscale.ts" ? readUpscaleSrc(root) : fs.readFileSync(path.join(root, p), "utf8");

const page = read("src/pages/upscale/UpscalePage.tsx");
const dashboard = read("src/pages/upscale/parts/UpscaleDashboard.tsx");
const proSettings = read("src/pages/upscale/parts/UpscaleProSettings.tsx");
const css = read("src/styles/upscale.css");
const LANG_CODES = ["en", "ru", "es", "fr", "zh", "ar"];

let engine: any;
let pipe: any;
beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-upscale-ui2-"));
  engine = req("../server/upscale");
  pipe = req("../server/upscalePipeline");
});

describe("апскейл: раскладка как на странице сжатия видео", () => {
  it("левая колонка и одна прокручиваемая карточка настроек", () => {
    expect(page).toContain('className="page up-page"');
    expect(page).toContain('className="up-grid"');
    expect(page).toContain('className="up-left"');
    expect(page).toContain('className="up-right"');
    // Настройки живут в единственной карточке (как .cmp-card.cmp-fill), но, в
    // отличие от сжатия, страница апскейла скроллится целиком — колонки не
    // зажаты в высоту окна, окно предпросмотра иначе показывало картинку не
    // целиком, урезая её собственным скроллом.
    expect(page).toMatch(/<Glass className="up-card up-fill"/);
    expect(page.match(/<UpscaleDashboard/g) ?? []).toHaveLength(1);
    expect(css).toMatch(/\.up-page\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).not.toMatch(/\.up-fill\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).not.toMatch(/\.up-right\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).not.toMatch(/\.up-left\s*\{[^}]*overflow-y:\s*auto/s);
  });

  it("Pro-настройки разворачиваются внутри той же карточки, а не в модалке", () => {
    expect(dashboard).toMatch(/mode === "pro" \? \(\s*<UpscaleProSettings/);
    expect(proSettings).not.toContain("modal-overlay");
    expect(proSettings).toContain('className="up-pro-inline"');
    // Переключатель режима — бейджи Express/Pro, как у сжатия.
    expect(dashboard).toContain('t("up.express")');
    expect(dashboard).toContain('onMode("pro")');
  });

  it("пресеты, прогресс и оценка живут в карточке настроек", () => {
    expect(dashboard).toContain('className="up-row-inline"');
    expect(dashboard).toContain('t("up.presets")');
    expect(dashboard).toContain("<ProgressBar value={job.progress} />");
    expect(dashboard).toContain("estimate.outWidth");
  });

  it("кнопка запуска одна — в карточке настроек, результат скачивают слева", () => {
    expect(dashboard.match(/t\("up\.start"\)/g) ?? []).toHaveLength(1);
    expect(dashboard).not.toContain('t("up.empty")');
    expect(page).not.toMatch(/t\("up\.start"\)/);
    expect(page).toContain('t("up.download")');
  });
});

describe("апскейл: предпросмотр видео и картинки", () => {
  it("тип медиа берётся из имени файла, а не только из пробы", () => {
    expect(read("src/pages/upscale/parts/fileKind.ts")).toContain("export function fileKind");
    expect(page).toMatch(/probe\?\.kind \|\| \(file \? fileKind\(file\.name\) : "photo"\)/);
  });

  it("видео показывается плеером, картинка — изображением", () => {
    expect(page).toMatch(/isVideo \? \(\s*<div className="up-player-wrap">/);
    expect(page).toContain("<video");
    expect(page).toContain('className="up-preview"');
    expect(css).toMatch(/\.up-player-wrap video\s*\{[^}]*max-height/s);
    // Плеер не «прыгает»: пропорции кадра берутся из пробы через --up-ar.
    expect(page).toContain('["--up-ar" as string]: aspect');
  });

  it("fileKind различает картинки и видео по расширению", async () => {
    const mod = await import("@/pages/upscale/parts/fileKind");
    expect(mod.fileKind("clip.mp4")).toBe("video");
    expect(mod.fileKind("movie.MKV")).toBe("video");
    expect(mod.fileKind("photo.PNG")).toBe("photo");
    expect(mod.fileKind("scan.jpeg")).toBe("photo");
    expect(mod.fileKind("noext")).toBe("video");
  });
});

describe("апскейл: настройки зависят от типа медиа", () => {
  it("быстрые поля: у видео — кодек/звук/плавность/замедление, у фото — формат/качество/резкость", () => {
    const videoBranch = dashboard.slice(dashboard.indexOf("{isVideo ? ("));
    for (const key of ["up.smooth", "up.vcodec", "up.vcrf", "up.audio", "up.slowMotion"]) {
      expect(videoBranch.slice(0, 4000), key).toContain(`t("${key}")`);
    }
    const photoBranch = dashboard.slice(dashboard.indexOf('t("up.format")'));
    for (const key of ["up.format", "up.quality", "up.sharpen"]) {
      expect(photoBranch, key).toContain(`t("${key}")`);
    }
  });

  it("в Pro-панели видео-секции скрыты для фото, а фото-секция — для видео", () => {
    expect(proSettings).toContain('const isVideo = kind === "video"');
    // Формат/качество — только фото:
    expect(proSettings).toMatch(/\{!isVideo \? \(\s*<>\s*<Row label=\{t\("up\.format"\)/);
    // Кодек, плавность и производительность — только видео:
    expect(proSettings).toMatch(/\{isVideo \? \(\s*<>\s*<div className="up-pro-section">/);
    const videoOpen = proSettings.indexOf("{isVideo ? (");
    for (const key of [
      "up.sectionVideo",
      "up.sectionInterp",
      "up.sectionVideoPerf",
      "up.slowMotion",
    ]) {
      const at = proSettings.indexOf(`t("${key}")`);
      expect(at, key).toBeGreaterThan(0);
      // Все они лежат ПОСЛЕ открытия видео-ветки.
      expect(at, key).toBeGreaterThan(videoOpen);
    }
  });

  it("каталог моделей фильтруется по типу медиа (интерполяторы — только для видео)", () => {
    // Каталог переехал в отдельную панель: там фильтр по категориям (tags),
    // а в Pro-панели осталась короткая сводка со входом в каталог.
    const panel = read("src/pages/upscale/parts/UpscaleModelsPanel.tsx");
    expect(panel).toContain("const TAG_ORDER");
    // Фильтр по категориям теперь один общий (теги + кратность + состояние),
    // поэтому проверяем именно тег внутри него.
    expect(panel).toMatch(/if \(tag && !m\.tags\.includes\(tag\)\) return false;/);
    expect(panel).toContain('t("up.mdlOpen")'.replace("mdlOpen", "mdlAll"));
    expect(proSettings).toContain('t("up.mdlOpen")');
    expect(proSettings).toContain("onOpenModels");
    // Модель апскейла и интерполятор не смешиваются в списках полей.
    expect(dashboard).toMatch(/models\.filter\(\(m\) => m\.kind !== "interp"\)/);
  });

  it("панель моделей умеет скачать, удалить и применить оптимальные настройки", () => {
    const panel = read("src/pages/upscale/parts/UpscaleModelsPanel.tsx");
    for (const key of ["up.downloadModel", "up.mdlApply", "up.mdlRedownload"]) {
      expect(panel, key).toContain(`t("${key}")`);
    }
    expect(panel).toContain('t("up.mdlProgress"');
    expect(panel).toContain("<ProgressBar value={dl.percent} />");
    expect(panel).toContain('e.key === "Escape"');
    // Ошибки бэкенда переводятся, а не показываются кодом.
    expect(panel).toContain("up.mdlErr_");
    // Страница прокидывает обработчики и применяет rec модели в параметры.
    expect(page).toContain("upscaleRemoveModel");
    expect(page).toContain("upscaleRedownloadModel");
    expect(page).toMatch(/const applyModel = \(m: UpModelInfo\)/);
    expect(page).toMatch(/m\.rec\.tile \?\? prev\.tile/);
    expect(page).toMatch(/interpModel: m\.id/);
  });

  it("пресеты фильтруются по типу медиа", () => {
    expect(dashboard).toMatch(/presets\.filter\(\(pr\) => \(pr\.kind \|\| "photo"\) === kind\)/);
    expect(dashboard).toMatch(
      /customPresets\.filter\(\(pr\) => !pr\.kind \|\| pr\.kind === kind\)/,
    );
    expect(dashboard).toContain('t("up.noPresets")');
  });
});

describe("апскейл: новые ручки фазы 3 (пакеты, лимит, замедление)", () => {
  it("движок знает пачки, лимит кадров и множители замедления", () => {
    // Пачка расширена до 128, а значение по умолчанию — «Авто»: движок сам
    // подбирает размер по видеопамяти (для скорости без OOM).
    expect(engine.BATCH_SIZES).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
    expect(engine.AUTO_BATCH).toBe(0);
    expect(engine.SLOW_FACTORS).toEqual([1, 0.5, 0.25]);
    expect(engine.normalizeParams({}).batchFrames).toBe(engine.AUTO_BATCH);
    const p = engine.normalizeParams({ batchFrames: 9, frameLimit: -5, slowMotion: 0.3 });
    expect(p.batchFrames).toBe(0); // 9 не из списка — «Авто»
    expect(p.frameLimit).toBe(0);
    expect(p.slowMotion).toBe(1); // 0.3 не из списка — без замедления
    const q = engine.normalizeParams({ batchFrames: 128, frameLimit: 120, slowMotion: 0.5 });
    expect([q.batchFrames, q.frameLimit, q.slowMotion]).toEqual([128, 120, 0.5]);
  });

  it("«Авто»-пачка считается по видеопамяти, ручная — урезается по памяти", () => {
    // Разбор вывода nvidia-smi: с именем карты и без него (запрос без name).
    expect(engine.parseNvidiaSmi("NVIDIA GeForce RTX 5060 Ti, 8151, 6247")).toEqual({
      totalMb: 8151,
      freeMb: 6247,
    });
    expect(engine.parseNvidiaSmi("8151, 6525\r\n")).toEqual({ totalMb: 8151, freeMb: 6525 });
    // Цифры в имени карты не должны попадать в разбор (берём два последних числа).
    expect(engine.parseNvidiaSmi("NVIDIA GeForce RTX 4060, 8188, 5000")).toEqual({
      totalMb: 8188,
      freeMb: 5000,
    });
    // Несколько карт: берём ту, где свободной памяти больше.
    expect(engine.parseNvidiaSmi("8151, 900\n24564, 18000")).toEqual({
      totalMb: 24564,
      freeMb: 18000,
    });
    expect(engine.parseNvidiaSmi("")).toEqual({ totalMb: 0, freeMb: 0 });

    // Явный RAM-бюджет: так тест не зависит от свободной памяти машины.
    const base = { w: 1920, h: 1080, scale: 4, tile: 256, modelMb: 65, ramBudgetMb: 8192 };
    // Потолок «Авто» — 8: замеры показали, что пачка 8 быстрее пачки 2 на ~12%,
    // а больше профиль TensorRT всё равно не примет (TRT_BATCH_MAX) — на CUDA/CPU
    // ручную пачку по-прежнему можно ставить вплоть до потолка модели.
    expect(engine.AUTO_BATCH_MAX).toBe(8);
    // Запаса памяти хватает — «Авто» берёт потолок.
    expect(engine.autoBatchFrames({ ...base, freeMb: 8000 })).toBe(8);
    // Нет данных о видеокарте (CPU/встроенная графика) — считаем по памяти кадров.
    expect(engine.autoBatchFrames({ ...base, freeMb: 0 })).toBe(8);
    // Кадр целиком (тайла нет) требует много памяти на кадр, но выше потолка не
    // поднимается: при свободной видеопамяти пачка та же, при тесной — не больше.
    const roomy = engine.autoBatchFrames({ ...base, tile: 0, freeMb: 8000 });
    const tight = engine.autoBatchFrames({ ...base, tile: 0, freeMb: 1200 });
    expect(roomy).toBeLessThanOrEqual(engine.AUTO_BATCH_MAX);
    expect(tight).toBeLessThanOrEqual(roomy);
    expect(tight).toBeGreaterThanOrEqual(1);
    // Мало RAM — тоже ограничитель, даже при свободной видеопамяти.
    expect(
      engine.autoBatchFrames({ ...base, tile: 0, freeMb: 8000, ramBudgetMb: 1024 }),
    ).toBeLessThanOrEqual(roomy);
    // Видеопамяти не хватает даже под модель и резерв — считаем по одному кадру.
    expect(engine.autoBatchFrames({ ...base, tile: 0, freeMb: 700 })).toBe(1);
    // Бюджет RAM всегда в разумных пределах, даже если машина загружена.
    expect(engine.ramBudgetMb()).toBeGreaterThanOrEqual(512);
    expect(engine.ramBudgetMb()).toBeLessThanOrEqual(6 * 1024);
  });

  it("ручная пачка уважается, если памяти действительно хватает", () => {
    // Жалоба владельца: при 17 ГБ свободной RAM запрос 32/64 давал 14–16, потому
    // что бюджет был жёстко прописан в 1.5 ГБ. Теперь считаем по фактической
    // памяти машины, поэтому 1080p×4 с запасом пускает 32 и 64 кадра.
    const ram = { ramBudgetMb: 8192, freeMb: 5000, modelMb: 65, tile: 256 };
    expect(engine.batchFramesFor(32, 1920, 1080, 4, ram)).toBe(32);
    expect(engine.batchFramesFor(64, 1920, 1080, 4, ram)).toBe(64);
    // Просят больше, чем влезает в память кадров (99 МБ на кадр при 1080p×4).
    expect(engine.batchFramesFor(128, 1920, 1080, 4, { ...ram, ramBudgetMb: 1024 })).toBeLessThan(
      32,
    );
    // Мало видеопамяти — тоже ограничитель (модель и резерв вычитаются).
    expect(engine.batchFramesFor(64, 1920, 1080, 4, { ...ram, freeMb: 900 })).toBeLessThan(64);
    // 4K×4 — кадр ~400 МБ: пачка 128 не влезет ни при каком разумном бюджете.
    const big = engine.batchFramesFor(128, 3840, 2160, 4, ram);
    expect(big).toBeLessThan(128);
    expect(big).toBeGreaterThan(1);
    // Мелкий кадр — пачка не тронута; 1 кадр остаётся 1 при любом размере.
    expect(engine.batchFramesFor(16, 360, 640, 2, ram)).toBe(16);
    expect(engine.batchFramesFor(1, 3840, 2160, 4, ram)).toBe(1);
  });

  it("множитель плавности ограничен схемой модели: CAIN — только ×2", () => {
    // RIFE и IFRNet принимают момент времени (×2/×3/×4 без каскадов),
    // CAIN интерполирует ровно середину пары — ×3 для него был бы мусором.
    const models = engine.listModels();
    const multOf = (id: string) => engine.interpMultMax(models.find((m: any) => m.id === id));
    expect(multOf("rife-v49")).toBe(4);
    expect(multOf("ifrnet")).toBe(4);
    expect(multOf("cain")).toBe(2);
    expect(engine.interpMultMax(null)).toBe(4);
    expect(engine.MAX_INTERP_MULT).toBe(4);
    // UI знает предел и режет список множителей по нему.
    expect(read("src/pages/upscale/parts/UpscaleProSettings.tsx")).toContain("interpMultMax");
    expect(read("src/pages/upscale/parts/UpscaleProSettings.tsx")).toContain("interpMultModelHint");
  });

  it("«Стоп» гасит ffmpeg сразу и выгружает модели из видеопамяти", () => {
    // Стоп-кран: процессы задания регистрируются в движке и убиваются из cancelJob,
    // а ONNX-сессии выгружаются сразу после остановки — даже если в очереди есть
    // другие файлы (иначе видеопамять оставалась бы занятой до конца пачки).
    const engineSrc = read("server/ts/upscale.ts");
    expect(engineSrc).toContain("const jobProcs = new Map<string, Map<number, TrackedProc>>();");
    expect(engineSrc).toMatch(/export function killJobProcs\(id: string\): number \{/);
    expect(engineSrc).toMatch(/j\.stage = "stopped";[\s\S]{0,200}?killJobProcs\(id\);/);
    expect(engineSrc).toMatch(
      /const stopped = job\.error === "stopped";[\s\S]{0,200}?if \(stopped\) \{\r?\n\s+killJobProcs\(job\.id\);/,
    );
    expect(engineSrc).toMatch(/if \(plannedJobs === 0 \|\| stopped\) clearSessions\(\);/);
    expect(engineSrc).toContain("onProc: (kind, proc) => trackProc(job.id, kind, proc)");
    // Конвейер сообщает о процессах и снимает их с учёта при закрытии.
    const pipeSrc = read("server/ts/upscalePipeline.ts");
    expect(pipeSrc).toContain('opts.onProc?.("decode", dec);');
    expect(pipeSrc).toContain('opts.onProc?.("encode", enc);');
    expect(pipeSrc).toContain('dec.on("close", () => opts.onProc?.("decode", null));');
    expect(pipeSrc).toContain('opts.onProc?.("encode", null);');
    // Неизвестное задание — ничего не убиваем (не падаем).
    expect(engine.killJobProcs("нет-такого-задания")).toBe(0);
  });

  it("без апскейла: кадры идут как есть, модель не запрашивается", () => {
    // Режим «только плавность»: спец-значение модели «none» (см. NO_UPSCALE).
    const p = engine.normalizeParams({ model: "none" });
    expect(p.model).toBe("none");
    expect(engine.isNoUpscale(p.model)).toBe(true);
    expect(engine.NO_UPSCALE).toBe("none");
    // Обычный выбор и пустое поле не превращаются в «без апскейла».
    expect(engine.isNoUpscale(engine.normalizeParams({ model: "rife-v49" }).model)).toBe(false);
    expect(engine.isNoUpscale(engine.normalizeParams({}).model)).toBe(false);

    const engineSrc = read("server/ts/upscale.ts");
    // Пайплайну не передаём покадровую обработку — он возьмёт кадр как есть.
    expect(engineSrc).toContain("processFrame: noUpscale");
    expect(engineSrc).toMatch(/processFrame: noUpscale\s*\n\s*\? undefined/);
    // Пачки без апскейла нет (она существует ради ONNX-заходов), множитель не считаем.
    expect(engineSrc).toMatch(/if \(noUpscale\) \{[\s\S]{0,140}?job\.batchUsed = 0;/);
    expect(engineSrc).toMatch(/const modelScale = noUpscale\s*\n?\s*\? 1/);
    // И оценка времени честно пустая: измеренная скорость апскейла тут не работает.
    expect(engineSrc).toMatch(/const etaSec =\s*\n?\s*!noUpscale && mpxPerSec > 0/);
    // Конвейер: без processFrame кадр уходит в энкодер без обработки.
    expect(read("server/ts/upscalePipeline.ts")).toContain("processFrame?: ProcessFrameFn;");
    expect(read("server/ts/upscalePipeline.ts")).toMatch(
      /const frame: ProcessedFrame = opts\.processFrame\s*\n\s*\? await opts\.processFrame/,
    );
    // UI: пункт в списке моделей и пояснение вместо множителя. Сам список — уже
    // не системный select, а панель UpscaleModelPicker: «без апскейла» передаётся
    // ей подписью noneLabel.
    const dash = read("src/pages/upscale/parts/UpscaleDashboard.tsx");
    expect(dash).toContain("noneLabel={t(\"up.modelNone\")}");
    expect(dash).toContain('const noUpscale = params.model === "none";');
    expect(read("src/pages/upscale/parts/UpscaleProSettings.tsx")).toContain(
      't("up.modelNoneNote")',
    );
  });

  it("оценка без апскейла не ругается на модель и не врёт по времени", () => {
    // estimateUpscale с «none»: ни model_unknown, ни model_missing, etaSec = null.
    const est = engine.estimateUpscale(
      engine.normalizeParams({ model: "none", interpMode: "model", interpMult: 2 }),
      {
        kind: "video",
        width: 1920,
        height: 1080,
        fps: 25,
        fpsNum: 25,
        fpsDen: 1,
        duration: 10,
      },
    );
    expect(est.outWidth).toBe(1920);
    expect(est.outHeight).toBe(1080);
    expect(est.warnings).not.toContain("model_unknown");
    expect(est.warnings).not.toContain("model_missing");
    // Плавность ×2: 250 исходных кадров → 499 (вставка на каждый переход).
    expect(est.outFrames).toBe(499);
    expect(est.fpsOut).toBe(50);
    // Время не оцениваем: измеренная скорость ONNX-апскейла здесь неприменима.
    expect(est.etaSec).toBeNull();
  });

  it("пачка кадров: список в UI и на сервере один, «Авто» первый", () => {
    const root = path.resolve(__dirname, "..");
    const client = fs.readFileSync(
      path.join(root, "src", "pages", "upscale", "parts", "batchSizes.ts"),
      "utf8",
    );
    // UI не должен расходиться с движком: список выписан в двух местах.
    const rawList = /BATCH_SIZES = \[([^\]]+)\]/.exec(client)?.[1] || "";
    const list = rawList.split(",").map((s) => Number(s.trim()));
    expect(list).toEqual(engine.BATCH_SIZES);
    expect(client).toContain("BATCH_AUTO = 0");
    expect(client).toContain("BATCH_CHOICES = [BATCH_AUTO, ...BATCH_SIZES]");
    const pro = fs.readFileSync(
      path.join(root, "src", "pages", "upscale", "parts", "UpscaleProSettings.tsx"),
      "utf8",
    );
    expect(pro).toContain("options={BATCH_CHOICES.map(");
    expect(pro).toContain('label: n === BATCH_AUTO ? t("up.batchAuto")');
    // Значение по умолчанию у страницы — «Авто».
    expect(
      fs.readFileSync(path.join(root, "src", "pages", "upscale", "UpscalePage.tsx"), "utf8"),
    ).toMatch(/batchFrames: 0,/);
  });

  it("лимит кадров уменьшает ожидаемое число кадров и доходит до декодера", () => {
    expect(pipe.frameLimitOrInf(10, 25, 0)).toBe(250);
    expect(pipe.frameLimitOrInf(10, 25, 40)).toBe(40);
    // Лимит больше файла — берём файл.
    expect(pipe.frameLimitOrInf(2, 25, 1000)).toBe(50);
    // Аргументы декодера получают -frames:v только при лимите.
    expect(pipe.buildDecodeArgs("in.mp4", ["fps=25/1"], 0)).not.toContain("-frames:v");
    expect(pipe.buildDecodeArgs("in.mp4", [], 40)).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "in.mp4",
      "-map",
      "0:V:0",
      "-frames:v",
      "40",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ]);
  });

  it("замедление растягивает видео и звук согласованно", () => {
    expect(pipe.slowMotionFilter(1)).toEqual([]);
    expect(pipe.slowMotionFilter(0.5)).toEqual(["setpts=2.0000*PTS"]);
    expect(pipe.slowMotionFilter(0.25)).toEqual(["setpts=4.0000*PTS"]);
    // atempo не принимает 0.25 — нужна цепочка из двух звеньев.
    expect(pipe.slowAudioFilters(1)).toEqual([]);
    expect(pipe.slowAudioFilters(0.5)).toEqual(["atempo=0.5000"]);
    expect(pipe.slowAudioFilters(0.25)).toEqual(["atempo=0.5", "atempo=0.5000"]);
    // Копирование звука при замедлении невозможно: длительность должна меняться.
    const args = pipe.buildEncodeArgs({
      fps: 25,
      outWidth: 640,
      outHeight: 360,
      inputPath: "in.mp4",
      outFile: "out.mp4",
      encoder: "libx264",
      qualityArgs: ["-crf", "20"],
      audioAction: "copy",
      hasSubs: false,
      slowMotion: 0.5,
    });
    expect(args).toContain("-filter:a");
    expect(args).not.toContain("copy");
    expect(args[args.indexOf("-vf") + 1]).toContain("setpts=2.0000*PTS");
  });
});

describe("апскейл: оценка задания (/estimate)", () => {
  const probe = {
    kind: "video",
    width: 1920,
    height: 1080,
    duration: 10,
    fps: 25,
    fpsNum: 25,
    fpsDen: 1,
  };

  it("считает размеры, кадры, частоту и группу предупреждений", () => {
    // Модель с заведомо отсутствующим файлом: предупреждение о ней проверяем без
    // привязки к тому, что уже скачано на этой машине (каталог живой).
    const p = engine.normalizeParams({ model: "photo-span", scale: 2 });
    const e = engine.estimateUpscale(p, probe);
    expect([e.outWidth, e.outHeight]).toEqual([3840, 2160]);
    expect(e.inFrames).toBe(250);
    expect(e.outFrames).toBe(250); // плавность выключена
    expect(e.fpsOut).toBe(25);
    expect(e.totalMegapixels).toBeCloseTo(2074, 0);
    expect(e.warnings).toContain("model_missing");
    // Предупреждения — только из известного набора (ключи up.est_*).
    const known = [
      "model_missing",
      "runtime_missing",
      "too_large",
      "too_slow",
      "model_unknown",
      "interp_model_missing",
      "frame_limit",
    ];
    for (const w of e.warnings) expect(known, w).toContain(w);
    expect(e.etaSec).toBe(null); // заданий ещё не было — оценка честно пустая
  });

  it("учитывает интерполяцию, замедление и лимит кадров", () => {
    const p = engine.normalizeParams({
      scale: 2,
      interpMode: "ffmpeg",
      interpMult: 2,
      slowMotion: 0.5,
      frameLimit: 100,
    });
    const e = engine.estimateUpscale(p, probe);
    expect(e.inFrames).toBe(100);
    expect(e.outFrames).toBe(100); // фильтр ffmpeg вставляет кадры сам
    expect(e.fpsOut).toBe(50);
    expect(e.slowMotion).toBe(0.5);
    // 100 кадров при 50 fps = 2 c, замедление ×2 → 4 c.
    expect(e.durationSec).toBeCloseTo(4, 1);
    expect(e.warnings).toContain("frame_limit");
  });

  it("в режиме модели кадров больше и нужен интерполятор", () => {
    const p = engine.normalizeParams({ interpMode: "model", interpMult: 2, frameLimit: 10 });
    const e = engine.estimateUpscale(p, probe);
    expect(e.outFrames).toBe(19); // (10 − 1) × 2 + 1
    expect(e.fpsOut).toBe(50);
    expect(e.warnings).toContain("interp_model_missing");
  });

  it("для фото кадров нет, а размеры — из множителя", () => {
    const p = engine.normalizeParams({ scale: 4, targetW: 0 });
    const e = engine.estimateUpscale(p, {
      kind: "photo",
      width: 1000,
      height: 500,
      duration: 0,
      fps: 0,
    });
    expect(e.kind).toBe("photo");
    expect([e.outWidth, e.outHeight]).toEqual([4000, 2000]);
    expect(e.outFrames).toBe(1);
    expect(e.durationSec).toBe(0);
  });

  it("слишком большой результат помечается предупреждением", () => {
    const p = engine.normalizeParams({ scale: 4 });
    const e = engine.estimateUpscale(p, {
      kind: "photo",
      width: 12000,
      height: 8000,
      duration: 0,
      fps: 0,
    });
    expect(e.warnings).toContain("too_large");
  });

  it("скорость запоминается из выполненных заданий и даёт оценку времени", () => {
    expect(engine.throughputMpx()).toBe(0);
    engine.recordThroughput(2_000_000, 1000); // 2 Мп за 1 c
    expect(engine.throughputMpx()).toBeCloseTo(2, 2);
    // Множитель ограничен доступными (2/3/4), поэтому 1000×1000 → 2000×2000.
    const p = engine.normalizeParams({ scale: 2 });
    const e = engine.estimateUpscale(p, {
      kind: "photo",
      width: 1000,
      height: 1000,
      duration: 0,
      fps: 0,
    });
    expect(e.etaSec).toBe(2); // 4 Мп при 2 Мп/с
  });
});

describe("апскейл: ключи интерфейса есть во всех локалях", () => {
  /** Ключи из исходников: t("up.xxx") / t(`up.xxx`). Динамические — отдельно. */
  function usedKeys(code: string): string[] {
    const out = new Set<string>();
    for (const m of code.matchAll(/t\(\s*"([a-zA-Z0-9_.-]+)"/g)) {
      if (m[1].startsWith("up.")) out.add(m[1]);
    }
    return [...out];
  }

  it("все статические ключи страницы, дашборда и Pro-панели переведены", () => {
    const files = [page, dashboard, proSettings, read("src/components/upscale/CompareSlider.tsx")];
    const keys = [...new Set(files.flatMap(usedKeys))];
    expect(keys.length).toBeGreaterThan(30);
    const missing: string[] = [];
    for (const lang of LANG_CODES) {
      const dict = JSON.parse(read(`src/i18n/${lang}.json`)) as { up?: Record<string, unknown> };
      for (const k of keys) {
        const short = k.replace(/^up\./, "");
        if (typeof dict.up?.[short] !== "string") missing.push(`${lang}:${k}`);
      }
    }
    expect(missing.join(", ")).toBe("");
  });

  it("динамические семейства ключей (пресеты, стадии, ошибки, оценка) заполнены", () => {
    for (const lang of LANG_CODES) {
      const up = (JSON.parse(read(`src/i18n/${lang}.json`)) as { up: Record<string, string> }).up;
      for (const p of engine.SYSTEM_PRESETS) {
        expect(typeof up[`preset_${p.id}`], `${lang}:preset_${p.id}`).toBe("string");
      }
      for (const s of ["queued", "analyze", "upscale", "encode", "done", "error", "stopped"]) {
        expect(typeof up[`stage_${s}`], `${lang}:stage_${s}`).toBe("string");
      }
      for (const e of [
        "interp_model_missing",
        "model_signature_unknown",
        "interp_output_missing",
        "interp_frame_count",
      ]) {
        expect(typeof up[`err_${e}`], `${lang}:err_${e}`).toBe("string");
      }
      // Оценка: ключи совпадают с предупреждениями движка.
      for (const w of [
        "model_missing",
        "runtime_missing",
        "too_large",
        "too_slow",
        "model_unknown",
        "interp_model_missing",
        "frame_limit",
      ]) {
        expect(typeof up[`est_${w}`], `${lang}:est_${w}`).toBe("string");
      }
      for (const k of ["express", "again", "choose", "slowMotion", "batchFrames", "frameLimit"]) {
        expect(typeof up[k], `${lang}:${k}`).toBe("string");
      }
    }
  });

  it("все ключи est_* из движка имеют перевод", () => {
    const warns = [
      "model_missing",
      "runtime_missing",
      "too_large",
      "too_slow",
      "model_unknown",
      "interp_model_missing",
      "frame_limit",
    ];
    const upRu = (JSON.parse(read("src/i18n/ru.json")) as { up: Record<string, string> }).up;
    for (const w of warns) expect(upRu[`est_${w}`], w).toBeTruthy();
  });
});

describe("апскейл: пачка кадров в одном вызове ONNX", () => {
  /** Сессия-заглушка: «апскейл» ×2 и своё значение на каждый кадр пачки. */
  function mockUpscaler() {
    return {
      inputNames: ["input"],
      outputNames: ["output"],
      calls: 0,
      lastDims: [] as number[],
      async run(feeds: Record<string, any>) {
        const t = feeds.input;
        this.calls++;
        this.lastDims = t.dims;
        const [n, , h, w] = t.dims as number[];
        const out = new Float32Array(n * 3 * h * 2 * w * 2);
        const plane = h * 2 * w * 2;
        for (let k = 0; k < n; k++) {
          // Каждый кадр пачки получает своё значение: по нему видно, что выход
          // разложен по кадрам в правильном порядке.
          const value = (k + 1) / 10;
          for (let i = 0; i < plane; i++) {
            out[k * 3 * plane + i] = value;
            out[k * 3 * plane + plane + i] = value;
            out[k * 3 * plane + plane * 2 + i] = value;
          }
        }
        return { output: { data: out, dims: [n, 3, h * 2, w * 2] } };
      },
    };
  }

  it("вход [n,3,h,w] — кадры подряд по каналам, выход разложен по кадрам", async () => {
    const ort = {
      Tensor: class {
        dims: number[];
        constructor(
          public type: string,
          public data: Float32Array,
          dims: number[],
        ) {
          this.dims = dims;
        }
      },
    };
    const ready = { session: mockUpscaler(), provider: "cpu", bgr: false, scale: 2 };
    const frames = [
      Buffer.alloc(4 * 4 * 3, 10),
      Buffer.alloc(4 * 4 * 3, 20),
      Buffer.alloc(4 * 4 * 3, 30),
    ];
    const out = await engine.upscaleRgbBatch({
      frames,
      w: 4,
      h: 4,
      // Тайл меньше картинки: проверяем и тайлинг, и пачку одновременно.
      p: { model: "realesr-general-x4v3", tile: 4, overlap: 0, provider: "cpu", threads: 0 } as any,
      deps: { ort: ort as any, ready: ready as any },
    });
    expect(out).toHaveLength(3);
    for (const o of out) {
      expect([o.width, o.height, o.provider]).toEqual([8, 8, "cpu"]);
      expect(o.data.length).toBe(8 * 8 * 3);
    }
    // Ровный цвет каждого кадра сохранился: кадры не перемешались.
    expect(out[0].data[0]).toBe(26); // 0.1 → 25.5 → 26
    expect(out[1].data[0]).toBe(51);
    expect(out[2].data[0]).toBe(77);
    // Пачка ушла одним вызовом: размерности [n,3,th,tw].
    expect(ready.session.calls).toBe(1);
    expect(ready.session.lastDims).toEqual([3, 3, 4, 4]);
  });

  it("одна рамка пачкой не считается — путь по одному кадру", async () => {
    await expect(
      engine.upscaleRgbBatch({
        frames: [Buffer.alloc(4 * 4 * 3)],
        w: 4,
        h: 4,
        p: {
          model: "realesr-general-x4v3",
          tile: 0,
          overlap: 0,
          provider: "cpu",
          threads: 0,
        } as any,
        deps: {
          ort: { Tensor: class {} } as any,
          ready: { session: mockUpscaler(), provider: "cpu", bgr: false, scale: 2 } as any,
        },
      }),
    ).rejects.toThrow("batch_too_small");
  });

  it("batchAllowed: каталог с batch=1 запрещает сразу, неизвестные — пробуем", () => {
    // Модели с фактом `batch: 1` (Real-ESRGAN x2/x4plus) пачку не принимают —
    // движок это знает из каталога и очередь под них не копит.
    expect(engine.batchAllowed("realesrgan-x2")).toBe(false);
    expect(engine.batchAllowed("realesrgan-x4plus")).toBe(false);
    // У остальных факт ещё не проверен: пробуем и запоминаем результат.
    expect(engine.batchAllowed("realesr-general-x4v3")).toBe(true);
    // Интерполяторы тоже помечены batch: 1 (наши экспорты: dynamic_axes только h/w).
    expect(engine.batchAllowed("rife-v49")).toBe(false);
    expect(engine.batchAllowed("никому-не-известная-модель")).toBe(true);
  });

  it("markBatchUnsupported: после пойманного отказа пачка больше не пробуется", () => {
    expect(engine.batchAllowed("some-unknown-model")).toBe(true);
    engine.markBatchUnsupported("some-unknown-model");
    expect(engine.batchAllowed("some-unknown-model")).toBe(false);
  });
});

describe("апскейл: каталог моделей (скачивание, удаление, оптимальные настройки)", () => {
  const manifest = JSON.parse(read("server/models.manifest.json")) as {
    models: Array<Record<string, unknown>>;
  };

  it("манифест согласован: уникальные id и файлы, https-ссылки, теги и rec", () => {
    const ids = manifest.models.map((m) => String(m.id));
    const files = manifest.models.map((m) => String(m.file));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(files).size).toBe(files.length);
    const knownTags = ["photo", "video", "anime", "fast", "detail", "restore", "heavy", "interp"];
    for (const m of manifest.models) {
      expect(String(m.file)).toMatch(/\.onnx$/);
      expect(Number(m.scale)).toBeGreaterThan(0);
      if (m.url) expect(String(m.url)).toMatch(/^https:\/\//);
      if (m.kind === "interp") {
        expect(Number(m.mult)).toBeGreaterThanOrEqual(2);
        expect(["rife-pair-timestep", "cain-concat", "ifrnet-pair"]).toContain(String(m.inputSig));
      }
      for (const tag of (m.tags as string[]) || []) expect(knownTags, String(m.id)).toContain(tag);
      const rec = (m.rec || {}) as Record<string, number>;
      for (const [k, v] of Object.entries(rec))
        expect(Number(v), `${m.id}.${k}`).toBeGreaterThanOrEqual(0);
      // sha256 имеет смысл только при ссылке из каталога.
      if (!m.url) expect(String(m.sha256 || "")).toBe("");
      if (m.sha256) expect(String(m.sha256)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("каталог отдаёт в UI теги, rec, измеренную скорость и прогресс", () => {
    const list = engine.listModels();
    expect(list.length).toBeGreaterThanOrEqual(20);
    for (const m of list) {
      expect(Array.isArray(m.tags)).toBe(true);
      expect(typeof m.rec).toBe("object");
      expect(typeof m.measured).toBe("string");
      expect(typeof m.hint).toBe("string");
      expect(m.downloading === null || typeof m.downloading === "object").toBe(true);
    }
    const withUrl = list.filter((m: any) => m.url);
    expect(withUrl.length).toBeGreaterThanOrEqual(10);
    for (const m of withUrl) {
      expect(m.sizeMb, m.id).toBeGreaterThan(0);
      expect(String(m.sha256), m.id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rec модели подставляется как настройки, у интерполятора — как плавность", () => {
    const up = engine.modelRecommended("ultrasharp-v2");
    expect(up.model).toBe("ultrasharp-v2");
    expect([up.scale, up.tile, up.overlap, up.presetId]).toEqual([2, 192, 16, ""]);
    // Настройки не выходят за границы нормализации параметров.
    const norm = engine.normalizeParams(up);
    expect([norm.model, norm.scale, norm.tile, norm.overlap]).toEqual([
      "ultrasharp-v2",
      2,
      192,
      16,
    ]);
    const interp = engine.modelRecommended("rife-v49");
    expect(interp.interpMode).toBe("model");
    expect(interp.interpModel).toBe("rife-v49");
    expect(interp.interpMult).toBe(2);
    expect(engine.modelRecommended("нет-такой")).toBe(null);
  });

  it("пресеты ссылаются на модели каталога и покрывают задачи", () => {
    const ids = new Set(engine.listModels().map((m: any) => m.id));
    for (const p of engine.SYSTEM_PRESETS) {
      expect(ids.has(p.model), `${p.id} → ${p.model}`).toBe(true);
      expect(p.kind === "photo" || p.kind === "video").toBe(true);
      if (p.interpMode === "model") expect(ids.has(String(p.interpModel)), p.id).toBe(true);
    }
    const byId = new Map<string, any>(engine.SYSTEM_PRESETS.map((p: any) => [p.id, p]));
    for (const id of [
      "photo-hero",
      "photo-portrait",
      "photo-restore",
      "photo-anime",
      "photo-print",
      "photo-web",
      "photo-fast",
      "photo-2x",
      "video-hd",
      "video-4k",
      "video-smooth60",
      "video-smooth-4k",
      "video-interp-rife",
      "video-slowmo",
      "video-preview",
      "video-restore",
      "video-fast",
    ]) {
      expect(byId.has(id), id).toBe(true);
    }
    // Пресеты используют возможности фазы 3, а не только «модель + множитель».
    expect(byId.get("video-slowmo").slowMotion).toBe(0.5);
    expect(byId.get("video-preview").frameLimit).toBe(60);
    expect(byId.get("video-preview").batchFrames).toBe(4);
  });

  it("скачивание: неизвестная модель и модель без ссылки отклоняются", async () => {
    await expect(engine.downloadModel("нет-такой")).rejects.toThrow("model_unknown");
    // Модель без ссылки (её ONNX в открытом доступе нет) — честная ошибка.
    // Ищем такую в каталоге: список моделей меняется, тест не должен ломаться.
    const noUrl = engine.listModels().find((m: { url: string }) => !m.url);
    if (noUrl) await expect(engine.downloadModel(noUrl.id)).rejects.toThrow("model_no_url");
    expect(() => engine.removeModel("нет-такой")).toThrow("model_unknown");
  });

  it("удаление модели убирает файл с диска, каталог остаётся", () => {
    const m = engine.listModels().find((x: any) => x.id === "realesr-general-x4v3");
    const backup = fs.existsSync(m.path) ? fs.readFileSync(m.path) : null;
    if (!backup) fs.writeFileSync(m.path, "test");
    const r = engine.removeModel("realesr-general-x4v3");
    expect([r.ok, r.removed]).toEqual([true, true]);
    expect(fs.existsSync(m.path)).toBe(false);
    // Повторное удаление — не ошибка, просто «нечего удалять».
    expect(engine.removeModel("realesr-general-x4v3").removed).toBe(false);
    if (backup) fs.writeFileSync(m.path, backup);
  });

  it("рантайм: состояние отдаётся в UI, отказ не залипает навсегда", () => {
    // Ключевой сценарий: пользователь поставил onnxruntime-node уже после старта
    // приложения. Раньше «нет рантайма» кэшировалось на весь процесс, и сообщение
    // оставалось до перезапуска — теперь есть повтор и кнопка «Проверить снова».
    const src = read("server/ts/upscale.ts");
    expect(src).toMatch(/function loadOrt\(force = false\)/);
    expect(src).toMatch(/ORT_RETRY_MS/);
    expect(src).toMatch(/export function runtimeStatus\(\)/);
    // Пакованная сборка: ищем модуль и рядом с app.asar (asarUnpack).
    expect(src).toContain("app.asar.unpacked");
    const st = engine.runtimeStatus();
    expect(typeof st.available).toBe("boolean");
    expect(typeof st.error).toBe("string");
    if (st.available) {
      expect(st.version).toMatch(/^\d+\./);
      expect(st.path).toContain("onnxruntime-node");
      expect(st.error).toBe("");
    } else {
      // Без рантайма состояние обязано объяснять причину, а не молчать.
      expect(st.error.length).toBeGreaterThan(0);
    }
    // Оба места, где UI говорит про рантайм, различают «сервер не ответил» и
    // «сервер ответил: рантайма нет». Раньше любой сбой API выглядел как
    // «установите onnxruntime-node» — именно это ввело в заблуждение.
    const pageUi = read("src/pages/upscale/UpscalePage.tsx");
    const panelUi = read("src/pages/upscale/parts/UpscaleModelsPanel.tsx");
    expect(pageUi).toContain("runtimeInfo");
    expect(panelUi).toContain("runtimeError");
    for (const ui of [pageUi, panelUi]) {
      expect(ui).toContain("up.runtimeWhy");
      expect(ui).toContain("up.apiDown");
    }
    expect(pageUi).toContain("loadHardware");
    expect(pageUi).toContain('t("up.runtimeRetry")');
    expect(panelUi).toContain("!apiDown && !runtime");
    // Каталог тоже отдаёт детали рантайма.
    expect(read("server/routes/upscale.js")).toContain("runtimeStatus()");
  });

  it("правая колонка настроек той же ширины, что на странице сжатия", () => {
    // Ширина правой колонки задаётся одним правилом на обеих страницах, иначе
    // панель настроек выглядит «худее» соседа. Тест держит их синхронными.
    const pages = read("src/styles/pages.css");
    const up = read("src/styles/upscale.css");
    const columns = /grid-template-columns: minmax\(0, 1fr\) minmax\(360px, 440px\)/;
    expect(pages).toMatch(columns);
    expect(up).toMatch(columns);
    // Одинаковый порог перехода в одну колонку (иначе страницы «ломаются» врозь).
    expect(pages).toMatch(/@media \(max-width: 980px\)/);
    expect(up).toMatch(/@media \(max-width: 980px\)/);
    expect(up).not.toMatch(/@media \(max-width: 1200px\)/);
    // Карточка настроек — как .cmp-card: те же отступы и скругление.
    expect(up).toMatch(/\.up-card \{[\s\S]*?padding: 14px 16px/);
    expect(pages).toMatch(/\.cmp-card \{[\s\S]*?padding: 14px 16px/);
  });
});

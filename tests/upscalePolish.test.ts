import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { readUpscaleSrc } from "./helpers/readUpscaleSrc";

/**
 * Правки страницы апскейла по просьбе владельца: зум колесом и полоса сравнения
 * при кропе, пакетный режим (много фото за раз), качество 100 по умолчанию и
 * аккуратный layout Pro-настроек (ничего не вылезает за блок).
 *
 * Проверяем и поведение движка (дефолт качества), и контракт интерфейса —
 * ONNX-рантайм и браузер в тестах не нужны.
 */
const req = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..");
const read = (rel: string): string =>
  rel === "server/ts/upscale.ts"
    ? readUpscaleSrc(root)
    : fs.readFileSync(path.join(root, rel), "utf8");
const LANG_CODES = ["ru", "en", "es", "fr", "zh", "ar"];

let engine: any;
beforeAll(() => {
  process.env.MOONAPP_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "pa-polish-"));
  engine = req("../server/upscale");
});

describe("апскейл: зум, полоса сравнения, пакет и дефолты", () => {
  it("качество по умолчанию — 100 и в UI, и на сервере", () => {
    // Раньше страница открывалась с 92: пользователь просил максимум по умолчанию.
    expect(read("src/pages/upscale/UpscalePage.tsx")).toMatch(/quality:\s*100,/);
    expect(read("server/ts/upscale.ts")).toMatch(/raw\.quality \?\? 100/);
    // Поведенчески: без явного качества движок берёт 100 (и не даёт выйти за диапазон).
    expect(engine.normalizeParams({}).quality).toBe(100);
    expect(engine.normalizeParams({ quality: 500 }).quality).toBe(100);
    expect(engine.normalizeParams({ quality: 0 }).quality).toBe(1);
  });

  it("зум колесом мыши и панорамирование без ухода картинки за края", () => {
    const src = read("src/components/upscale/CompareSlider.tsx");
    // Колесо ловим нативно: у React обработчик wheel пассивный, preventDefault в нём нельзя.
    expect(src).toContain(`addEventListener("wheel"`);
    expect(src).toContain("{ passive: false }");
    // Масштаб привязан к точке под курсором и ограничен разумными рамками.
    expect(src).toMatch(/clamp\(prev\.z \* factor, MIN_ZOOM, MAX_ZOOM\)/);
    // Сдвиг не даёт утащить картинку целиком: clampView держит её в блоке.
    expect(src).toContain("const clampView");
    expect(src).toMatch(/const maxX = Math\.max\(0, \(d\.w \* v\.z - b\.w\) \/ 2\)/);
    // Двойной клик и контекстное меню возвращают вид к Fit.
    expect(src).toContain("onDoubleClick={resetView}");
  });

  it("полоса сравнения привязана к пикселям изображения и едет при кропе", () => {
    const src = read("src/components/upscale/CompareSlider.tsx");
    // Позиция ручки считается из доли изображения с учётом зума и сдвига…
    expect(src).toContain("const splitX =");
    expect(src).toMatch(/\(split - 0\.5\) \* disp\.w \* view\.z/);
    // …а в разметке используются пиксельные клипы и left в px (раньше были проценты
    // окна: под зумом полоса «стояла на месте», пока картинка уезжала).
    expect(src).toContain("clipPath: `inset(0 ${rightPx}px 0 0)`");
    expect(src).toContain("clipPath: `inset(0 0 0 ${leftPx}px)`");
    expect(src).toContain("style={{ left: `${leftPx}px` }}");
    // За ручку — только разделитель, иначе жест уводил бы в сдвиг картинки.
    expect(src).toMatch(/e\.stopPropagation\(\);\s*\n\s*dragSplit\.current = true;/);
  });

  it("пакетный режим: несколько файлов за раз", () => {
    const page = read("src/pages/upscale/UpscalePage.tsx");
    // Поле выбора принимает много файлов и живёт вне dropzone (иначе «Добавить» не работает).
    expect(page).toContain("multiple");
    expect(page).toContain("pickMany");
    expect(page).toMatch(/list\.length <= 1[\s\S]{0,80}void pick\(list\[0\] \|\| null\)/);
    // Файлы уходят в очередь по одному, как задания движка.
    expect(page).toMatch(
      /for \(const it of items\)[\s\S]{0,220}api\.upscaleStart\(it\.file, payload\)/,
    );
    const list = read("src/pages/upscale/parts/UpscaleBatchList.tsx");
    expect(list).toContain("BatchItem");
    expect(list).toContain('t("up.batchRun")');
    expect(list).toContain('t("up.batchDownloadAll")');
    // Кнопка запуска в панели тоже знает про пакет.
    const dash = read("src/pages/upscale/parts/UpscaleDashboard.tsx");
    expect(dash).toContain("batchCount");
    expect(dash).toContain('{batchMode ? t("up.batchRun") : t("up.start")}');
  });

  it("Pro-настройки: контролы не выходят за края блока и стоят по одному краю", () => {
    const css = read("src/styles/upscale.css");
    // Строка — flex с переносом: колонка `auto` в grid не сжимается ниже
    // min-content контрола, из-за чего кнопка выбора тайла вылезала за блок.
    expect(css).toMatch(/\.up-pro-row \{[\s\S]*?display: flex;[\s\S]*?flex-wrap: wrap/);
    expect(css).toMatch(/\.up-pro-ctl \{[\s\S]*?justify-content: flex-end/);
    expect(css).toMatch(/\.up-pro-ctl \{[\s\S]*?margin-left: auto/);
    expect(css).toMatch(/\.up-pro-ctl > \* \{[\s\S]*?max-width: 100%/);
    // Селект ужимается до своей обёртки: длинная опция не растягивает строку.
    expect(css).toMatch(/\bup-pro-ctl \.select-wrap select \{[\s\S]*?width: 100%/);
    expect(css).toMatch(/\.up-pro-ctl \.select-wrap select \{[\s\S]*?min-width: 0/);
    // Подпись видна целиком и получает свободное место.
    expect(css).not.toMatch(/\.up-pro-label \{[\s\S]{0,120}?text-overflow: ellipsis/);
    expect(css).toMatch(/\.up-pro-info \{[\s\S]*?flex: 1 1 auto/);
    // Inline-ширины контролов ужимаются до ширины блока.
    const pro = read("src/pages/upscale/parts/UpscaleProSettings.tsx");
    expect(pro).not.toMatch(/style=\{\{ width: \d+ \}\}/);
    expect(pro).toContain(`style={{ width: "min(220px, 100%)" }}`);
    // У полей целевого разрешения есть подпись строки и aria-label на каждом окне.
    expect(pro).toMatch(/<Row label=\{t\("up\.targetSize"\)\}/);
    expect(pro).toContain(`aria-label={t("up.targetW")}`);
    expect(pro).toContain(`aria-label={t("up.targetH")}`);
  });

  it("описания настроек — во всплывающих подсказках, строки одной высоты", () => {
    const pro = read("src/pages/upscale/parts/UpscaleProSettings.tsx");
    const css = read("src/styles/upscale.css");
    // У каждой настройки — маленькая кнопка «?», описание всплывает по наведению.
    expect(pro).toContain("function HelpTip");
    expect(pro).toContain("<HelpCircle");
    expect(pro).toContain('className="up-info-btn"');
    expect(pro).toContain('className="up-tip"');
    expect(pro).toMatch(/hint \? <HelpTip text=\{hint\} \/> : null/);
    // Текста-описания под подписью больше нет: строки одинаковой высоты.
    const row = pro.slice(pro.indexOf("function Row("), pro.indexOf("export default function"));
    expect(row).not.toContain("muted-sm");
    expect(css).toMatch(/\.up-pro-row \{[\s\S]*?min-height: 32px/);
    expect(css).toMatch(/\.up-pro-ctl \.select-wrap select[\s\S]{0,120}height: 30px/);
    // Подсказка позиционируется fixed — скролл панели её не обрезает.
    expect(css).toMatch(/\.up-tip \{[\s\S]*?position: fixed/);
  });

  it("селектор модели компактный: строка списка — одно название", () => {
    const css = read("src/styles/upscale.css");
    // Строка списка — flex-строка с названием на всю ширину, а не «карточка» в
    // три этажа со значками, тегами и замером: список должен читаться как меню.
    expect(css).toMatch(/\.up-pick-row \{[\s\S]*?flex-direction: row/);
    expect(css).toMatch(/\.up-pick-row \{[\s\S]*?min-height: 24px/);
    expect(css).toMatch(/\.up-pick-row-name \{[\s\S]*?flex: 1 1 auto/);
    // Значки в селекторе — иконки без подписей; не скачана — приглушённое имя.
    expect(css).toMatch(/\.up-pick-mark \{[\s\S]*?display: inline-flex/);
    expect(css).toMatch(/\.up-pick-mark\.is-warn/);
    expect(css).toMatch(/\.up-pick-row\.is-missing \.up-pick-row-name \{[\s\S]*?opacity: 0\.55/);
    // Две колонки включаются раньше, фильтры — компактные.
    expect(css).toMatch(/\.up-pick-list \{[\s\S]*?minmax\(260px, 1fr\)/);
    expect(css).toMatch(/\.up-pick-filters \.badge \{[\s\S]*?font-size: 10\.5px/);
    // Поле модели растягивается на свободное место: триггер длиннее, а список
    // получает ширину под две колонки.
    expect(css).toMatch(/\.up-fields \.field:has\(> \.up-pick\) \{[\s\S]*?flex: 1 1 300px/);
    // В самом списке подробностей больше нет — они ушли в подсказку и в каталог.
    const picker = read("src/pages/upscale/parts/UpscaleModelPicker.tsx");
    expect(picker).toContain("up-pick-row-name");
    expect(picker).not.toContain("up-pick-row-badges");
    expect(picker).not.toContain("up-pick-meas");
    // Фильтр на месте: без него модель из семидесяти не найти.
    expect(picker).toContain("up-pick-filters");
    expect(picker).toContain('t("up.pickSearch")');
  });

  it("строку пресетов можно свернуть", () => {
    const dash = read("src/pages/upscale/parts/UpscaleDashboard.tsx");
    const css = read("src/styles/upscale.css");
    expect(dash).toContain("presetsOpen");
    expect(dash).toContain('className={`up-fold${presetsOpen ? " is-open" : ""}`}');
    expect(dash).toContain('t("up.presetsCollapse")');
    expect(dash).toContain('t("up.presetsExpand")');
    // Свёрнутая строка показывает активный пресет, а не пустоту.
    expect(dash).toMatch(/activePreset \? presetLabel\(activePreset\)/);
    expect(css).toMatch(/\.up-fold\.is-open svg \{[\s\S]*?transform: rotate\(90deg\)/);
  });

  it("высота контролов в настройках одна: поле, кнопка и селектор не «пляшут»", () => {
    const css = read("src/styles/upscale.css");
    // Общий токен высоты на странице; значение совпадает с селектом из ui.css.
    expect(css).toMatch(/\.up-page \{[\s\S]*?--ctl-h: 30px/);
    // Одной высоты: поле ввода, кнопка, фильтр-переключатель и селектор модели.
    expect(css).toMatch(/\.up-fields \.text-input,[\s\S]{0,400}?height: var\(--ctl-h, 30px\)/);
    expect(css).toMatch(/\.up-pro-ctl > \.btn,[\s\S]{0,400}?height: var\(--ctl-h, 30px\)/);
    expect(css).toMatch(/\.up-mdl-head \.btn,[\s\S]{0,200}?height: var\(--ctl-h, 30px\)/);
    // Сам селектор модели — той же высоты, что селект рядом с ним.
    expect(css).toMatch(/\.up-pick-btn \{[\s\S]*?height: var\(--ctl-h, 30px\)/);
  });

  it("окно каталога моделей не заезжает на панель управления", () => {
    const css = read("src/styles/upscale.css");
    /** Тело правила CSS по селектору — так проверки не зависят от порядка свойств. */
    const block = (sel: string): string =>
      new RegExp(`\\${sel} \\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] || "";
    const overlay = block(".up-mdl-overlay");
    const panelCss = block(".up-mdl-panel");
    // Как .lecs-overlay на странице лектория: отступы контентной зоны, а не inset:0.
    expect(overlay).toContain("padding: var(--content-top) 24px var(--content-bottom)");
    // Высота панели ограничена этой зоной, а не vh: на невысоких окнах окно
    // уходило под верхнее меню приложения.
    expect(panelCss).toContain("max-height: 100%");
    expect(panelCss).not.toContain("88vh");
    // Скроллится список, а не вся панель — шапка с кнопками остаётся видна.
    expect(panelCss).toContain("overflow: hidden");
    expect(block(".up-mdl-list")).toContain("flex: 1 1 auto");
    // Непрозрачная подложка: страница не просвечивает сквозь окно (общий класс
    // модалок .glass-solid — тот же, что у окна выбора движка на лектории).
    const panelTsx = read("src/pages/upscale/parts/UpscaleModelsPanel.tsx");
    expect(panelTsx).toContain("up-mdl-panel glass-solid");
    expect(read("src/styles/theme.css")).toMatch(
      /\.glass-solid \{[\s\S]*?background: var\(--surface-solid\)/,
    );
  });

  it("все ключи новых элементов переведены на 6 языков", () => {
    const files = [
      read("src/pages/upscale/UpscalePage.tsx"),
      read("src/pages/upscale/parts/UpscaleBatchList.tsx"),
      read("src/pages/upscale/parts/UpscaleDashboard.tsx"),
      read("src/components/upscale/CompareSlider.tsx"),
    ];
    const keys = new Set<string>();
    for (const code of files) {
      // Ключи вида t(`up.stage_${...}`) динамические — их проверяет тест страницы.
      for (const m of code.matchAll(/t\(\s*"(up\.[a-zA-Z0-9_.]+)"/g)) keys.add(m[1]);
    }
    expect([...keys].filter((k) => k.startsWith("up.batch")).length).toBeGreaterThan(8);
    const missing: string[] = [];
    for (const lang of LANG_CODES) {
      const dict = JSON.parse(read(`src/i18n/${lang}.json`)) as { up?: Record<string, string> };
      for (const k of keys) {
        const name = k.slice(3);
        if (!dict.up || !dict.up[name]) missing.push(`${lang}:${k}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("апскейл: стоп у прогресса, кадры, видеокарта и очистка папки in", () => {
  it("у прогресса — маленькая кнопка «Стоп» (иконка) и счётчик кадров", () => {
    const dash = read("src/pages/upscale/parts/UpscaleDashboard.tsx");
    const page = read("src/pages/upscale/UpscalePage.tsx");
    const css = read("src/styles/upscale.css");
    // Кнопка именно иконкой и в строке прогресса, а не текстовая кнопка снизу.
    expect(dash).toContain('className="up-stop-btn"');
    expect(dash).toMatch(/className="up-stop-btn"[\s\S]{0,260}?<Square size=\{11\} \/>/);
    expect(dash).toContain('t("up.cancel")');
    // Полоса, кадры и стоп — одна строка.
    const row = dash.slice(dash.indexOf('className="up-progress-row"'));
    expect(row).toContain('t("up.frames"');
    expect(row.indexOf("up.frames")).toBeLessThan(row.indexOf("up-stop-btn"));
    // Клиент и сервер: мягкая остановка, а не удаление задания.
    expect(page).toContain("upscaleCancel");
    expect(read("server/routes/upscale.js")).toContain('"/:id/cancel"');
    const engineSrc = read("server/ts/upscale.ts");
    expect(engineSrc).toMatch(/export function cancelJob[\s\S]{0,600}?j\.stage = "stopped"/);
    // Задание, ещё стоящее в очереди, отменяем сразу: иначе оно успело бы стартовать.
    expect(engineSrc).toMatch(/if \(!j\.startedAt\) \{[\s\S]{0,120}?j\.error = "stopped"/);
    // Стиль: компактная кнопка-иконка.
    expect(css).toMatch(/\.up-stop-btn \{[\s\S]*?width: 22px/);
    expect(css).toMatch(/\.up-progress-row > \.progress-track \{[\s\S]*?flex: 1 1 auto/);
  });

  it("стоп есть и в пакетном списке — очередь из десятков файлов можно прервать", () => {
    const batch = read("src/pages/upscale/parts/UpscaleBatchList.tsx");
    expect(batch).toContain("onCancel");
    expect(batch).toContain('className="up-stop-btn"');
    expect(read("src/pages/upscale/UpscalePage.tsx")).toContain(
      "onCancel={(id) => void cancelRun(id)}",
    );
  });

  it("видеокарта: настройка в Pro, план сборки и фолбэки кодировщика", () => {
    const pro = read("src/pages/upscale/parts/UpscaleProSettings.tsx");
    const page = read("src/pages/upscale/UpscalePage.tsx");
    const pipe = read("server/ts/upscalePipeline.ts");
    const engineTs = read("server/ts/upscale.ts");
    // Выбор «Видеокарта / Процессор», подсказка показывает, что сборка умеет.
    expect(pro).toContain('t("up.hwAccel")');
    expect(pro).toContain('onParams({ hwAccel: e.target.value === "on" })');
    expect(page).toContain("hwAccel: true");
    // Кодировщик — по возможностям сборки: жёсткий libsvtav1 ломал AV1 (gyan essentials).
    expect(pipe).toContain("pickVideoEncoder");
    expect(pipe).toContain("av1_nvenc");
    expect(pipe).toContain("pickHwaccel");
    expect(engineTs).toContain("vcodec_unavailable");
    // CRF у AV1 длиннее — ползунок и сервер это учитывают.
    expect(pro).toContain('max={params.vcodec === "av1" ? 63 : 51}');
    expect(engineTs).toContain("crfMax(vcodec)");
  });

  it("папка загрузок чистится после апскейла и при выборе нового файла", () => {
    const engineTs = read("server/ts/upscale.ts");
    const page = read("src/pages/upscale/UpscalePage.tsx");
    const routes = read("server/routes/upscale.js");
    expect(engineTs).toContain("export function cleanInputs");
    // Незавершённые задания не трогаем — иначе движок упадёт на чтении входа.
    expect(engineTs).toMatch(/if \(!j\.done && j\.stage !== "error"\) busy\.add/);
    // После задачи вход остаётся для повтора, а старые файлы уходят.
    expect(engineTs).toMatch(/cleanInputs\(\[job\.inputPath\]\)/);
    expect(routes).toContain('"/inputs/clean"');
    expect(page).toContain("upscaleCleanInputs");
  });

  it("сторона интерполяции — общая настройка (и для ONNX-модели)", () => {
    const pro = read("src/pages/upscale/parts/UpscaleProSettings.tsx");
    // Раньше выбор был только у ffmpeg-режима — теперь у обоих режимов сразу.
    expect((pro.match(/t\("up\.minterpSide"\)/g) || []).length).toBe(1);
    expect(pro).toContain('{params.interpMode !== "off" ? (');
    expect(pro).toContain('{ value: "decode", label: t("up.minterpDecode") }');
    expect(pro).toContain('{ value: "encode", label: t("up.minterpEncode") }');
    // Подсказка честно объясняет цену: апскейл получает в 2–4 раза больше кадров.
    const ru = (JSON.parse(read("src/i18n/ru.json")) as { up: Record<string, string> }).up;
    expect(ru.minterpSideHint).toContain("2–4");
    // Конвейер умеет обе стороны, а частота rawvideo в режиме модели — выходная.
    const pipeSrc = read("server/ts/upscalePipeline.ts");
    expect(pipeSrc).toContain(
      'const interpBefore = !!interpolate && opts.interpSide === "decode";',
    );
    expect(pipeSrc).toMatch(/kind: "model"[\s\S]{0,600}?pipeRate: outR,/);
  });

  it("пресет плавности моделью остаётся «после апскейла»", () => {
    // Смена дефолта не должна незаметно удвоить работу апскейла в пресете.
    const preset =
      /id: "video-interp-rife"[\s\S]*?\n {2}\},/.exec(read("server/ts/upscale.ts"))?.[0] || "";
    expect(preset).toContain('minterpolateSide: "encode"');
  });

  it("пункт аппаратного ускорения переименован, «Видеокарта: Видеокарта» больше нет", () => {
    // Раньше подпись была «Видеокарта», а значение — «Видеокарта» же: выглядело
    // бессмысленно. Теперь подпись — про ускорение, значения — про устройство.
    for (const lang of LANG_CODES) {
      const up = (JSON.parse(read(`src/i18n/${lang}.json`)) as { up: Record<string, string> }).up;
      expect(up.hwAccel, lang).toMatch(/аппаратн|hardware|hardware|matériel|硬件|عتاد/i);
      expect(up.hwOn, lang).not.toBe(up.hwAccel);
      expect(up.hwOn, lang).toMatch(/NVENC/i);
      expect(up.hwOff, lang).toMatch(/x264/i);
      // Подсказка объясняет, что настройка влияет и на выбор кодировщика (AV1).
      expect(up.hwAccelHint, lang).toMatch(/AV1|av1/);
    }
  });

  it("все новые ключи есть во всех локалях", () => {
    for (const lang of LANG_CODES) {
      const up = (JSON.parse(read(`src/i18n/${lang}.json`)) as { up: Record<string, string> }).up;
      for (const key of [
        "cancel",
        "frames",
        "hwAccel",
        "hwAccelHint",
        "hwOn",
        "hwOff",
        "err_vcodec_unavailable",
        "err_stopped",
        "batchFrames",
        "batchFramesHint",
        "batchAuto",
        "batchFramesAutoUsed",
        "minterpSide",
        "minterpSideHint",
        "minterpDecode",
        "minterpEncode",
        "modelNone",
        "modelNoneNote",
        "modelNoneHint",
        "interpMultModelHint",
      ]) {
        expect(typeof up[key], `${lang}:${key}`).toBe("string");
      }
    }
  });
});

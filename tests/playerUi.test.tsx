import React from "react";
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/app/i18n";
import VideoPlayer from "@/pages/movies/parts/VideoPlayer";
import DownloadsView from "@/pages/movies/parts/DownloadsView";
import { fmtBytes, fmtEta, fmtSpeed } from "@/pages/movies/lib/bytes";

/**
 * Свой плеер и вкладка «Скачанные».
 *
 * Проверяем то, что пользователь видит сразу и что легко сломать незаметно:
 * набор кнопок панели (нативные controls заменены своими), плашку буферизации,
 * дорожку субтитров, кнопки раздачи, отданные родителем, и состояние ожидания
 * списка загрузок. В SSR эффекты не выполняются, поэтому страница «Скачанные»
 * рисует строку ожидания — это и фиксируем.
 */
function render(node: React.ReactElement): string {
  return renderToString(React.createElement(I18nProvider, { lang: "ru" }, node));
}

describe("VideoPlayer — свой плеер", () => {
  it("рисует полный набор кнопок: перемотка, ±10 с, звук, настройки, PiP, экран", () => {
    const html = render(
      React.createElement(VideoPlayer, { src: "/api/movies/torrent/stream/aaa/0" }),
    );
    expect(html).toContain("mv-vp-video");
    expect(html).toContain("mv-vp-seek");
    expect(html).toContain("mv-vp-vol");
    expect(html).toContain('title="Назад 10 секунд"');
    expect(html).toContain('title="Вперёд 10 секунд"');
    expect(html).toContain('title="Звук (M)"');
    expect(html).toContain('title="Громкость"');
    expect(html).toContain('title="Настройки плеера"');
    expect(html).toContain('title="Картинка в картинке"');
    expect(html).toContain('title="Во весь экран (F)"');
  });

  it("показывает прогресс раздачи, кнопки родителя и дорожку субтитров", () => {
    const html = render(
      React.createElement(VideoPlayer, {
        src: "/s/0",
        badge: "Качается: 42% · 1.5 MB/s",
        subtitles: {
          src: "/api/movies/torrent/subtitles/aaa/0?track=0",
          label: "Русские",
          lang: "ru",
        },
        actions: React.createElement("button", { id: "mv-stop" }, "Стоп"),
      }),
    );
    expect(html).toContain("Качается: 42% · 1.5 MB/s");
    expect(html).toContain('id="mv-stop"'); // кнопка «Стоп»/«Удалить» от родителя
    expect(html).toContain('kind="subtitles"');
    expect(html).toContain('src="/api/movies/torrent/subtitles/aaa/0?track=0"');
  });

  it("без субтитров кнопки субтитров нет (не показываем пустой орган управления)", () => {
    const html = render(React.createElement(VideoPlayer, { src: "/s/0" }));
    expect(html).not.toContain("<track");
  });

  /**
   * Субтитры живут в настройках плеера (шестерёнка), а не под ним: раньше селект
   * был снаружи (в полном экране до него не добраться), а кнопка импорта своего
   * .srt только мешала. Проверяем и разметку, и структуру исходника.
   */
  it("селект субтитров рисуется только внутри панели настроек", () => {
    const html = render(
      React.createElement(VideoPlayer, {
        src: "/s/0",
        subtitleOptions: [
          { value: "", label: "Выключены" },
          { value: "t0", label: "Russian (Full)" },
        ],
      }),
    );
    // Панель настроек закрыта — значит дорожек под плеером нет (раньше были).
    expect(html).not.toContain("mv-vp-opts");
    expect(html).not.toContain("Russian (Full)");
    expect(html).toContain('title="Настройки плеера"');
  });

  it("кнопки импорта субтитров (.srt/.vtt) в плеере больше нет", () => {
    const html = render(
      React.createElement(VideoPlayer, {
        src: "/s/0",
        subtitles: { src: "/subs.vtt", label: "Русские", lang: "ru" },
        subtitleOptions: [{ value: "t0", label: "Russian (Full)" }],
      }),
    );
    expect(html).not.toContain('type="file"');
    // Своя дорожка по-прежнему играет: <track> с серверным WebVTT на месте.
    expect(html).toContain('kind="subtitles"');
  });
});

/**
 * Структурный страж плеера: селект дорожек субтитров обязан быть в блоке
 * настроек. SSR этого не показывает (панель закрыта до клика), поэтому читаем
 * исходник — как tests/srcLayout.test.ts для раскладки.
 */
describe("VideoPlayer — субтитры внутри настроек (структура исходника)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src/pages/movies/parts/VideoPlayer.tsx"),
    "utf8",
  );

  it("селект дорожек субтитров объявлен внутри панели mv-vp-opts", () => {
    const block = src.slice(src.indexOf("mv-vp-opts"), src.indexOf("mv-vp-title"));
    expect(block).toContain("options={subtitleOptions}");
    expect(block).toContain("onSubtitleChange");
    expect(block).toContain("player.speed"); // скорость там же — панель одна
  });

  it("в плеере нет загрузки своих субтитров (импорт .srt/.vtt удалён)", () => {
    expect(src).not.toContain('accept=".srt');
    expect(src).not.toContain("createObjectURL");
  });

  it("шкала идёт на всю длину фильма, перемотка применяется на отпускании", () => {
    // Длительность берём из пропа ffprobe, а не из mediaDuration живого потока.
    expect(src).toContain("const totalKnown = filmSec");
    expect(src).toContain("duration?: number | null");
    expect(src).toContain("max={Math.max(1, Math.round(totalKnown || 1))}");
    // Светлая полоса = докуда можно перематывать.
    expect(src).toContain('"--mv-vp-buf"');
    expect(src).toContain("seekableAbs");
    // Поток не пересоздаём на каждое движение ползунка: только на отпускании.
    expect(src).toContain("commitScrub");
    expect(src).toContain("onPointerUp={commitScrub}");
    expect(src).toContain("clampSeek(");
    // Размер блока считает fitBoxFor (режимы вписывания), сам fitVideoBox — внутри.
    expect(src).toContain("fitBoxFor(");
  });

  /**
   * Кнопка «растянуть»: режимы вписывания кадра и зум с панорамированием.
   * Проверяем и разметку (кнопка + панель), и то, что режимы берутся из lib
   * (список FIT_MODES), а не дублируются строками в компоненте.
   */
  it("есть кнопка вписывания кадра, режимы берутся из FIT_MODES, есть зум", () => {
    const html = render(React.createElement(VideoPlayer, { src: "/s/0" }));
    expect(html).toContain('title="Вписывание кадра и зум"');
    expect(html).toContain("mv-vp fit-fit");
    expect(src).toContain("FIT_MODES.map");
    expect(src).toContain("fitModeLabelKey(m)");
    expect(src).toContain("ZOOM_STEPS.map");
    expect(src).toContain('t("movies.playerZoomCustom")');
    expect(src).toContain('t("movies.playerZoomReset")');
    // Зум и панорама — через CSS-переменные, кадр тянется мышью.
    expect(src).toContain('"--mv-vp-zoom"');
    expect(src).toContain('"--mv-vp-pan-x"');
    expect(src).toContain("onPointerDown={onPanStart}");
    expect(src).toContain("clampPan(");
  });

  /**
   * Режимы «растянуть (искажение)» и «умное растяжение» убраны: они искажали
   * картинку, а «умный» ещё и требовал SVG-фильтра (feDisplacementMap) с картой
   * сдвига — на 4K это заметно грузило CPU. Проверяем, что от них не осталось
   * следов ни в компоненте, ни в разметке, ни в стилях.
   */
  it("режимов искажения и умного растяжения в плеере больше нет", () => {
    expect(src).not.toContain("smartStretchMap");
    expect(src).not.toContain("feDisplacementMap");
    expect(src).not.toContain("mv-vp-smartdefs");
    expect(src).not.toContain("fitSmartHint");
    expect(src).not.toContain('"stretch"');
    const css = fs.readFileSync(path.join(process.cwd(), "src/styles/movies.css"), "utf8");
    expect(css).not.toContain(".mv-vp.fit-stretch");
    expect(css).not.toContain(".mv-vp.fit-smart");
    expect(css).not.toContain(".mv-vp-smartdefs");
    // Оставшиеся четыре режима в стилях есть — разметка и CSS не разъехались.
    for (const m of ["fit-fit", "fit-cover", "fit-width", "fit-height"]) {
      expect(css).toContain(`.mv-vp.${m}`);
    }
  });
});

describe("DownloadsView — вкладка «Скачанные»", () => {
  it("до загрузки списка показывает ожидание, а не пустой экран", () => {
    const html = render(React.createElement(DownloadsView, { onPlay: () => {} }));
    expect(html).toContain("mv-downloads");
    expect(html).toContain("Читаю список загрузок");
  });
});

/**
 * Окно плеера (PlayerModal): что из него убрано и что появилось.
 *
 * Разметку целиком в SSR не проверить (окно рисуется порталом и требует
 * активной страницы), поэтому читаем исходник — как tests/srcLayout.test.ts.
 * Проверяем именно то, о чём просил пользователь: нет кнопки импорта субтитров,
 * нет подсказок-заглушек и нет текста, который раньше выводился как разметка.
 */
describe("PlayerModal — состав окна плеера (структура исходника)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src/pages/movies/parts/PlayerModal.tsx"),
    "utf8",
  );

  it("кнопки импорта субтитров (.srt/.vtt) больше нет", () => {
    expect(src).not.toContain('accept=".srt');
    expect(src).not.toContain("createObjectURL");
    expect(src).not.toContain("loadSubs");
  });

  it("надписи-заглушки убраны: про аудиодорожки и про права на контент", () => {
    expect(src).not.toContain("audioInPlayer");
    expect(src).not.toContain("torrentNotice");
  });

  it("плеер получает план воспроизведения и лестницу фолбэков", () => {
    // Субтитры — в настройках плеера, режим потока — из lib/playback.
    expect(src).toContain("subtitleOptions");
    expect(src).toContain("playbackMode(plan, retryLevel, audioChanged)");
    expect(src).toContain("streamUrlFor(");
    expect(src).toContain("onError={onStreamError}");
  });

  /**
   * Шкала на всю длину фильма и светлая полоса «докуда скачано» — прямая просьба
   * пользователя. Без duration из ffprobe живой поток ffmpeg сообщает браузеру
   * Infinity, шкала схлопывается, и перемотка уводит фильм в начало.
   */
  it("шкала получает длину фильма из ffprobe и границу перемотки из скачанного", () => {
    expect(src).toContain("duration={tracks?.durationSec || null}");
    expect(src).toContain("seekableSec");
    expect(src).toContain("seekableSeconds({");
    expect(src).toContain("onSeekBlocked={onSeekBlocked}");
    // Граница считается по скачанной доле ФАЙЛА раздачи, а не торрента целиком.
    expect(src).toContain("status?.files?.find((f) => f.index === fileIndex)?.progress");
  });
});

describe("bytes — подписи размеров и времени", () => {
  it("форматирует байты, скорость и остаток загрузки", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(null)).toBe("0 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(1024 ** 3 * 5)).toBe("5.0 GB");
    expect(fmtSpeed(2048)).toBe("2.0 KB/s");
    expect(fmtEta(0)).toBe("—");
    expect(fmtEta(45)).toBe("45 с");
    expect(fmtEta(600)).toBe("10 мин");
    expect(fmtEta(7200)).toBe("2 ч 0 мин");
  });
});

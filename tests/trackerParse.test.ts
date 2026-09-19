import { describe, it, expect } from "vitest";
import { decodeBytes, encodeCp1251 } from "../server/charset";
import {
  findSid,
  hasLoginForm,
  isCloudflareChallenge,
  looksAuthorized,
  looksLikeNoResults,
  pageSnippet,
  parseHiddenInputs,
  parseReleaseMeta,
  parseReleasesByEngine,
  parseReleasesTable,
  parseRutorRows,
  releaseAudio,
  releaseGroup,
  sizeToBytes,
} from "../server/trackerParse";

/**
 * Разбор страниц форума-трекера (rutracker.org).
 *
 * Разметку не выдумываем: строки результатов у rutracker приходят cp1251-страницей
 * с таблицей `#tor-tbl`, строками `trs-tr-<id>` и ячейками seedmed/leechmed.
 * Поэтому одна из проверок прогоняет фикстуру через реальные байты cp1251 —
 * так тест ловит и ошибки парсера, и ошибки кодировки.
 */
const RU_SEARCH_HTML = `<html><head><meta charset="windows-1251"></head><body>
<table class="forumline tablesorter" id="tor-tbl">
<thead><tr><th>Название</th><th>Раздел</th><th>Размер</th><th>Сиды</th><th>Личи</th></tr></thead>
<tbody>
<tr class="tCenter" id="trs-tr-6062312">
  <td class="tor-title row4 med tLeft">
    <a class="med bold tt-text" href="viewtopic.php?t=6062312">Матрица / The Matrix (1999) [BDRip 1080p x265 HEVC] Дубляж MVO</a>
    <a class="magnet-link" href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=Matrix"><b>M</b></a>
    <a href="dl.php?t=6062312">Скачать .torrent</a>
  </td>
  <td class="row4 f-name-col"><a href="tracker.php?f=123">Зарубежное кино</a></td>
  <td class="row4 tCenter">1.37 GB</td>
  <td class="row4 seedmed"><b>42</b></td>
  <td class="row4 leechmed">7</td>
</tr>
<tr class="tCenter" id="trs-tr-6062313">
  <td class="tor-title row4 med tLeft">
    <a class="med bold tt-text" href="viewtopic.php?t=6062313">Матрица (1999) [4K 2160p HDR10] Авторский (AVO)</a>
  </td>
  <td class="row4 f-name-col"><a href="tracker.php?f=123">Зарубежное кино</a></td>
  <td class="row4 tCenter">28.4 GB</td>
  <td class="row4 seedmed"><b>5</b></td>
  <td class="row4 leechmed">1</td>
</tr>
</tbody></table>
</body></html>`;

describe("trackerParse — таблица результатов", () => {
  it("разбирает страницу rutracker: id, название, размер, сиды/личи, magnet", () => {
    const rows = parseReleasesTable(RU_SEARCH_HTML);
    expect(rows.map((r) => r.id)).toEqual(["6062312", "6062313"]);

    const first = rows[0];
    expect(first.title).toContain("Матрица");
    expect(first.title).toContain("[BDRip 1080p x265 HEVC]");
    expect(first.sizeText).toBe("1.37 GB");
    expect(first.sizeBytes).toBe(Math.round(1.37 * 1024 ** 3));
    expect(first.seeders).toBe(42);
    expect(first.leechers).toBe(7);
    expect(first.torrentId).toBe("6062312");
    // &amp; в href разворачивается в &, иначе magnet нерабочий.
    expect(first.magnet).toBe(
      "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Matrix",
    );

    const second = rows[1];
    expect(second.sizeText).toBe("28.4 GB");
    expect(second.seeders).toBe(5);
    expect(second.magnet).toBeNull();
    expect(second.torrentId).toBeNull();
  });

  it("страница в cp1251-байтах (как её отдаёт форум) разбирается так же", () => {
    const bytes = encodeCp1251(RU_SEARCH_HTML); // форум отдаёт cp1251
    const rows = parseReleasesTable(decodeBytes(bytes, "windows-1251")); // читаем мы
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toContain("Матрица");
    expect(rows[0].seeders).toBe(42);
  });

  it("таблица без классов: сиды/личи берутся из чисел после размера", () => {
    const html = `<table><tbody>
      <tr><td><a href="/viewtopic.php?t=777">Раздача без классов</a></td><td>700 MB</td><td>10</td><td>3</td><td>1</td></tr>
    </tbody></table>`;
    const rows = parseReleasesTable(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "777", seeders: 10, leechers: 3, downloads: 1 });
  });

  it("служебные строки (без ссылки на тему) не попадают в выдачу", () => {
    const html = `<table><tr><th>Название</th><th>Размер</th></tr>
      <tr><td colspan="2">Ничего не найдено</td></tr></table>`;
    expect(parseReleasesTable(html)).toEqual([]);
  });

  it("дубликаты строк по одному id схлопываются", () => {
    const row =
      '<tr id="trs-tr-5"><td><a href="viewtopic.php?t=5">Тема</a></td><td>1 GB</td><td>1</td><td>0</td></tr>';
    expect(parseReleasesTable(`<table>${row}${row}</table>`)).toHaveLength(1);
  });
});

describe("trackerParse — метаданные из названия", () => {
  it("разрешение, кодек, аудио, группа и источник", () => {
    const meta = parseReleaseMeta(
      "Сериал (2020) [WEB-DL 2160p HDR10 x265] Дубляж / MVO / Авторский [GROUP]",
    );
    expect(meta.resolution).toBe("4K");
    expect(meta.codec).toBe("x265 (HEVC)");
    expect(meta.audio).toEqual(["Дубляж", "MVO", "Авторский"]);
    expect(meta.releaseGroup).toBe("GROUP");
    expect(meta.source).toBe("WEB-DL");
    expect(meta.hdr).toBe("HDR10");
    expect(meta.year).toBe(2020);
  });

  it("1080p/x264/BDRip", () => {
    const meta = parseReleaseMeta("Фильм (2011) BDRip 1080p x264");
    expect(meta.resolution).toBe("1080p");
    expect(meta.codec).toBe("x264");
    expect(meta.source).toBe("BDRip");
    expect(meta.year).toBe(2011);
  });

  it("технические токены не считаются релиз-группой", () => {
    expect(releaseGroup("Фильм 1080p x264 HEVC")).toBeNull();
    expect(releaseGroup("Фильм [1080p]")).toBeNull();
    expect(releaseGroup("Фильм [Lossless]")).toBe("Lossless");
    expect(releaseGroup("Фильм - RG")).toBe("RG");
  });

  it("сезон и серия распознаются и в SxxExx, и словами", () => {
    expect(parseReleaseMeta("Сериал S02E05 1080p")).toMatchObject({ season: 2, episode: 5 });
    expect(parseReleaseMeta("Сериал 3 сезон, серия 12")).toMatchObject({ season: 3, episode: 12 });
  });

  it("аудио-метки приводятся к каноническим названиям", () => {
    expect(releaseAudio("Дубляж + многоголосый закадровый")).toEqual(["Дубляж", "MVO"]);
    expect(releaseAudio("Лицензия (полное дублирование)")).toContain("Дубляж");
    expect(releaseAudio("Original English")).toEqual(["Оригинал"]);
    expect(releaseAudio("без пометок")).toEqual([]);
  });

  it("пустое/мусорное название не падает", () => {
    const meta = parseReleaseMeta(null);
    expect(meta).toMatchObject({ resolution: null, codec: null, year: null, season: null });
    expect(meta.audio).toEqual([]);
  });
});

describe("trackerParse — вспомогательные функции", () => {
  it("sizeToBytes понимает GB/ГБ/MB и запятую", () => {
    expect(sizeToBytes("1.37 GB")).toBe(Math.round(1.37 * 1024 ** 3));
    expect(sizeToBytes("750 МБ")).toBe(Math.round(750 * 1024 ** 2));
    expect(sizeToBytes("4,7 ГБ")).toBe(Math.round(4.7 * 1024 ** 3));
    expect(sizeToBytes("512 KB")).toBe(512 * 1024);
    expect(sizeToBytes("—")).toBe(0);
  });

  it("скрытые поля формы входа и sid переносятся в POST", () => {
    const html = `<form action="login.php"><input type="hidden" name="creation_time" value="1700000000">
      <input type="hidden" name="form_token" value="abc123">
      <input type="text" name="login_username"></form>`;
    expect(parseHiddenInputs(html)).toEqual({ creation_time: "1700000000", form_token: "abc123" });
    expect(findSid('href="tracker.php?sid=9f8c7b6a5d"')).toBe("9f8c7b6a5d");
    expect(findSid('<input type="hidden" name="sid" value="deadbeef">')).toBe("deadbeef");
    expect(findSid("нет сессии")).toBeNull();
  });

  it("форма входа распознаётся, а ссылка «Выход» — нет", () => {
    expect(hasLoginForm('<form action="login.php"><input name="login_username"></form>')).toBe(
      true,
    );
    expect(hasLoginForm('<a href="login.php?logout=1">Выход [user]</a>')).toBe(false);
  });

  it("«ничего не найдено» отличается от «разметка не та»", () => {
    expect(looksLikeNoResults("Результатов поиска: 0")).toBe(true);
    expect(looksLikeNoResults("Ничего не найдено")).toBe(true);
    // Реальная формулировка rutracker.
    expect(looksLikeNoResults("По вашему запросу ничего не найдено")).toBe(true);
    expect(looksLikeNoResults("<table><tr><td>мусор</td></tr></table>")).toBe(false);
  });

  it("страница-проверка Cloudflare распознаётся (это не «выдача» и не «вошли»)", () => {
    const cf403 = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
      <meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body><div id="cf-wrapper">Checking your browser before accessing rutracker.org</div></body></html>`;
    expect(isCloudflareChallenge(cf403, 403)).toBe(true);
    expect(isCloudflareChallenge(cf403, 200)).toBe(true); // CF бывает и со 200
    expect(isCloudflareChallenge("cf-mitigated: challenge", 403)).toBe(true);

    // Обычная страница форума — не челлендж, даже если в тексте есть слова о ботах.
    const forum = `<html><body><table id="tor-tbl"><tr id="trs-tr-1"><td><a href="viewtopic.php?t=1">Тема</a></td></tr></table></body></html>`;
    expect(isCloudflareChallenge(forum, 200)).toBe(false);
    expect(hasLoginForm(forum)).toBe(false);
  });

  it("признаки авторизации и «выжимка» страницы для диагностики", () => {
    expect(looksAuthorized('<a href="login.php?logout=1">Выход [user]</a>')).toBe(true);
    expect(looksAuthorized('<a href="login.php">Вход</a>')).toBe(false);
    expect(pageSnippet("<html><body><b>Привет</b> мир</body></html>")).toBe("Привет мир");
    expect(pageSnippet("<p>" + "x".repeat(500) + "</p>", 50)).toHaveLength(50);
  });
/**
 * Разбор выдачи rutor.info.
 *
 * Разметка — снимок живой страницы /search/0/0/000/0/matrix: строки `tr.gai`
 * (чередуются с `tr.tum`), ссылка на .torrent уходит на ДРУГОЙ хост
 * (//d.rutor.info/download/<id>), сиды/личи лежат в span.green/span.red, а у строк
 * с комментариями появляется лишняя ячейка перед размером. Всё это — реальные
 * случаи, на которых парсер легко «съезжает» на соседние ячейки.
 */
const RUTOR_SEARCH_HTML = `<html><head><meta charset="utf-8"></head><body>
<table id="news_table"><tr><td class="news_title"><a href="/torrent/472">Новый Адрес: RUTOR.INFO</a></td></tr></table>
<div id="index"><b>Страницы:  1 <a href="/search/1/0/000/0/matrix">2</a></b> Результатов поиска 226 (max. 2000)
<table width="100%">
<tr class="backgr"><td width="10px">Добавлен</td><td colspan="2">Название</td><td width="1px">Размер</td><td width="1px">Пиры</td></tr>
<tr class="gai"><td>06&nbsp;Сен&nbsp;26</td><td colspan = "2"><a class="downgif" href="//d.rutor.info/download/1105259"><img src="//cdnbunny.org/i/d.gif" alt="D" /></a><a href="magnet:?xt=urn:btih:06555d165746e815b0ab5b16de37ed24f9142595&amp;dn=rutor.info&amp;tr=udp://opentor.net:6969"><img src="//cdnbunny.org/i/m.png" alt="M" /></a>
<a href="/torrent/1105259/bad-matrix-dangerous-game-2026-mp3">Bad Matrix - Dangerous Game (2026) MP3 </a></td>
<td align="right">82.73&nbsp;MB</td><td align="center"><span class="green"><img src="//cdnbunny.org/t/arrowup.gif" alt="S" />&nbsp;3</span>&nbsp;<img src="//cdnbunny.org/t/arrowdown.gif" alt="L" /><span class="red">&nbsp;0</span></td></tr>
<tr class="tum"><td>09&nbsp;Июл&nbsp;26</td><td ><a class="downgif" href="//d.rutor.info/download/1098254"><img src="//cdnbunny.org/i/d.gif" alt="D" /></a><a href="magnet:?xt=urn:btih:f99edb3d16451a80283463eda2a9e8ea1fccacc9&amp;dn=rutor.info"><img src="//cdnbunny.org/i/m.png" alt="M" /></a>
<a href="/torrent/1098254/matrica-kvadrologija_1999-2021_uhd-bdremux-2160p-4k-hdr-dolby-vision">Матрица. Квадрология (1999-2021) UHD BDRemux 2160p | 4K | HDR | Dolby Vision </a></td> <td align="right">5<img src="//cdnbunny.org/i/com.gif" alt="C" /></td>
<td align="right">265.94&nbsp;GB</td><td align="center"><span class="green"><img src="//cdnbunny.org/t/arrowup.gif" alt="S" />&nbsp;3</span>&nbsp;<img src="//cdnbunny.org/t/arrowdown.gif" alt="L" /><span class="red">&nbsp;10</span></td></tr>
<tr class="gai"><td>16&nbsp;Май&nbsp;26</td><td ><a class="downgif" href="//d.rutor.info/download/1085666"><img src="//cdnbunny.org/i/d.gif" alt="D" /></a>
<a href="/torrent/1085666/matrica-voskreshenie_the-matrix-resurrections-2021-web-dl-1080p">Матрица: Воскрешение / The Matrix Resurrections (2021) WEB-DL 1080p | D | Локализованная версия </a></td> <td align="right">1<img src="//cdnbunny.org/i/com.gif" alt="C" /></td>
<td align="right">8.28&nbsp;GB</td><td align="center"><span class="green"><img src="//cdnbunny.org/t/arrowup.gif" alt="S" />&nbsp;1&nbsp;234</span>&nbsp;<img src="//cdnbunny.org/t/arrowdown.gif" alt="L" /><span class="red">&nbsp;7</span></td></tr>
</table></div>
</body></html>`;


describe("trackerParse — выдача rutor.info", () => {
  it("разбирает строки gai/tum: id, название, размер, сиды/личи, magnet и .torrent", () => {
    const rows = parseRutorRows(RUTOR_SEARCH_HTML);
    // Строка заголовка (backgr) и таблица новостей раздачами не считаются.
    expect(rows.map((r) => r.id)).toEqual(["1105259", "1098254", "1085666"]);

    const first = rows[0];
    expect(first.title).toBe("Bad Matrix - Dangerous Game (2026) MP3");
    expect(first.sizeText).toBe("82.73 MB");
    expect(first.sizeBytes).toBe(sizeToBytes("82.73 MB"));
    expect(first.seeders).toBe(3);
    expect(first.leechers).toBe(0);
    // .torrent лежит на поддомене: id берём из ссылки, URL соберёт скрапер.
    expect(first.torrentId).toBe("1105259");
    // `&amp;` в href — это `&`: без раскодирования magnet нерабочий.
    expect(first.magnet).toBe(
      "magnet:?xt=urn:btih:06555d165746e815b0ab5b16de37ed24f9142595&dn=rutor.info&tr=udp://opentor.net:6969",
    );
  });

  it("не съезжает на соседние ячейки из-за комментариев и «1 234» сидов", () => {
    const rows = parseRutorRows(RUTOR_SEARCH_HTML);
    const second = rows[1]; // строка с ячейкой «5 комментариев» перед размером
    expect(second.sizeText).toBe("265.94 GB");
    expect(second.leechers).toBe(10);
    const third = rows[2]; // 1 234 сида с неразрывным пробелом
    expect(third.seeders).toBe(1234);
    expect(third.sizeText).toBe("8.28 GB");
  });

  it("метаданные названия разбираются так же, как у rutracker", () => {
    const rows = parseRutorRows(RUTOR_SEARCH_HTML);
    const meta = parseReleaseMeta(rows[1].title);
    expect(meta.resolution).toBe("4K");
    // Из «HDR | Dolby Vision» парсер выбирает более конкретный вариант.
    expect(meta.hdr).toBe("Dolby Vision");
    expect(meta.source).toBe("BDRemux");
  });

  it("пустая выдача и мусор → пустой массив", () => {
    expect(parseRutorRows("")).toEqual([]);
    expect(
      parseRutorRows(
        '<div id="index">Результатов поиска 0 (max. 2000)<table><tr class="backgr"><td>x</td></tr></table></div>',
      ),
    ).toEqual([]);
  });

  it("parseReleasesByEngine выбирает парсер по движку (неизвестный = rutracker)", () => {
    expect(parseReleasesByEngine(RUTOR_SEARCH_HTML, "rutor").map((r) => r.id)).toEqual([
      "1105259",
      "1098254",
      "1085666",
    ]);
    // Страница rutor движком rutracker не разбирается: там нет trs-tr-<id>/t=<id>.
    expect(parseReleasesByEngine(RUTOR_SEARCH_HTML, "rutracker")).toEqual([]);
    expect(parseReleasesByEngine(RU_SEARCH_HTML, undefined).map((r) => r.id)).toEqual([
      "6062312",
      "6062313",
    ]);
    expect(parseReleasesByEngine(RU_SEARCH_HTML, "rutor")).toEqual([]);
  });
});

});

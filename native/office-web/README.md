# Веб-сборки WordCraft, GridCraft и DeckCraft в MoonApp

Страницы «Документы» и «Таблицы» открывают готовые приложения WordCraft и GridCraft: это их веб-версии
(`apps/*-web`, Rust → wasm, интерфейс на egui) в `<iframe>`, по рамке на каждый документ. Собранные файлы
(~40 МБ) лежат в `public/office/<word|sheet>/` и в git не хранятся.

```
npm run office:word     # собрать и положить в public/office/word (нужны rustup и trunk)
npm run office:sheet    # то же для GridCraft → public/office/sheet
npm run office:deck     # DeckCraft («Презентации») → public/office/deck
```

Скрипт `scripts/buildOfficeWeb.mjs` клонирует исходники в `C:\wcb\<имя>` на ревизию, с которой собрано
ядро (`native/wordcore/Cargo.toml`, `native/gridcore/Cargo.toml`), накладывает патч из этой папки и запускает `trunk build --release`.
Патч добавляет только мост со страницей, поведение редактора он не меняет.

## Что делает патч

- `?embed` в адресе включает режим встраивания: Сохранить и экспорт не скачиваются браузером, а уходят
  странице (`download`); проверка «несохранённые изменения» при закрытии отключена, это дело страницы.
- `?lang=ru&theme=dark` — язык и тема интерфейса на старте (дальше страница меняет их командами: Word — `ui.language` и
  `ui.theme`, Таблицы — `app.language.set` и `view.theme`).
- `src/web/bridge.rs` (у GridCraft `src/embed.rs`) + JS-обвязка в `index.html`: запросы страницы выполняются между кадрами.

## Протокол (`postMessage`, у каждого сообщения `wc: 1`, адрес — `location.origin`)

Страница → рамка: `{wc, id, op, params}`, ответ `{wc, id, ok, result | error, bytes?}`.

| op       | params                         | ответ                                                   |
|----------|--------------------------------|---------------------------------------------------------|
| `run`    | `{command, params}`            | результат любой команды ядра или `ui.*` (в том числе `document.inspect`, `text.insert`) |
| `state`  | —                              | Word: выделение, страницы, слова, `dirty`, `rev`; Таблицы: книга (`doc.dirty`, `doc.revision`), листы, активный лист, выделение `sel.a1` |
| `export` | `{name}`                       | `bytes` — файл: Word по расширению имени (`.docx`), Таблицы всегда `.xlsx` |
| `clean`  | —                              | снять отметку «есть несохранённые изменения»            |
| `open`   | `name`, `bytes` (ArrayBuffer)  | открыть файл (рамка должна быть пустой, иначе спросит про сохранение) |

Рамка → страница (событие `evt`): `ready` (мост готов), `state` (поле `state` — JSON, шлётся при смене
ревизии, отметки об изменениях или выделения), `download` (`name`, `bytes` — Сохранить или экспорт).

Скрытые документы нельзя прятать через `display: none`: рамка перестаёт рисовать кадры и не отвечает.
Страница использует `visibility: hidden`.

## DeckCraft («Презентации»)

Тот же мост (`src/embed.rs`), патч `deckcraft-web.patch`. Отличия: тема — `view.dark {on}`, язык — `ui.language {language: "ru"|"en"}`
(на старте `?lang=ru`); `export` отдаёт формат по расширению имени (`pptx`, `pdf`, `deckcraft`);
`state` — `doc`, `slides`, `sel {slide, shapes}`. Патч заодно чинит дефект самого
DeckCraft: `std::process::id()` в wasm паникует (`crates/engine/src/recovery.rs`), без этого любая презентация не открывается.

Русский интерфейс: у DeckCraft он только английский, поэтому текст подменяется перед раскладкой. Второй патч
`deckcraft-epaint.patch` правит крейт `epaint` (скрипт копирует его из реестра cargo в `C:\wcb\deck-epaint`, а `Cargo.toml` патча
подключает копию через `[patch.crates-io]`): `Fonts::layout_job` вызывает хук `set_translator`. Хук ставит
`crates/ui-egui/src/i18n.rs`, каталог — `ru.tsv` (`English<TAB>Русский`, `{}` — подстановка для строк из `format!`, `{1}`, `{2}` —
порядок слов). Переводится только точное совпадение целого текста, поэтому текст слайдов (его рисует свой рендер) не
затрагивается; подписи ленты, которые режутся на строки до рисования, переводятся в `widgets::big_button_ex`.
Чего каталог не знает, показывает команда `ui.i18n.missing` (мост: `run`) — по ней дополняют `ru.tsv`.

## PdfCraft (страница «PDF»)

`scripts/buildOfficeWeb.mjs pdf` (`npm run office:pdf`) собирает `apps/pdfcraft-web` на ревизии `8555d6f`. У апстрима
уже есть русский интерфейс (`ui-egui/src/i18n/ru.tsv`) и мост `?host=parent`, но мы говорим на общем протоколе `wc`,
чтобы работал тот же `OfficeWeb`. Патч `pdfcraft-web.patch`: `src/embed.rs` (операции `run`, `state`, `export`, `open`,
`clean`), хук `PdfCraftApp::embed_tick` (вызывается каждый кадр) и подключение в `main.rs` по `?embed`. Команды `run`
идут в канал управления приложением (`ui.command`, `ui.set`, `ui.state`, `ui.click`, `ui.inspect`…), тема и язык —
`ui.set {key: "theme"|"language"}`. Сохранение уходит странице событием `download`.

## PhotoCraft (страница «Фоторедактор»)

`npm run office:photo` собирает `apps/photocraft-web` на ревизии `ce2a1e3` (wasm около 26 МБ, нужен WebGPU или WebGL2).
Русский интерфейс уже в ядре (`ui-egui/src/i18n/ru.tsv`). Патч `photocraft-web.patch`: `src/embed.rs` (операции `run`, `state`,
`export`, `open`, `clean`) и подключение по `?embed` в `web.rs`: оболочка `WebShell` обслуживает мост каждый кадр, сервис записи
отдаёт сохранение странице событием `download`, файлы со страницы идут в тот же `inbox`, что и перетащенные. Команды `run` идут в
канал управления приложением (`engine.execute {command, params}`, `ui.set`, `ui.inspect`, `engine.commands`); язык меняется
настройкой `interface.language` (`prefs.set`), тема — `ui.set {theme: "pro"|"proLightGray"}`. Родной формат — `.pcraft` (слои),
экспорт в PNG, JPEG и т. д. выбирается расширением имени.

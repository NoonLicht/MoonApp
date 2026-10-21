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

Тот же мост (`src/embed.rs`), патч `deckcraft-web.patch`. Отличия: язык интерфейса у редактора один (английский, `?lang`
и `ui.language` нет); тема — `view.dark {on}`; `export` отдаёт формат по расширению имени (`pptx`, `pdf`, `deckcraft`);
`state` — `doc`, `slides`, `sel {slide, shapes}`. Помощника для слайдов пока нет. Патч заодно чинит дефект самого
DeckCraft: `std::process::id()` в wasm паникует (`crates/engine/src/recovery.rs`), без этого любая презентация не открывается.

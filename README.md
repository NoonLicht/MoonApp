<div align="center">

# MoonApp

**Персональная панель утилит для Windows** — медиа, документы, обход блокировок, мониторинг железа,
книги, ИИ и многое другое в одном desktop-приложении. Всё считается локально.

[![Release](https://img.shields.io/github/v/release/NoonLicht/MoonApp?label=release&color=7c6cf0)](https://github.com/NoonLicht/MoonApp/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/NoonLicht/MoonApp/total?color=2dd4bf)](https://github.com/NoonLicht/MoonApp/releases)
[![License](https://img.shields.io/badge/license-MIT-informational)](#лицензия)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows)](#установка)

[Скачать](https://github.com/NoonLicht/MoonApp/releases/latest) · [Возможности](#возможности) · [Из исходников](#запуск-из-исходников) · [Данные](#данные-и-безопасность)

</div>

---

## Возможности

| Раздел | Что внутри |
|---|---|
| 🎬 **Медиа** | Конвертер и сжатие (локальный FFmpeg, x264/x265/AV1, NVENC), загрузчик и музыка (yt-dlp), апскейл и интерполяция кадров (ONNX, до TensorRT), фильмы и сериалы (TMDB, торрент-плеер), книги (OPDS) |
| 📝 **Документы** | Word, Таблицы, Презентации, PDF и Фоторедактор — веб-сборки редакторов (Rust → wasm) с автосохранением и мостом к ИИ-помощнику |
| 🎨 **Творчество** | Дизайн (FigCraft), Звук (SoundCraft), Эффекты (EffectCraft), Видеоредактор (FilmCraft), Проявка фото (LightCraft), Черчение (CadCraft) — веб-сборки [storytold](https://github.com/storytold), язык интерфейса берётся из приложения |
| 🤖 **ИИ** | Чат через Ollama, лекционный диктофон (Whisper + конспект), озвучка (XTTS, F5-TTS), локальный переводчик, ИИ-сводка RSS |
| 🌐 **Сеть** | Обход блокировок (Zapret, sing-box, kill-switch), сетевые утилиты, веб-архив сайтов (.sitebak), веб-компаньон для телефона |
| 🌡️ **Система** | Монитор железа и диска, тюнинг ПК, автоматизация (лаунчеры, расписание), скриншоты и запись экрана, установщик приложений (winget) |
| 🗂️ **Личное** | Моё пространство (заметки, канвас, M3E), задачи, дневник, бюджет (CSV/OFX), RSS, почта, игры, менеджер паролей, инструменты разработчика |

Плюс: 5 тем, 6 акцентных цветов, 6 языков интерфейса, плавные анимации окна и адаптивный интерфейс.

## Установка

1. Скачайте `MoonApp-Setup-x.y.z.exe` со страницы [Releases](https://github.com/NoonLicht/MoonApp/releases/latest) и запустите — права администратора не нужны.
2. Данные лежат в папке `storage\` рядом с программой и переживают обновления и удаление.
3. Приложение само проверяет обновления.

> Сборка не подписана, SmartScreen может предупредить: «Подробнее» → «Выполнить в любом случае».

## Запуск из исходников

Нужен **Node.js ≥ 20**.

```bash
git clone https://github.com/NoonLicht/MoonApp.git && cd MoonApp
npm install
npm run rebuild:electron   # better-sqlite3 под Electron
npm start                  # сборка фронта и запуск
```

| Скрипт | Назначение |
|---|---|
| `npm run dev` | Vite dev-сервер (`:5173`, API на `:4000`) |
| `npm run compile` | TS → JS для `server/ts`, `electron/ts`, `scripts/ts` |
| `npm run typecheck` · `check:i18n` · `test` | Типы, полнота переводов, Vitest |
| `npm run office:<имя>` | Веб-сборка редактора: `word sheet deck pdf photo sound fig effect film light cad` (нужны Rust, trunk или `cargo xtask`, `wasm-bindgen-cli`; см. `native/office-web/README.md`) |
| `npm run dist` | NSIS-установщик в `release/` (перед ним соберите нужные `office:*`, затем `build:web`) |

Код — TypeScript: сервер в `server/ts/`, Electron в `electron/ts/`, фронт в `src/`. Стек: Electron · React 18 · Vite · Express · SQLite · ONNX Runtime · Vitest.

## Данные и безопасность

- Данные — в `storage\` (SQLite `data.db` в режиме WAL, дневник — файлы `ГГГГ-ММ-ДД.md`). Миграции — `server/ts/db.ts`.
- Локальный API слушает только `127.0.0.1` и требует сессионный токен; окно работает в песочнице Chromium с жёстким CSP (wasm разрешён только для компиляции), процессы запускаются без shell, секреты шифруются через safeStorage (DPAPI).
- **Веб-компаньон** — отдельный сервер, выключен по умолчанию: только частные сети, проверка `Host`, вход по одноразовому 6-значному коду, токены хранятся хэшами, файлы до 200 МБ без исполняемых типов, пароли и настройки недоступны.

## Подпись и CI

Подпись кода включается секретами репозитория: Azure Trusted Signing (`AZURE_*`) или `.pfx` (`WIN_CSC_FILE`, `WIN_CSC_KEY_PASSWORD`). `ci.yml` проверяет каждый push, `release.yml` на тег `v*` публикует установщик.

## Лицензия

[MIT](https://opensource.org/licenses/MIT)
